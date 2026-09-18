const assert = require("node:assert/strict");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { Pool } = require("pg");
const { before, after, test } = require("node:test");
const { startTestDatabase } = require("./postgres-helper.cjs");
const { migrateDatabase } = require("../scripts/db-migrate.cjs");
const { getDatabaseUrl, getStorageBinding, definiteCommitFailure, safeErrorMessage } = require("../scripts/postgres-tools.cjs");

let fixture;
let teardownStarted = false;

before(async () => {
  const started = await startTestDatabase({ storageMode: "drive", storageRoot: "fixture-try-drive-root" });
  if (teardownStarted) {
    await started.close();
    return;
  }
  fixture = started;
}, { timeout: 120_000 });

after(async () => {
  teardownStarted = true;
  if (fixture) await fixture.close();
});

async function emptyDatabase(name) {
  await fixture.pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(fixture.url);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5_000, max: 2 });
  return {
    url: url.href,
    pool,
    async close() {
      await pool.end();
      await fixture.pool.query(`DROP DATABASE ${name}`);
    },
  };
}

test("versioned schema creation is explicit and idempotent without creating dummy records", async () => {
  const empty = await emptyDatabase("schema_creation");
  try {
    const created = await migrateDatabase({ url: empty.url, binding: fixture.binding });
    assert.equal(created.created, true);
    for (const table of ["drivers", "loads", "files", "sync_runs"]) {
      assert.equal((await empty.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    await empty.pool.query("INSERT INTO drivers(name) VALUES ('Preserved on rerun')");
    const repeated = await migrateDatabase({ url: empty.url, binding: fixture.binding });
    assert.equal(repeated.created, false);
    assert.equal((await empty.pool.query("SELECT count(*)::int AS n FROM drivers")).rows[0].n, 1);
    const metadata = (await empty.pool.query("SELECT * FROM dispatch_meta")).rows[0];
    assert.deepEqual(metadata, { singleton: true, schema_version: 1, storage_mode: "drive", storage_root: fixture.binding.root });
    await assert.rejects(empty.pool.query("INSERT INTO dispatch_meta VALUES (FALSE,1,'drive','another')"), { code: "23514" });
  } finally {
    await empty.close();
  }
});

test("schema migration refuses unknown tables instead of adopting or overwriting them", async () => {
  const empty = await emptyDatabase("unknown_schema");
  try {
    await empty.pool.query("CREATE TABLE drivers (id integer PRIMARY KEY, custom_value text); INSERT INTO drivers VALUES (9,'keep')");
    await assert.rejects(migrateDatabase({ url: empty.url, binding: fixture.binding }), /unversioned DispatchBoard tables/);
    assert.deepEqual((await empty.pool.query("SELECT * FROM drivers")).rows, [{ id: 9, custom_value: "keep" }]);
    assert.equal((await empty.pool.query("SELECT to_regclass('public.dispatch_meta') AS name")).rows[0].name, null);
  } finally {
    await empty.close();
  }
});

test("schema migration refuses mismatched Drive roots without modifying the original binding", async () => {
  await assert.rejects(migrateDatabase({
    url: fixture.url,
    binding: { mode: "drive", root: "different-root" },
  }), /different storage mode\/root/);
  assert.deepEqual((await fixture.pool.query("SELECT storage_mode, storage_root FROM dispatch_meta")).rows[0], {
    storage_mode: fixture.binding.mode,
    storage_root: fixture.binding.root,
  });
});

test("schema CLI selects the direct connection and never prints credentials", async () => {
  const environment = {
    ...process.env,
    DATABASE_URL_UNPOOLED: fixture.url,
    POSTGRES_URL_NON_POOLING: "postgresql://unused@127.0.0.1:1/unused",
    DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused",
    STORAGE_MODE: "drive",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: fixture.binding.root,
  };
  const script = path.resolve(__dirname, "..", "scripts", "db-migrate.cjs");
  const result = await promisify(execFile)(process.execPath, [script], {
    cwd: fixture.directory, env: environment, timeout: 20_000,
  });
  assert.match(result.stdout, /already initialized/);
  assert.ok(!result.stdout.includes(fixture.url));
  assert.ok(!result.stderr.includes(fixture.url));
});

test("migration connection precedence and canonical storage binding match runtime configuration", () => {
  const values = ["postgresql://test@localhost/unpooled", "postgresql://test@localhost/nonpool", "postgresql://test@localhost/database", "postgresql://test@localhost/postgres"];
  const environment = Object.fromEntries(["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DATABASE_URL", "POSTGRES_URL"].map((key, index) => [key, values[index]]));
  for (const key of Object.keys(environment)) {
    assert.equal(getDatabaseUrl(environment), environment[key]);
    delete environment[key];
  }
  assert.throws(() => getDatabaseUrl(environment), /Set DATABASE_URL_UNPOOLED/);
  assert.throws(() => getDatabaseUrl({ DATABASE_URL: "https://example.invalid/database" }), /PostgreSQL URL/);
  assert.deepEqual(getStorageBinding({ STORAGE_MODE: "drive", GOOGLE_DRIVE_ROOT_FOLDER_ID: "  try-root  " }), { mode: "drive", root: "try-root" });
  const root = path.resolve(fixture.directory, "storage");
  assert.deepEqual(getStorageBinding({ STORAGE_MODE: "local" }, fixture.directory), {
    mode: "local", root: process.platform === "win32" ? root.toLowerCase() : root,
  });
  assert.equal(definiteCommitFailure({ code: "23514", severity: "ERROR" }), true);
  assert.equal(definiteCommitFailure({ code: "P0001", severity: "ERROR" }), true);
  assert.equal(definiteCommitFailure({ code: "23514", severity: "ERREUR" }), true);
  for (const code of ["ECONNRESET", "ECONNABORTED", "EPIPE", "EPERM"]) {
    assert.equal(definiteCommitFailure({ code }), false);
  }
  for (const code of ["57P01", "40003", "08007"]) {
    assert.equal(definiteCommitFailure({ code, severity: "ERROR" }), false);
  }
  assert.equal(safeErrorMessage(new Error(`Invalid connection ${values[0]}`)), "Invalid connection [redacted PostgreSQL URL]");
});
