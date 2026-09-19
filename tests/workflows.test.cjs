require("./register.cjs");
const assert = require("node:assert/strict");
const { test, before, after, afterEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { startTestDatabase } = require("./postgres-helper.cjs");

const originalCwd = process.cwd();
const environment = new Map([
  "DATABASE_URL", "POSTGRES_URL", "STORAGE_MODE", "VERCEL", "GOOGLE_DRIVE_ROOT_FOLDER_ID",
  "GOOGLE_DRIVE_READ_ONLY", "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN",
].map((key) => [key, process.env[key]]));
let workspace;
let postgres;
let db;
let DriveStorage, getStorage, loadFolderName, sanitizeName, withDataLock, todayLocal, overdueLabel;
let routes;

before(async () => {
  workspace = path.resolve(fs.mkdtempSync(".dispatch-workflows-"));
  process.chdir(workspace);
  for (const key of environment.keys()) delete process.env[key];
  process.env.STORAGE_MODE = "local";
  fs.mkdirSync("data");
  fs.writeFileSync(path.join("data", "private-fixture.txt"), "untouched local data");
  postgres = await startTestDatabase({ storageRoot: path.join(workspace, "storage") });
  process.env.DATABASE_URL = postgres.url;
  db = require("../lib/db.ts").default;
  ({ DriveStorage, getStorage, loadFolderName, sanitizeName } = require("../lib/storage.ts"));
  ({ withDataLock } = require("../lib/mutation-lock.ts"));
  ({ todayLocal, overdueLabel } = require("../lib/dates.ts"));
  routes = {
    drivers: require("../app/api/drivers/route.ts"),
    driver: require("../app/api/drivers/[id]/route.ts"),
    loads: require("../app/api/loads/route.ts"),
    load: require("../app/api/loads/[id]/route.ts"),
    archive: require("../app/api/loads/[id]/archive/route.ts"),
    upload: require("../app/api/loads/[id]/files/route.ts"),
    file: require("../app/api/files/[id]/route.ts"),
    sync: require("../app/api/sync/route.ts"),
  };
  await db.query("SELECT 1");
});

async function call(route, method, { id = 1, body, query = "", drainSync = true, headers = {} } = {}) {
  const result = await callOnce(route, method, { id, body, query, headers });
  if (route !== "sync" || method !== "POST" || !drainSync) return result;
  let current = result;
  for (let batch = 0; current.status === 200 && current.data.cursor !== null; batch++) {
    assert.equal(typeof current.data.cursor, "string", "Sync must return a continuation cursor or null");
    assert.ok(batch < 100, "Sync did not finish after 100 batches");
    current = await callOnce(route, method, { body: { cursor: current.data.cursor } });
  }
  return current;
}

async function callOnce(route, method, { id = 1, body, query = "", headers = {} } = {}) {
  const options = { method, headers };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { ...headers, "Content-Type": "application/json" };
  }
  const response = await routes[route][method](new Request("http://localhost/api?" + query, options), { params: { id: String(id) } });
  const content = await response.text();
  return {
    status: response.status,
    data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(content) : content,
  };
}

async function rejectLoadChanges(event, message, deferred = false) {
  assert.ok(["INSERT", "UPDATE"].includes(event));
  const name = event === "INSERT" ? "reject_load" : "reject_edit";
  await db.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '%', '${message.replaceAll("'", "''")}';
      END;
    $$;
    CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER ${name}
      ${deferred ? "AFTER" : "BEFORE"} ${event} ON loads
      ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}
      FOR EACH ROW EXECUTE FUNCTION ${name}();
  `);
}

async function rejectFileInsert({ optional = false, deferred = false } = {}) {
  await db.query(`
    CREATE FUNCTION reject_file() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${optional ? "NEW.category = 'bol'" : "TRUE"} THEN
          RAISE EXCEPTION 'forced file metadata failure';
        END IF;
        RETURN NEW;
      END;
    $$;
    CREATE ${deferred ? "CONSTRAINT " : ""}TRIGGER reject_file
      ${deferred ? "AFTER" : "BEFORE"} INSERT ON files
      ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}
      FOR EACH ROW EXECUTE FUNCTION reject_file();
  `);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Operation waited for an unrelated mutation")), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function finishHeldMutation(mutation, release, pending) {
  release.resolve();
  const [result] = await Promise.allSettled([mutation, ...pending]);
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function callFromFreshProcess(route, method, { id = 1, body } = {}) {
  const child = spawnSync(process.execPath, [
    "-e",
    `
      require(process.argv[1]);
      const db = require(process.argv[2]).default;
      (async () => {
        try {
          const route = require(process.argv[3]);
          const { method, id, body } = JSON.parse(process.argv[4]);
          const response = await route[method](new Request("http://localhost/api", {
            method, headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }), { params: { id: String(id) } });
          console.log(JSON.stringify({ status: response.status, data: await response.json() }));
        } finally { await db.close(); }
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `,
    path.join(__dirname, "register.cjs"),
    path.join(__dirname, "..", "lib", "db.ts"),
    route,
    JSON.stringify({ method, id, body }),
  ], { cwd: workspace, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
}

async function driver(name = "Test Driver") {
  const result = await call("drivers", "POST", { body: { name } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.id;
}

function form(driverId, number = "100", type = "load") {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    driver_id: String(driverId), load_number: number, load_type: type,
    pickup_city: "Austin", delivery_city: "Boston", pickup_date: "2026-09-01",
    delivery_date: "2026-09-02", rate_amount: "1200", status: "scheduled",
  })) result.set(key, value);
  result.set("rate_confirmation", new File(["rate content"], "rate.txt"));
  return result;
}

async function load(driverId, number = "100", type = "load") {
  const result = await call("loads", "POST", { body: form(driverId, number, type) });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const detail = await call("load", "GET", { id: result.data.load.id });
  return detail.data;
}

function manualLoad(driverName, folders) {
  const folder = path.join(workspace, "storage", driverName, ...folders);
  const file = path.join(folder, "RateConfirmation_747690_1430702 (1).pdf");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, "manual rate content");
  return { folder, file };
}

afterEach(async () => {
  if (!db) return;
  await db.query(`
    DROP TRIGGER IF EXISTS reject_load ON loads;
    DROP TRIGGER IF EXISTS reject_edit ON loads;
    DROP TRIGGER IF EXISTS reject_file ON files;
    DROP FUNCTION IF EXISTS reject_load();
    DROP FUNCTION IF EXISTS reject_edit();
    DROP FUNCTION IF EXISTS reject_file();
    DELETE FROM sync_runs;
    DELETE FROM files;
    DELETE FROM loads;
    DELETE FROM drivers;
  `);
  const storage = path.join(workspace, "storage");
  if (fs.existsSync(storage)) {
    for (const entry of fs.readdirSync(storage)) fs.rmSync(path.join(storage, entry), { recursive: true });
  }
  assert.equal(fs.readFileSync(path.join(workspace, "data", "private-fixture.txt"), "utf8"), "untouched local data");
});

after(async () => {
  try {
    if (db) await db.close();
  } finally {
    process.chdir(originalCwd);
    try {
      if (postgres) await postgres.close();
    } finally {
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (workspace) {
        assert.equal(path.dirname(workspace), originalCwd);
        assert.ok(path.basename(workspace).startsWith(".dispatch-workflows-"));
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  }
});

test("PostgreSQL preserves numeric identifiers and amounts, text dates, and nullable archive fields", async () => {
  assert.match((await db.one("SELECT version() AS version")).version, /^PostgreSQL /);
  const item = await load(await driver(), "SCHEMA");
  const row = await db.one("SELECT * FROM loads WHERE id = $1", [item.id]);
  assert.equal(row.id, item.id);
  assert.equal(typeof row.id, "number");
  assert.equal(typeof row.driver_id, "number");
  assert.equal(row.load_number, "SCHEMA");
  assert.equal(row.rate_amount, 1200);
  assert.equal(typeof row.rate_amount, "number");
  assert.equal(row.pickup_date, "2026-09-01");
  assert.equal(typeof row.created_at, "string");
  assert.equal(row.archived_at, null);
  assert.equal(row.invoice_due_date, "");
  assert.equal(typeof item.files[0].id, "number");
  assert.equal(typeof item.files[0].storage_ref, "string");
});

test("load identifiers respect the PostgreSQL integer boundary before querying", async () => {
  for (const id of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await call("load", "GET", { id })).status, 400, String(id));
  }
  assert.equal((await call("load", "GET", { id: 2_147_483_647 })).status, 404);
});

test("booking saves required paperwork before committing the complete load", async () => {
  const item = await load(await driver());
  assert.equal(item.files.length, 1);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
  assert.equal(item.files[0].filename, "rate.txt");
  assert.equal(item.archived_at, null);
  assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
});

test("required upload failure removes the new load folder and leaves no record", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  t.mock.method(getStorage(), "saveFile", async () => { throw new Error("Required upload failed"); });
  const result = await call("loads", "POST", { body: form(id) });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /Required upload failed/);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #100")), false);
});

test("database failure after uploading rolls back files and the load folder", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  await rejectLoadChanges("INSERT", "forced database failure");
  const result = await call("loads", "POST", { body: form(id) });
  assert.equal(result.status, 500);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #100")), false);
});

test("PostgreSQL COMMIT failure compensates uploaded paperwork and the new load folder", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  await rejectLoadChanges("INSERT", "forced commit failure", true);
  const result = await call("loads", "POST", { body: form(id) });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /forced commit failure/);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #100")), false);
});

test("optional upload failures are explicit and do not discard the required document", async (t) => {
  const id = await driver();
  const storage = getStorage();
  const save = storage.saveFile.bind(storage);
  t.mock.method(storage, "saveFile", async (folder, name, ...args) => {
    if (name === "bol.txt") throw new Error("BOL failed");
    return save(folder, name, ...args);
  });
  const body = form(id);
  body.set("bol", new File(["BOL"], "bol.txt"));
  const result = await call("loads", "POST", { body });
  assert.equal(result.status, 201);
  assert.equal(result.data.uploadErrors.length, 1);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 1);
});

test("optional document metadata failure atomically rolls back the booking and all uploaded paperwork", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  await rejectFileInsert({ optional: true });
  const body = form(id);
  body.set("bol", new File(["BOL"], "bol.txt"));
  const result = await call("loads", "POST", { body });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /forced file metadata failure/);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 0);
  assert.equal((await db.one("SELECT id FROM drivers")).id, id);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #100")), false);
});

test("document upload COMMIT failure removes only the new file and preserves existing paperwork", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  await rejectFileInsert({ deferred: true });
  const body = new FormData();
  body.set("file", new File(["new document"], "new.txt"));
  const result = await call("upload", "POST", { id: item.id, body });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /forced file metadata failure/);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
  assert.equal(fs.existsSync(path.join(item.folder_ref, "new.txt")), false);
});

test("invalid booking fields and missing required files make no changes", async () => {
  const id = await driver();
  for (const [key, value] of [
    ["rate_amount", "-1"], ["rate_amount", "Infinity"], ["rate_amount", "0"], ["rate_amount", " "],
    ["rate_amount", "1.234"], ["pickup_date", "2026-02-30"], ["delivery_date", "2026-08-01"],
    ["invoice_due_date", "2026-13-01"], ["load_type", "bad"], ["driver_id", "1.5"],
  ]) {
    const body = form(id);
    body.set(key, value);
    assert.equal((await call("loads", "POST", { body })).status, 400, key + "=" + value);
  }
  const body = form(id);
  body.delete("rate_confirmation");
  assert.equal((await call("loads", "POST", { body })).status, 400);
  assert.equal((await call("loads", "POST", { body: {} })).status, 400);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
});

test("booking enforces the 4000000-byte file total independently of UTF-8 fields", async () => {
  const id = await driver();
  const oversized = form(id, "OVERSIZED");
  oversized.set("rate_confirmation", new File([Buffer.alloc(2_000_000)], "rate.pdf"));
  oversized.set("bol", new File([Buffer.alloc(2_000_001)], "bol.pdf"));
  const rejected = await call("loads", "POST", { body: oversized });
  assert.equal(rejected.status, 413);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #OVERSIZED")), false);
  const boundary = form(id, "BOUNDARY");
  boundary.set("pickup_city", "Montréal 🚚");
  boundary.set("rate_confirmation", new File([Buffer.alloc(4_000_000)], "rate.pdf"));
  const accepted = await call("loads", "POST", { body: boundary });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  const detail = await call("load", "GET", { id: accepted.data.load.id });
  assert.equal(fs.statSync(detail.data.files[0].storage_ref).size, 4_000_000);
  assert.equal(detail.data.pickup_city, "Montréal 🚚");
});

test("document uploads accept the file-byte boundary and reject an extra byte without side effects", async () => {
  const item = await load(await driver());
  assert.equal((await call("upload", "POST", { id: item.id, body: {} })).status, 400);
  const body = new FormData();
  body.set("file", new File([Buffer.alloc(4_000_001)], "too-large.pdf"));
  const rejected = await call("upload", "POST", { id: item.id, body });
  assert.equal(rejected.status, 413);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.existsSync(path.join(item.folder_ref, "too-large.pdf")), false);
  body.set("file", new File([Buffer.alloc(4_000_000)], "boundary.pdf"));
  const accepted = await call("upload", "POST", { id: item.id, body });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  assert.equal(fs.statSync(path.join(item.folder_ref, "boundary.pdf")).size, 4_000_000);
  body.set("category", "invoice");
  const invoiceBytes = 4_000_000;
  body.set("file", new File([Buffer.alloc(invoiceBytes + 1)], "invoice.pdf"));
  assert.equal((await call("upload", "POST", { id: item.id, body })).status, 413);
  assert.equal(fs.existsSync(path.join(item.folder_ref, "invoice.pdf")), false);
  body.set("file", new File([Buffer.alloc(invoiceBytes)], "invoice.pdf"));
  const invoice = await call("upload", "POST", { id: item.id, body });
  assert.equal(invoice.status, 201, JSON.stringify(invoice.data));
  assert.equal(fs.statSync(path.join(item.folder_ref, "invoice.pdf")).size, invoiceBytes);
});

test("encoded multipart requests above 4250000 bytes are rejected even without Content-Length", async () => {
  const id = await driver();
  const item = await load(id);
  for (const declared of [false, true]) {
    const booking = form(id, "ENCODED");
    const document = new FormData();
    document.set("file", new File(["small document"], "extra.txt"));
    const headers = declared ? { "Content-Length": "4250001" } : {};
    if (!declared) {
      booking.set("notes", "x".repeat(4_250_001));
      document.set("padding", "x".repeat(4_250_001));
    }
    assert.equal((await call("loads", "POST", { body: booking, headers })).status, 413, `booking, declared=${declared}`);
    assert.equal((await call("upload", "POST", { id: item.id, body: document, headers })).status, 413, `upload, declared=${declared}`);
    assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
    assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 1);
    assert.equal(fs.existsSync(path.join(item.folder_ref, "extra.txt")), false);
    assert.equal(fs.existsSync(path.join(path.dirname(item.folder_ref), "Load #ENCODED")), false);
  }
});

test("edits validate all fields before changing any load details", async () => {
  const item = await load(await driver());
  for (const changes of [
    { pickup_city: "Changed", status: "paid", rate_amount: -1 },
    { notes: "Changed", delivery_date: "2026-08-01" },
    { invoice_due_date: "2026-02-30", rate_amount: 50 },
    { driver_id: null, notes: "Changed" },
  ]) {
    assert.equal((await call("load", "PATCH", { id: item.id, body: changes })).status, 400);
    assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  }
  for (const body of [null, [], "not an object"]) {
    assert.equal((await call("load", "PATCH", { id: item.id, body })).status, 400);
  }
});

test("concurrent duplicate bookings create only one load and folder", async () => {
  const id = await driver();
  const results = await Promise.all([
    call("loads", "POST", { body: form(id) }),
    call("loads", "POST", { body: form(id) }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 1);
});

test("booking locks normalized load numbers while unrelated bookings continue", async (t) => {
  const id = await driver();
  const independentId = await driver("Independent Driver");
  const storage = getStorage();
  const save = storage.saveFile.bind(storage);
  const entered = deferred();
  const release = deferred();
  const pending = [];
  t.mock.method(storage, "saveFile", async (folder, ...args) => {
    if (path.basename(folder) === "Load #AB_CD") {
      entered.resolve();
      await release.promise;
    }
    return save(folder, ...args);
  });
  const booking = call("loads", "POST", { body: form(id, "AB/CD") });
  booking.then((result) => {
    if (result.status !== 201) entered.reject(new Error(JSON.stringify(result)));
  }, entered.reject);
  const run = (promise) => { pending.push(promise); return promptly(promise); };
  try {
    await promptly(entered.promise);
    const conflicting = await run(call("loads", "POST", { body: form(independentId, "ab\\cd") }));
    assert.equal(conflicting.status, 409);
    const independent = await run(call("loads", "POST", { body: form(independentId, "OTHER") }));
    assert.equal(independent.status, 201, JSON.stringify(independent.data));
    const listed = await run(call("loads", "GET"));
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.map((item) => item.load_number), ["OTHER"]);
  } finally {
    assert.equal((await finishHeldMutation(booking, release, pending)).status, 201);
  }
  assert.deepEqual((await call("loads", "GET")).data.map((item) => item.load_number).sort(), ["AB/CD", "OTHER"]);
  assert.equal(fs.readFileSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #AB_CD", "rate.txt"), "utf8"), "rate content");
});

test("archive and restore rename both load types and keep every document reachable", async () => {
  const id = await driver();
  for (const type of ["load", "loadout"]) {
    const item = await load(id, "100", type);
    const archived = await call("archive", "POST", { id: item.id, body: { archived: true } });
    assert.equal(archived.status, 200);
    assert.ok(archived.data.archived_at);
    assert.equal(path.basename(archived.data.folder_ref), loadFolderName("100", type, true));
    assert.equal(fs.existsSync(item.folder_ref), false);
    assert.equal(archived.data.files[0].filename, "rate.txt");
    assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
    assert.equal((await call("load", "PATCH", { id: item.id, body: { notes: "blocked" } })).status, 409);
    assert.equal((await call("loads", "POST", { body: form(id, "100", type) })).status, 409);
    const restored = await call("archive", "POST", { id: item.id, body: { archived: false } });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.archived_at, null);
    assert.equal(restored.data.folder_ref, item.folder_ref);
    assert.equal(fs.existsSync(item.folder_ref), true);
  }
});

test("folder conflicts block archive without overwriting or losing original records", async () => {
  const item = await load(await driver());
  const target = path.join(path.dirname(item.folder_ref), "Archived - Load #100");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "keep");
  assert.equal((await call("archive", "POST", { id: item.id, body: { archived: true } })).status, 409);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "keep");
});

test("local downloads report a busy load during folder moves rather than incorrectly reporting missing documents", async (t) => {
  const item = await load(await driver());
  const storage = getStorage();
  const original = storage.moveLoadFolder;
  const moved = deferred();
  const release = deferred();
  t.mock.method(storage, "moveLoadFolder", async (...args) => {
    const result = await original.apply(storage, args);
    moved.resolve();
    await release.promise;
    return result;
  });
  const archiving = call("archive", "POST", { id: item.id, body: { archived: true } });
  let result;
  try {
    await promptly(moved.promise);
    assert.equal((await promptly(call("file", "GET", { id: item.files[0].id }))).status, 409);
    assert.equal((await promptly(call("loads", "GET"))).status, 200);
  } finally {
    result = await finishHeldMutation(archiving, release, []);
  }
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const downloaded = await call("file", "GET", { id: item.files[0].id });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.data, "rate content");
});

test("database edit failure rolls back physical archive and document paths", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  await rejectLoadChanges("UPDATE", "forced edit failure");
  assert.equal((await call("archive", "POST", { id: item.id, body: { archived: true } })).status, 500);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
  assert.equal(fs.existsSync(path.join(path.dirname(item.folder_ref), "Archived - Load #100")), false);
});

test("PostgreSQL COMMIT failure restores the original folder and file references after archiving", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  await rejectLoadChanges("UPDATE", "forced archive commit failure", true);
  const result = await call("archive", "POST", { id: item.id, body: { archived: true } });
  assert.equal(result.status, 500);
  assert.match(result.data.error, /forced archive commit failure/);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
  assert.equal(fs.existsSync(path.join(path.dirname(item.folder_ref), "Archived - Load #100")), false);
});

test("driver reassignment moves paperwork without changing IDs or losing trip details", async () => {
  const first = await driver("First");
  const second = await driver("Second");
  const item = await load(first);
  const result = await call("load", "PATCH", { id: item.id, body: { driver_id: second, notes: "Reassigned" } });
  assert.equal(result.status, 200);
  assert.equal(result.data.driver_name, "Second");
  assert.equal(result.data.id, item.id);
  assert.equal(result.data.rate_amount, item.rate_amount);
  assert.equal(result.data.notes, "Reassigned");
  assert.equal(fs.existsSync(item.folder_ref), false);
  assert.equal(result.data.folder_ref, path.join(workspace, "storage", "Second", "Loads", "Load #100"));
  assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
});

test("reassignment refuses an existing archived destination without moving any files", async () => {
  const first = await driver("First");
  const second = await driver("Second");
  const item = await load(first);
  fs.mkdirSync(path.join(workspace, "storage", "Second", "Loads", "Archived - Load #100"), { recursive: true });
  const result = await call("load", "PATCH", { id: item.id, body: { driver_id: second } });
  assert.equal(result.status, 409);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
});

test("driver rename updates archived folders and refuses normalized-name collisions", async () => {
  const id = await driver("Original");
  const item = await load(id);
  await call("archive", "POST", { id: item.id, body: { archived: true } });
  assert.equal((await call("driver", "PATCH", { id, body: { name: "Renamed" } })).status, 200);
  const result = await call("load", "GET", { id: item.id });
  assert.equal(result.data.folder_ref, path.join(workspace, "storage", "Renamed", "Loads", "Archived - Load #100"));
  assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
  assert.equal((await call("drivers", "POST", { body: { name: "renamed" } })).status, 409);
  await driver("A/B");
  assert.equal((await call("drivers", "POST", { body: { name: "A\\B" } })).status, 409);
  for (const name of ["..", ".", "CON", "NUL.txt"]) assert.throws(() => sanitizeName(name));
});

test("deferred database deletion failures are checked before destroying a document", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  await db.query(`
    CREATE FUNCTION reject_file() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced deferred document deletion failure'; END;
    $$;
    CREATE CONSTRAINT TRIGGER reject_file AFTER DELETE ON files
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_file();
  `);
  const failed = await call("file", "DELETE", { id: item.files[0].id });
  assert.equal(failed.status, 500);
  assert.match(failed.data.error, /forced deferred document deletion failure/);
  assert.equal((await call("load", "GET", { id: item.id })).data.files.length, 1);
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
});

test("failed physical deletion keeps metadata and archived files are read-only", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  const storage = getStorage();
  const mocked = t.mock.method(storage, "deleteFile", async () => { throw new Error("File is locked"); });
  const failed = await call("file", "DELETE", { id: item.files[0].id });
  assert.equal(failed.status, 500);
  assert.match(failed.data.error, /File is locked/);
  assert.equal((await call("load", "GET", { id: item.id })).data.files.length, 1);
  mocked.mock.restore();
  await call("archive", "POST", { id: item.id, body: { archived: true } });
  assert.equal((await call("file", "DELETE", { id: item.files[0].id })).status, 409);
  const body = new FormData();
  body.set("file", new File(["extra"], "extra.txt"));
  assert.equal((await call("upload", "POST", { id: item.id, body })).status, 409);
});

test("sync accepts zero-byte serverless request streams and explicit empty JSON objects", async () => {
  const document = manualLoad("Empty Request Driver", ["Load #EMPTY-REQUEST"]);
  const requests = [
    new Request("http://localhost/api/sync", { method: "POST" }),
    new Request("http://localhost/api/sync", {
      method: "POST", duplex: "half",
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    }),
    new Request("http://localhost/api/sync", {
      method: "POST", duplex: "half", headers: { "Content-Length": "0", "Content-Type": "application/json" },
      body: new ReadableStream({ start(controller) { controller.close(); } }),
    }),
    new Request("http://localhost/api/sync", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }),
  ];
  assert.equal(requests[0].body, null);
  assert.ok(requests[1].body, "Vercel can expose an empty request as a non-null stream");
  for (const request of requests) {
    const response = await routes.sync.POST(request);
    const summary = await response.json();
    assert.equal(response.status, 200, JSON.stringify(summary));
    assert.ok(summary.cursor === null || typeof summary.cursor === "string");
    const complete = summary.cursor === null ? { status: 200, data: summary }
      : await call("sync", "POST", { body: { cursor: summary.cursor } });
    assert.equal(complete.status, 200, JSON.stringify(complete.data));
    assert.equal(complete.data.cursor, null);
    assert.deepEqual(complete.data.errors, []);
  }
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM sync_runs")).n, requests.length);
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM loads")).n, 1);
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM files")).n, 1);
  assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
});

test("sync rejects malformed JSON and invalid cursors without starting a run", async (t) => {
  const scan = t.mock.method(getStorage(), "listDriverFolders", async () => assert.fail("Invalid sync input must not scan storage"));
  for (const body of ["{", " ", "null", "[]", '"text"', '{"cursor":', '{"cursor":null}', '{"cursor":""}', '{"cursor":12}', '{"cursor":"invalid"}']) {
    const response = await routes.sync.POST(new Request("http://localhost/api/sync", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "0" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /Invalid JSON body|A JSON object is required|Invalid sync cursor/);
  }
  assert.equal(scan.mock.callCount(), 0);
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM sync_runs")).n, 0);
});

test("other JSON endpoints still reject an empty request stream", async () => {
  const response = await routes.drivers.POST(new Request("http://localhost/api/drivers", {
    method: "POST", duplex: "half", headers: { "Content-Type": "application/json" },
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON body" });
  assert.equal((await db.one("SELECT COUNT(*)::int AS n FROM drivers")).n, 0);
});

test("sync refuses another driver's matching load folder and ignores archived records", async () => {
  const first = await driver("First");
  await driver("Second");
  const item = await load(first);
  const conflict = path.join(workspace, "storage", "Second", "Loads", "Load #100");
  fs.mkdirSync(conflict, { recursive: true });
  fs.writeFileSync(path.join(conflict, "invoice.txt"), "another driver");
  let sync = await call("sync", "POST");
  assert.equal(sync.status, 200);
  assert.equal(sync.data.errors.length, 1);
  assert.equal((await call("load", "GET", { id: item.id })).data.files.length, 1);
  await call("load", "DELETE", { id: item.id });
  sync = await call("sync", "POST");
  assert.equal(sync.data.loadsImported, 0);
  assert.equal(sync.data.filesImported, 0);
  assert.equal((await call("loads", "GET")).data.length, 0);
  assert.equal((await call("loads", "GET", { query: "archived=archived" })).data.length, 1);
  assert.equal((await call("driver", "DELETE", { id: first })).status, 409);
});

test("sync recognizes sanitized load folder names without duplicating the load", async () => {
  const item = await load(await driver(), "100/200");
  assert.equal(path.basename(item.folder_ref), "Load #100_200");
  const result = await call("sync", "POST");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.errors, []);
  assert.equal(result.data.loadsImported, 0);
  assert.equal(result.data.filesImported, 0);
  assert.equal((await call("loads", "GET")).data.length, 1);
});

test("sync persists cumulative batches that resume from a fresh server process", async () => {
  const documents = [];
  for (let index = 0; index < 16; index++) {
    for (let number = 0; number < 3; number++) {
      documents.push(manualLoad(`Batch Driver ${index}`, [`Load #BATCH-${index}-${number}`]));
    }
  }
  const first = await call("sync", "POST", { drainSync: false });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(typeof first.data.cursor, "string");
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM sync_runs")).n, 1);
  const resumed = callFromFreshProcess(path.join(__dirname, "..", "app", "api", "sync", "route.ts"), "POST", {
    body: { cursor: first.data.cursor },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  for (const key of ["driversScanned", "driversImported", "loadsImported", "filesImported"]) {
    assert.ok(resumed.data[key] >= first.data[key], `${key} must be cumulative`);
  }
  const complete = resumed.data.cursor === null
    ? resumed
    : await call("sync", "POST", { body: { cursor: resumed.data.cursor } });
  assert.equal(complete.status, 200, JSON.stringify(complete.data));
  assert.deepEqual(complete.data, {
    driversScanned: 16, driversImported: 16, loadsImported: 48, loadsArchived: 0, filesImported: 48,
    skippedExisting: 0, skippedArchived: 0, errors: [], cursor: null,
  });
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 48);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 48);
  const retried = await call("sync", "POST", { body: { cursor: first.data.cursor }, drainSync: false });
  assert.deepEqual(retried, complete, "Retrying a completed cursor must return its persisted final summary");
  const repeated = await call("sync", "POST");
  assert.equal(repeated.data.loadsImported, 0);
  assert.equal(repeated.data.filesImported, 0);
  assert.equal(repeated.data.skippedExisting, 48);
  assert.deepEqual(repeated.data.errors, []);
  for (const document of documents) assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
});

test("sync discovers drivers and both load layouts without moving documents or duplicating records", async () => {
  const documents = [
    { ...manualLoad("Williams", ["Load #999999"]), number: "999999", type: "load" },
    { ...manualLoad("New Driver", ["Loads", "Load #100"]), number: "100", type: "load" },
    { ...manualLoad("Williams", ["Loadout #200"]), number: "200", type: "loadout" },
    { ...manualLoad("New Driver", ["Loadout", "Loadout #300"]), number: "300", type: "loadout" },
  ];
  const ignored = [
    manualLoad("Williams", ["Archived - Load #600"]),
    manualLoad("Williams", ["Archived - Loadout #601"]),
    manualLoad("New Driver", ["Loads", "Archived - Load #700"]),
    manualLoad("New Driver", ["Loadout", "Archived - Loadout #701"]),
  ];
  fs.writeFileSync(path.join(workspace, "storage", "Williams", "unassigned-rate.pdf"), "unassigned");
  const sync = await call("sync", "POST");
  assert.equal(sync.status, 200);
  assert.deepEqual(sync.data, {
    driversScanned: 2, driversImported: 2, loadsImported: 4, loadsArchived: 0, filesImported: 4,
    skippedExisting: 0, skippedArchived: 0, errors: [], cursor: null,
  });
  const drivers = await db.all("SELECT * FROM drivers ORDER BY id");
  assert.deepEqual(drivers.map((item) => item.name).sort(), ["New Driver", "Williams"]);
  for (const item of drivers) {
    assert.equal(item.phone, "");
    assert.equal(item.truck, "");
  }
  for (const document of documents) {
    const item = await db.one("SELECT * FROM loads WHERE load_number = $1 AND load_type = $2", [document.number, document.type]);
    assert.equal(item.folder_ref, document.folder);
    assert.equal(item.status, "scheduled");
    assert.equal(item.pickup_city, "");
    assert.equal(item.rate_amount, 0);
    const detail = (await call("load", "GET", { id: item.id })).data;
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].storage_ref, document.file);
    assert.equal(detail.files[0].category, "rate_confirmation");
    assert.equal((await call("file", "GET", { id: detail.files[0].id })).data, "manual rate content");
  }
  const loads = await db.all("SELECT * FROM loads ORDER BY id");
  const files = await db.all("SELECT * FROM files ORDER BY id");
  const repeated = await call("sync", "POST");
  assert.deepEqual(repeated.data, {
    driversScanned: 2, driversImported: 0, loadsImported: 0, loadsArchived: 0, filesImported: 0,
    skippedExisting: 4, skippedArchived: 0, errors: [], cursor: null,
  });
  assert.deepEqual(await db.all("SELECT * FROM drivers ORDER BY id"), drivers);
  assert.deepEqual(await db.all("SELECT * FROM loads ORDER BY id"), loads);
  assert.deepEqual(await db.all("SELECT * FROM files ORDER BY id"), files);
  for (const document of [...documents, ...ignored]) {
    assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
  }
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Williams", "Loads")), false);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Williams", "Loadout")), false);
  const bol = path.join(documents[0].folder, "BOL.pdf");
  fs.writeFileSync(bol, "manual BOL");
  const additional = await call("sync", "POST");
  assert.equal(additional.data.driversImported, 0);
  assert.equal(additional.data.loadsImported, 0);
  assert.equal(additional.data.filesImported, 1);
  assert.deepEqual(additional.data.errors, []);
  assert.equal((await db.one("SELECT category FROM files WHERE storage_ref = $1", [bol])).category, "bol");
});

test("sync reuses the registered driver behind a sanitized folder name", async () => {
  const id = await driver("A/B");
  const document = manualLoad("A_B", ["Load #100"]);
  const result = await call("sync", "POST");
  assert.equal(result.data.driversImported, 0);
  assert.equal(result.data.loadsImported, 1);
  assert.deepEqual(result.data.errors, []);
  assert.equal((await db.one("SELECT driver_id FROM loads")).driver_id, id);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM drivers")).n, 1);
  assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
});

test("sync reports ambiguous driver folder names without registering or scanning those drivers", async (t) => {
  await driver("Existing");
  const existing = manualLoad("Existing", ["Load #100"]);
  const allowed = manualLoad("Allowed", ["Load #200"]);
  t.mock.method(getStorage(), "listDriverFolders", async () => [
    { name: "Existing", folderRef: path.dirname(existing.folder) },
    { name: "existing", folderRef: "conflicting-existing-folder" },
    { name: "New Driver", folderRef: "new-one" },
    { name: "new driver", folderRef: "new-two" },
    { name: "Allowed", folderRef: path.dirname(allowed.folder) },
  ]);
  const result = await call("sync", "POST");
  assert.equal(result.status, 200);
  assert.equal(result.data.driversImported, 1);
  assert.equal(result.data.driversScanned, 1);
  assert.equal(result.data.loadsImported, 1);
  assert.equal(result.data.errors.length, 2);
  assert.ok(result.data.errors.every((error) => /Multiple driver folders/.test(error)));
  assert.deepEqual(await db.all("SELECT name FROM drivers ORDER BY name"), [{ name: "Allowed" }, { name: "Existing" }]);
  assert.deepEqual(await db.all("SELECT load_number FROM loads"), [{ load_number: "200" }]);
  assert.equal(fs.readFileSync(existing.file, "utf8"), "manual rate content");
});

test("sync reports invalid driver folder names while importing valid folders", async (t) => {
  const document = manualLoad("Valid", ["Load #100"]);
  t.mock.method(getStorage(), "listDriverFolders", async () => [
    { name: "NUL", folderRef: "reserved-name" },
    { name: "Bad?Name", folderRef: "unsupported-name" },
    { name: "Valid", folderRef: path.dirname(document.folder) },
  ]);
  const result = await call("sync", "POST");
  assert.equal(result.data.driversImported, 1);
  assert.equal(result.data.loadsImported, 1);
  assert.equal(result.data.errors.length, 2);
  assert.deepEqual(await db.all("SELECT name FROM drivers"), [{ name: "Valid" }]);
});

test("sync refuses duplicate load numbers across layouts instead of choosing or merging a folder", async () => {
  const documents = [
    manualLoad("Driver", ["Load #100"]),
    manualLoad("Driver", ["Loads", "Load #100"]),
    manualLoad("Driver", ["Loadout #ABC"]),
    manualLoad("Driver", ["Loadout", "Loadout #abc"]),
  ];
  manualLoad("Driver", ["Load #200"]);
  const result = await call("sync", "POST");
  assert.equal(result.data.loadsImported, 1);
  assert.equal(result.data.filesImported, 1);
  assert.equal(result.data.errors.length, 4);
  assert.ok(result.data.errors.every((error) => /multiple folders/.test(error)));
  assert.deepEqual(await db.all("SELECT load_number FROM loads"), [{ load_number: "200" }]);
  for (const document of documents) assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
});

test("booking refuses direct active and archived folders before they have been synced", async () => {
  const id = await driver();
  for (const [number, type, folder] of [
    ["100", "load", "Load #100"], ["200", "load", "Archived - Load #200"],
    ["300", "loadout", "Loadout #300"], ["400", "loadout", "Archived - Loadout #400"],
  ]) {
    const document = manualLoad("Test Driver", [folder]);
    const result = await call("loads", "POST", { body: form(id, number, type) });
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
  }
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads")), false);
});

test("new loads and loadouts are siblings of existing direct load folders, including archived ones", async () => {
  const seeds = ["Load #SEED-0", "Loadout #SEED-1", "Archived - Load #SEED-2", "Archived - Loadout #SEED-3"];
  for (const [index, seed] of seeds.entries()) {
    const name = `Flat Driver ${index}`;
    const id = await driver(name);
    const original = manualLoad(name, [seed]);
    const parent = path.dirname(original.folder);
    for (const type of ["load", "loadout"]) {
      const item = await load(id, `NEW-${index}`, type);
      assert.equal(item.folder_ref, path.join(parent, loadFolderName(`NEW-${index}`, type)));
      assert.equal(item.files[0].storage_ref, path.join(item.folder_ref, "rate.txt"));
      assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
      assert.equal(fs.readFileSync(original.file, "utf8"), "manual rate content");
    }
    assert.deepEqual(fs.readdirSync(parent).sort(), [seed, `Load #NEW-${index}`, `Loadout #NEW-${index}`].sort());
  }
  const sync = await call("sync", "POST");
  assert.deepEqual(sync.data.errors, []);
  assert.equal(sync.data.skippedExisting, 8);
  assert.equal(sync.data.loadsImported, 2);
});

test("an existing matching grouping folder wins while the other load type keeps the direct layout", async () => {
  for (const [index, groupedType] of ["load", "loadout"].entries()) {
    const name = `Mixed Driver ${index}`;
    const id = await driver(name);
    const original = manualLoad(name, [`Load #MANUAL-${index}`]);
    const parent = path.dirname(original.folder);
    const grouped = groupedType === "load" ? "Loads" : "Loadout";
    fs.mkdirSync(path.join(parent, grouped));
    for (const type of ["load", "loadout"]) {
      const item = await load(id, `NEW-${index}`, type);
      const expectedParent = type === groupedType ? path.join(parent, grouped) : parent;
      assert.equal(item.folder_ref, path.join(expectedParent, loadFolderName(`NEW-${index}`, type)));
    }
    assert.equal(fs.existsSync(path.join(parent, groupedType === "load" ? "Loadout" : "Loads")), false);
    assert.equal(fs.readFileSync(original.file, "utf8"), "manual rate content");
  }
});

test("new drivers and drivers with unrelated documents retain the grouped default", async () => {
  const id = await driver();
  const parent = path.join(workspace, "storage", "Test Driver");
  fs.mkdirSync(path.join(parent, "Documents"), { recursive: true });
  fs.writeFileSync(path.join(parent, "Load #not-a-folder"), "unrelated file");
  for (const type of ["load", "loadout"]) {
    const item = await load(id, "100", type);
    assert.equal(item.folder_ref, path.join(parent, type === "load" ? "Loads" : "Loadout", loadFolderName("100", type)));
  }
  const emptyDriver = await driver("New Driver");
  const item = await load(emptyDriver, "200");
  assert.equal(item.folder_ref, path.join(workspace, "storage", "New Driver", "Loads", "Load #200"));
});

test("failed bookings in a flat layout remove only the new folder and preserve existing paperwork", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  const original = manualLoad("Test Driver", ["Load #EXISTING"]);
  t.mock.method(getStorage(), "saveFile", async () => { throw new Error("Required upload failed"); });
  const result = await call("loads", "POST", { body: form(id, "NEW", "loadout") });
  assert.equal(result.status, 500);
  assert.deepEqual(fs.readdirSync(path.dirname(original.folder)), ["Load #EXISTING"]);
  assert.equal(fs.readFileSync(original.file, "utf8"), "manual rate content");
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
});

test("layout inspection errors abort booking instead of creating folders in a different location", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  const original = manualLoad("Test Driver", ["Load #EXISTING"]);
  const parent = path.dirname(original.folder);
  const read = fs.readdirSync;
  const scan = t.mock.method(fs, "readdirSync", (directory, ...args) => {
    if (directory === parent) throw Object.assign(new Error("Cannot inspect driver layout"), { code: "EACCES" });
    return read(directory, ...args);
  });
  try {
    const result = await call("loads", "POST", { body: form(id, "NEW") });
    assert.equal(result.status, 500);
    assert.match(result.data.error, /Cannot inspect driver layout/);
    assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM loads")).n, 0);
  } finally {
    scan.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(parent), ["Load #EXISTING"]);
  fs.writeFileSync(path.join(parent, "Loads"), "not a folder");
  const result = await call("loads", "POST", { body: form(id, "NEW") });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /grouping path is not a folder/);
  assert.equal(fs.readFileSync(original.file, "utf8"), "manual rate content");
});

test("reassigned loads join a flat destination layout and keep it through archive and restore", async () => {
  const source = await driver("Grouped");
  const destination = await driver("Flat");
  const original = manualLoad("Flat", ["Load #EXISTING"]);
  const parent = path.dirname(original.folder);
  for (const type of ["load", "loadout"]) {
    const item = await load(source, "100", type);
    const moved = await call("load", "PATCH", { id: item.id, body: { driver_id: destination } });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.folder_ref, path.join(parent, loadFolderName("100", type)));
    const archived = await call("archive", "POST", { id: item.id, body: { archived: true } });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.folder_ref, path.join(parent, loadFolderName("100", type, true)));
    const restored = await call("archive", "POST", { id: item.id, body: { archived: false } });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.folder_ref, moved.data.folder_ref);
    assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
  }
  assert.equal(fs.existsSync(path.join(parent, "Loads")), false);
  assert.equal(fs.existsSync(path.join(parent, "Loadout")), false);
  assert.equal(fs.readFileSync(original.file, "utf8"), "manual rate content");
});

test("directly imported loads support uploads, archive, restore, and later reassignment", async () => {
  const documents = [manualLoad("Williams", ["Load #100"]), manualLoad("Williams", ["Loadout #200"])];
  await call("sync", "POST");
  const target = await driver("Reassigned");
  for (const document of documents) {
    const item = await db.one("SELECT * FROM loads WHERE folder_ref = $1", [document.folder]);
    const body = new FormData();
    body.set("file", new File(["invoice content"], "invoice.txt"));
    body.set("category", "invoice");
    assert.equal((await call("upload", "POST", { id: item.id, body })).status, 201);
    assert.equal(fs.readFileSync(path.join(document.folder, "invoice.txt"), "utf8"), "invoice content");
    const archived = await call("archive", "POST", { id: item.id, body: { archived: true } });
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.equal(path.dirname(archived.data.folder_ref), path.dirname(document.folder));
    assert.equal(path.basename(archived.data.folder_ref), `Archived - ${path.basename(document.folder)}`);
    assert.equal((await call("sync", "POST")).data.loadsImported, 0);
    const restored = await call("archive", "POST", { id: item.id, body: { archived: false } });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.folder_ref, document.folder);
    assert.equal(fs.readFileSync(document.file, "utf8"), "manual rate content");
    const moved = await call("load", "PATCH", { id: item.id, body: { driver_id: target } });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(moved.data.driver_name, "Reassigned");
    assert.equal(moved.data.files.length, 2);
    assert.equal(fs.existsSync(document.folder), false);
    for (const file of moved.data.files) assert.equal(fs.existsSync(file.storage_ref), true);
    assert.equal((await call("sync", "POST")).data.loadsImported, 0);
  }
});

test("direct destination conflicts block reassignment and archive without changing paperwork", async () => {
  const first = await driver("First");
  const second = await driver("Second");
  for (const grouping of ["Loads", "Loadout"]) {
    fs.mkdirSync(path.join(workspace, "storage", "First", grouping), { recursive: true });
  }
  for (const [number, type, folder] of [
    ["100", "load", "Load #100"], ["200", "load", "Archived - Load #200"],
    ["300", "loadout", "Loadout #300"], ["400", "loadout", "Archived - Loadout #400"],
  ]) {
    const item = await load(first, number, type);
    const other = manualLoad("Second", [folder]);
    assert.equal((await call("load", "PATCH", { id: item.id, body: { driver_id: second } })).status, 409);
    const same = manualLoad("First", [folder]);
    assert.equal((await call("archive", "POST", { id: item.id, body: { archived: true } })).status, 409);
    assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
    assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
    assert.equal(fs.readFileSync(other.file, "utf8"), "manual rate content");
    assert.equal(fs.readFileSync(same.file, "utf8"), "manual rate content");
  }
});

test("sync archives deleted folders in both layouts without deleting metadata or archiving existing folders", async () => {
  const documents = [
    manualLoad("Driver", ["Load #100"]),
    manualLoad("Driver", ["Loads", "Load #200"]),
    manualLoad("Driver", ["Loadout #300"]),
    manualLoad("Driver", ["Loadout", "Loadout #400"]),
  ];
  const keeper = manualLoad("Driver", ["Loads", "Load #500"]);
  const missingFile = manualLoad("Driver", ["Load #600"]);
  assert.equal((await call("sync", "POST")).data.loadsImported, 6);
  const originals = [];
  for (const document of documents) {
    const { id } = await db.one("SELECT id FROM loads WHERE folder_ref = $1", [document.folder]);
    const result = await call("load", "PATCH", { id, body: { status: "invoiced", rate_amount: 1200, notes: "Keep these dispatch notes" } });
    assert.equal(result.status, 200);
    originals.push(result.data);
    fs.rmSync(document.folder, { recursive: true });
  }
  fs.unlinkSync(missingFile.file);
  const result = await call("sync", "POST");
  assert.equal(result.status, 200);
  assert.equal(result.data.loadsArchived, 4);
  assert.equal(result.data.loadsImported, 0);
  assert.equal(result.data.filesImported, 0);
  assert.deepEqual(result.data.errors, []);
  for (const original of originals) {
    const current = (await call("load", "GET", { id: original.id })).data;
    assert.ok(current.archived_at);
    assert.deepEqual(current, { ...original, archived_at: current.archived_at });
    assert.equal(fs.existsSync(current.folder_ref), false);
  }
  assert.deepEqual((await call("loads", "GET")).data.map((item) => item.load_number).sort(), ["500", "600"]);
  assert.equal((await call("loads", "GET", { query: "archived=archived" })).data.length, 4);
  assert.equal((await db.one("SELECT COUNT(*)::integer AS n FROM files")).n, 6);
  assert.equal(fs.readFileSync(keeper.file, "utf8"), "manual rate content");
  const archived = await db.all("SELECT id, archived_at FROM loads ORDER BY id");
  const repeated = await call("sync", "POST");
  assert.equal(repeated.data.loadsArchived, 0);
  assert.deepEqual(repeated.data.errors, []);
  assert.deepEqual(await db.all("SELECT id, archived_at FROM loads ORDER BY id"), archived);
});

test("missing-folder loads cannot be restored until their folder is recovered and never reactivate through sync", async () => {
  const document = manualLoad("Driver", ["Load #100"]);
  await call("sync", "POST");
  const { id } = await db.one("SELECT id FROM loads");
  const original = (await call("load", "GET", { id })).data;
  fs.rmSync(document.folder, { recursive: true });
  assert.equal((await call("sync", "POST")).data.loadsArchived, 1);
  const archived = (await call("load", "GET", { id })).data;
  const failed = await call("archive", "POST", { id, body: { archived: false } });
  assert.equal(failed.status, 409);
  assert.match(failed.data.error, /Recover the original folder/);
  assert.deepEqual((await call("load", "GET", { id })).data, archived);
  assert.equal(fs.existsSync(document.folder), false);
  const download = await call("file", "GET", { id: original.files[0].id });
  assert.equal(download.status, 404);
  assert.match(download.data.error, /missing from storage/);
  manualLoad("Driver", ["Load #100"]);
  const sync = await call("sync", "POST");
  assert.equal(sync.data.loadsImported, 0);
  assert.equal(sync.data.loadsArchived, 0);
  assert.equal(sync.data.skippedArchived, 1);
  assert.deepEqual((await call("load", "GET", { id })).data, archived);
  const restored = await call("archive", "POST", { id, body: { archived: false } });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.data, original);
  assert.equal((await call("file", "GET", { id: original.files[0].id })).data, "manual rate content");
});

test("manual archive also preserves records when the load folder has already been deleted", async () => {
  const item = await load(await driver());
  fs.rmSync(item.folder_ref, { recursive: true });
  const result = await call("archive", "POST", { id: item.id, body: { archived: true } });
  assert.equal(result.status, 200);
  assert.ok(result.data.archived_at);
  assert.deepEqual(result.data, { ...item, archived_at: result.data.archived_at });
  assert.equal(fs.existsSync(item.folder_ref), false);
  assert.equal(fs.existsSync(path.join(path.dirname(item.folder_ref), "Archived - Load #100")), false);
});

test("discovery, scan, and access failures never get interpreted as deleted loads", async (t) => {
  const id = await driver();
  const missing = await load(id, "100");
  await load(id, "200");
  fs.rmSync(missing.folder_ref, { recursive: true });
  const storage = getStorage();
  for (const method of ["listDriverFolders", "listLoadFolders", "listFolderFiles", "loadFolderPresent"]) {
    const mock = t.mock.method(storage, method, async () => {
      throw Object.assign(new Error(`${method}: access denied`), { code: "EACCES" });
    });
    try {
      const result = await call("sync", "POST");
      assert.equal(result.status, 200, method);
      assert.equal(result.data.loadsArchived, 0, method);
      assert.ok(result.data.errors.some((error) => error.includes("access denied")), method);
      assert.deepEqual((await call("load", "GET", { id: missing.id })).data, missing, method);
    } finally {
      mock.mock.restore();
    }
  }
  assert.equal((await call("sync", "POST")).data.loadsArchived, 1);
});

test("unavailable storage roots and driver folders do not archive their loads", async () => {
  const item = await load(await driver());
  const storage = path.join(workspace, "storage");
  const driverFolder = path.join(storage, "Test Driver");
  for (const source of [storage, driverFolder]) {
    const offline = path.join(workspace, "temporarily-offline");
    fs.renameSync(source, offline);
    try {
      const result = await call("sync", "POST");
      assert.equal(result.data.loadsArchived, 0);
      assert.ok(result.data.errors.some((error) => /storage folder is unavailable/.test(error)));
      assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
      assert.equal(fs.existsSync(source), false);
    } finally {
      fs.renameSync(offline, source);
    }
  }
  assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
});

test("folder permission errors and non-directory replacements are not evidence of deletion", async (t) => {
  const item = await load(await driver());
  const stat = fs.statSync;
  const mock = t.mock.method(fs, "statSync", (ref, ...args) => {
    if (ref === item.folder_ref) throw Object.assign(new Error("Folder permission denied"), { code: "EACCES" });
    return stat(ref, ...args);
  });
  try {
    await assert.rejects(getStorage().loadFolderPresent("Test Driver", item.folder_ref), /permission denied/);
    const result = await call("sync", "POST");
    assert.equal(result.data.loadsArchived, 0);
    assert.ok(result.data.errors.some((error) => /permission denied/.test(error)));
    assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  } finally {
    mock.mock.restore();
  }
  fs.rmSync(item.folder_ref, { recursive: true });
  fs.writeFileSync(item.folder_ref, "not a directory");
  const result = await call("sync", "POST");
  assert.equal(result.data.loadsArchived, 0);
  assert.ok(result.data.errors.some((error) => /not a folder/.test(error)));
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
});

test("sync reports relocated or manually renamed load folders rather than treating them as deleted", async () => {
  const moved = await load(await driver("Moved"), "100");
  const renamed = await load(await driver("Renamed"), "200");
  const direct = path.join(workspace, "storage", "Moved", "Load #100");
  const archivedName = path.join(path.dirname(renamed.folder_ref), "Archived - Load #200");
  fs.renameSync(moved.folder_ref, direct);
  fs.renameSync(renamed.folder_ref, archivedName);
  const result = await call("sync", "POST");
  assert.equal(result.data.loadsArchived, 0);
  assert.ok(result.data.errors.some((error) => /different folder/.test(error)));
  assert.ok(result.data.errors.some((error) => /matching active or archived folder still exists/.test(error)));
  for (const item of [moved, renamed]) assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  assert.equal(fs.readFileSync(path.join(direct, "rate.txt"), "utf8"), "rate content");
  assert.equal(fs.readFileSync(path.join(archivedName, "rate.txt"), "utf8"), "rate content");
});

test("sync keeps unlinked loads and failed archive updates intact", async () => {
  const id = await driver();
  const unlinked = await load(id, "100");
  const failed = await load(id, "200");
  fs.rmSync(unlinked.folder_ref, { recursive: true });
  fs.rmSync(failed.folder_ref, { recursive: true });
  await db.query("UPDATE loads SET folder_ref = '' WHERE id = $1", [unlinked.id]);
  await rejectLoadChanges("UPDATE", "forced archive failure");
  const result = await call("sync", "POST");
  assert.equal(result.data.loadsArchived, 0);
  assert.ok(result.data.errors.some((error) => /No storage folder is linked/.test(error)));
  assert.ok(result.data.errors.some((error) => /forced archive failure/.test(error)));
  assert.deepEqual((await call("load", "GET", { id: unlinked.id })).data, { ...unlinked, folder_ref: "" });
  assert.deepEqual((await call("load", "GET", { id: failed.id })).data, failed);
});

test("read-only Drive routes reject storage-changing actions but keep dashboard-only edits and sync available", async (t) => {
  const first = await driver("First");
  const second = await driver("Second");
  const item = await load(first);
  const storage = getStorage();
  const original = Object.getOwnPropertyDescriptor(storage, "readOnly");
  Object.defineProperty(storage, "readOnly", { value: true, configurable: true });
  t.after(() => Object.defineProperty(storage, "readOnly", original));
  for (const method of ["createLoadFolder", "saveFile", "deleteFile", "moveLoadFolder", "renameDriverFolder"]) {
    t.mock.method(storage, method, DriveStorage.prototype[method].bind(storage));
  }
  const body = new FormData();
  body.set("file", new File(["new document"], "new.txt"));
  const before = async () => JSON.stringify([
    await db.all("SELECT * FROM drivers ORDER BY id"),
    await db.all("SELECT * FROM loads ORDER BY id"),
    await db.all("SELECT * FROM files ORDER BY id"),
  ]);
  const snapshot = await before();
  for (const action of [
    () => call("loads", "POST", { body: form(first, "200") }),
    () => call("upload", "POST", { id: item.id, body }),
    () => call("file", "DELETE", { id: item.files[0].id }),
    () => call("load", "PATCH", { id: item.id, body: { driver_id: second, notes: "Must not persist" } }),
    () => call("driver", "PATCH", { id: first, body: { name: "Renamed", phone: "Must not persist" } }),
    () => call("archive", "POST", { id: item.id, body: { archived: true } }),
    () => call("load", "DELETE", { id: item.id }),
    () => call("drivers", "POST", { body: { name: "Unlinked Driver" } }),
    () => call("driver", "DELETE", { id: second }),
  ]) {
    const result = await action();
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.match(result.data.error, /read-only/);
    assert.equal(await before(), snapshot);
    assert.equal(fs.readFileSync(item.files[0].storage_ref, "utf8"), "rate content");
  }
  const edited = await call("load", "PATCH", { id: item.id, body: { notes: "Dashboard note", status: "picked_up" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.notes, "Dashboard note");
  assert.equal(edited.data.folder_ref, item.folder_ref);
  assert.equal((await call("driver", "PATCH", { id: first, body: { truck: "204" } })).status, 200);
  manualLoad("Imported Driver", ["Load #300"]);
  const synced = await call("sync", "POST");
  assert.deepEqual(synced.data.errors, []);
  assert.equal(synced.data.driversImported, 1);
  assert.equal(synced.data.loadsImported, 1);
  assert.equal((await call("file", "GET", { id: item.files[0].id })).data, "rate content");
});

test("load list composes driver/type/status/archive/date filters and sorting", async () => {
  const first = await driver("First");
  const second = await driver("Second");
  const one = await load(first, "100");
  const two = await load(first, "200", "loadout");
  const three = await load(second, "300");
  await call("load", "PATCH", { id: two.id, body: { status: "invoiced", invoice_due_date: "2026-09-30", rate_amount: 3000 } });
  await call("load", "PATCH", { id: three.id, body: { rate_amount: 2000 } });
  const exact = await call("loads", "GET", { query: `driver_id=${first}&load_type=loadout&status=invoiced&date_field=invoice_due_date&date_from=2026-09-30&date_to=2026-09-30&q=200` });
  assert.deepEqual(exact.data.map((item) => item.id), [two.id]);
  const sorted = await call("loads", "GET", { query: "sort=rate_amount&order=asc" });
  assert.deepEqual(sorted.data.map((item) => item.id), [one.id, three.id, two.id]);
  assert.equal((await call("loads", "GET", { query: "date_from=2026-09-03" })).data.length, 0);
  assert.equal((await call("loads", "GET", { query: "date_field=invoice_due_date&date_to=2026-10-01" })).data.length, 1);
  for (const query of ["driver_id=-1", "driver_id=2147483648", "driver_id=9007199254740991", "load_type=no", "status=no", "archived=no", "date_field=no",
    "date_from=2026-02-30", "date_from=2026-09-30&date_to=2026-09-01", "sort=no", "order=no"]) {
    assert.equal((await call("loads", "GET", { query })).status, 400, query);
  }
});

test("overdue labels use explicit dates and ignore completed or archived loads", () => {
  const base = { archived_at: null, status: "scheduled", delivery_date: "2026-09-01", invoice_due_date: "" };
  assert.equal(overdueLabel(base, "2026-09-02"), "Delivery overdue");
  assert.equal(overdueLabel(base, "2026-09-01"), "");
  assert.equal(overdueLabel({ ...base, status: "unloaded" }, "2026-09-02"), "");
  assert.equal(overdueLabel({ ...base, status: "invoiced" }, "2026-09-02"), "");
  assert.equal(overdueLabel({ ...base, status: "invoiced", invoice_due_date: "2026-09-01" }, "2026-09-02"), "Payment overdue");
  assert.equal(overdueLabel({ ...base, archived_at: "2026-09-01" }, "2026-09-02"), "");
  assert.equal(todayLocal(new Date(2026, 8, 2)), "2026-09-02");
});

test("sync discovery cannot observe an in-progress driver rename while dashboard reads remain available", async (t) => {
  const id = await driver("Discovery Guard Driver");
  await load(id, "DISCOVERY-GUARD");
  const storage = getStorage();
  const original = storage.listDriverFolders;
  const scanning = deferred();
  const release = deferred();
  t.mock.method(storage, "listDriverFolders", async () => {
    scanning.resolve();
    await release.promise;
    return original.call(storage);
  });
  const syncing = call("sync", "POST");
  let result;
  try {
    await promptly(scanning.promise);
    assert.equal((await promptly(call("loads", "GET"))).status, 200);
    const renamed = await promptly(call("driver", "PATCH", { id, body: { name: "Uncommitted Name" } }));
    assert.equal(renamed.status, 409, JSON.stringify(renamed.data));
    assert.equal((await db.one("SELECT name FROM drivers WHERE id = $1", [id])).name, "Discovery Guard Driver");
  } finally {
    result = await finishHeldMutation(syncing, release, []);
  }
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.errors, []);
  assert.equal((await call("drivers", "GET")).data.length, 1);
});

test("load-scoped PostgreSQL locks allow reads and independent mutations while conflicts return 409", async () => {
  const id = await driver();
  const first = await load(id, "FIRST");
  const second = await load(id, "SECOND");
  const entered = deferred();
  const release = deferred();
  const pending = [];
  const mutation = withDataLock(async () => {
    await db.query("UPDATE loads SET notes = $1 WHERE id = $2", ["Uncommitted note", first.id]);
    entered.resolve();
    await release.promise;
  }, { keys: [`load:${first.id}`] });
  mutation.catch(entered.reject);
  const run = (promise) => { pending.push(promise); return promptly(promise); };
  try {
    await promptly(entered.promise);
    const detail = await run(call("load", "GET", { id: first.id }));
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.data, first, "Readers must not see uncommitted changes");
    const list = await run(call("loads", "GET"));
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 2);
    assert.equal((await run(call("drivers", "GET"))).status, 200);
    assert.equal((await run(call("file", "GET", { id: first.files[0].id }))).data, "rate content");
    const conflict = await run(call("load", "PATCH", { id: first.id, body: { notes: "Conflicting note" } }));
    assert.equal(conflict.status, 409);
    assert.match(conflict.data.error, /retry|try again|busy|progress/i);
    const replica = callFromFreshProcess(path.join(__dirname, "..", "app", "api", "loads", "[id]", "route.ts"), "PATCH", {
      id: first.id, body: { notes: "Conflicting replica note" },
    });
    assert.equal(replica.status, 409, JSON.stringify(replica.data));
    const independent = await run(call("load", "PATCH", { id: second.id, body: { notes: "Independent note" } }));
    assert.equal(independent.status, 200);
    assert.equal(independent.data.notes, "Independent note");
  } finally {
    await finishHeldMutation(mutation, release, pending);
  }
  assert.equal((await call("load", "GET", { id: first.id })).data.notes, "Uncommitted note");
  assert.equal((await call("load", "PATCH", { id: first.id, body: { notes: "Retried after release" } })).status, 200);
});

test("failed PostgreSQL mutations roll back their rows and release scoped locks", async () => {
  const item = await load(await driver());
  await assert.rejects(withDataLock(async () => {
    await db.query("UPDATE loads SET notes = $1 WHERE id = $2", ["Must roll back", item.id]);
    throw new Error("expected transaction failure");
  }, { keys: [`load:${item.id}`] }), /expected transaction failure/);
  assert.deepEqual((await call("load", "GET", { id: item.id })).data, item);
  const retried = await call("load", "PATCH", { id: item.id, body: { notes: "After rollback" } });
  assert.equal(retried.status, 200);
  assert.equal(retried.data.notes, "After rollback");
});

test("driver mutations require an exclusive roster lock without blocking dashboard reads", async () => {
  const id = await driver();
  const item = await load(id);
  for (const drivers of ["shared", "exclusive"]) {
    const entered = deferred();
    const release = deferred();
    const pending = [];
    const mutation = withDataLock(async () => {
      entered.resolve();
      await release.promise;
    }, { drivers, keys: drivers === "shared" ? [`load:${item.id}`] : [] });
    mutation.catch(entered.reject);
    const run = (promise) => { pending.push(promise); return promptly(promise); };
    try {
      await promptly(entered.promise);
      const rename = await run(call("driver", "PATCH", { id, body: { name: "Blocked rename" } }));
      assert.equal(rename.status, 409, drivers);
      const create = await run(call("drivers", "POST", { body: { name: "Blocked driver" } }));
      assert.equal(create.status, 409, drivers);
      if (drivers === "exclusive") {
        const edit = await run(call("load", "PATCH", { id: item.id, body: { notes: "Blocked edit" } }));
        assert.equal(edit.status, 409);
      }
      assert.equal((await run(call("drivers", "GET"))).status, 200);
      assert.deepEqual((await run(call("load", "GET", { id: item.id }))).data, item);
    } finally {
      await finishHeldMutation(mutation, release, pending);
    }
  }
  assert.equal((await call("driver", "PATCH", { id, body: { name: "After release" } })).status, 200);
});
