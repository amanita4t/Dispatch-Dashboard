const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Client, Pool } = require("pg");
const { migrateDatabase } = require("../scripts/db-migrate.cjs");
const { validateBinding } = require("../scripts/postgres-tools.cjs");

const project = path.resolve(__dirname, "..");
const fixtures = path.join(project, "data");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function windowsRuntimeDirectory() {
  if (process.platform !== "win32") return undefined;
  const candidates = [];
  if (process.env.POSTGRES_TEST_RUNTIME_DIR) candidates.push(process.env.POSTGRES_TEST_RUNTIME_DIR);
  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean)) {
    const edge = path.join(base, "Microsoft", "Edge", "Application");
    if (fs.existsSync(edge)) {
      candidates.push(...fs.readdirSync(edge, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+\./.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
        .map((entry) => path.join(edge, entry.name)));
    }
  }
  if (process.env.CommonProgramFiles) candidates.push(path.join(process.env.CommonProgramFiles, "microsoft shared", "ClickToRun"));
  return candidates.find((directory) => {
    if (!["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"].every((name) => fs.existsSync(path.join(directory, name)))) return false;
    const image = fs.readFileSync(path.join(directory, "msvcp140.dll"));
    return image.readUInt16LE(image.readUInt32LE(0x3c) + 4) === 0x8664;
  });
}

async function fixturePostgres(EmbeddedPostgres, options, directory) {
  if (process.platform !== "win32") return new EmbeddedPostgres(options);
  const runtime = windowsRuntimeDirectory();
  const binaries = await import("@embedded-postgres/windows-x64");
  const originalBin = path.dirname(binaries.postgres);
  let bin = originalBin;
  if (runtime) {
    // Older system MSVC DLLs take precedence over PATH. Stage private executable links and a matching
    // installed runtime, leaving both node_modules and the machine's shared runtime untouched.
    const native = path.join(directory, "native");
    bin = path.join(native, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of fs.readdirSync(originalBin)) {
      if (!/\.dll$/i.test(name) && !["initdb.exe", "postgres.exe", "pg_ctl.exe"].includes(name)) continue;
      try {
        fs.linkSync(path.join(originalBin, name), path.join(bin, name));
      } catch {
        fs.copyFileSync(path.join(originalBin, name), path.join(bin, name));
      }
    }
    for (const name of fs.readdirSync(runtime).filter((name) => /140.*\.dll$/i.test(name))) {
      const destination = path.join(bin, name);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      fs.copyFileSync(path.join(runtime, name), destination);
    }
    for (const name of ["share", "lib"]) {
      fs.symlinkSync(path.join(originalBin, "..", name), path.join(native, name), "junction");
    }
  }

  class WindowsFixturePostgres extends EmbeddedPostgres {
    async initialise() {
      const passwordFile = path.join(directory, "initdb-password");
      fs.writeFileSync(passwordFile, options.password + "\n", { mode: 0o600, flag: "wx" });
      try {
        await promisify(execFile)(path.join(bin, "initdb.exe"), [
          "-D", options.databaseDir, "-U", options.user, `--auth=${options.authMethod}`,
          `--pwfile=${passwordFile}`, "--lc-messages=C", ...options.initdbFlags,
        ]);
      } finally {
        fs.rmSync(passwordFile, { force: true });
      }
    }

    async start() {
      this.process = spawn(path.join(bin, "postgres.exe"), [
        "-D", options.databaseDir, "-p", String(options.port), ...options.postgresFlags,
      ], { env: { ...process.env, LC_MESSAGES: "C" } });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("PostgreSQL test startup timed out.")), 30_000);
        this.process.once("error", reject);
        this.process.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("PostgreSQL exited before the test server was ready."));
        });
        this.process.stderr.on("data", (data) => {
          const message = data.toString();
          options.onLog(message);
          if (message.includes("database system is ready to accept connections")) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }

    async stop() {
      const child = this.process;
      if (!child) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        this.process = undefined;
        return;
      }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await promisify(execFile)(path.join(bin, "pg_ctl.exe"), [
        "-D", options.databaseDir, "stop", "-m", "fast", "-w", "-t", "20",
      ]);
      await exited;
      this.process = undefined;
    }
  }
  return new WindowsFixturePostgres(options);
}

async function startTestDatabase({ storageMode = "local", storageRoot, initialize = true } = {}) {
  fs.mkdirSync(fixtures, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtures, "test-postgres-"));
  const password = randomBytes(24).toString("hex");
  const output = [];
  function capture(message) {
    output.push(String(message));
    if (output.length > 12) output.shift();
  }
  let postgres;
  let pool;
  let started = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      if (pool) await pool.end();
    } finally {
      if (postgres) {
        if (started || (postgres.process && postgres.process.exitCode === null && postgres.process.signalCode === null)) await postgres.stop();
        else postgres.process = undefined;
      }
      if (path.dirname(directory) !== fixtures || !path.basename(directory).startsWith("test-postgres-")) {
        throw new Error("Refusing to remove an unexpected PostgreSQL test directory.");
      }
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  try {
    const binding = validateBinding({ mode: storageMode, root: storageRoot ?? path.join(directory, "storage") });
    const port = await freePort();
    const url = `postgresql://postgres:${password}@127.0.0.1:${port}/dispatch_test?sslmode=disable`;
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    postgres = await fixturePostgres(EmbeddedPostgres, {
      databaseDir: path.join(directory, "pgdata"),
      user: "postgres",
      password,
      port,
      persistent: true,
      authMethod: "scram-sha-256",
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: [
        "-h", "127.0.0.1",
        "-c", "max_connections=25",
        "-c", `unix_socket_directories=${directory}`,
      ],
      onLog: capture,
      onError: capture,
    }, directory);
    // embedded-postgres stages initdb's password via os.tmpdir(); confine that file to this fixture.
    const oldScratch = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]));
    try {
      for (const key of ["TEMP", "TMP", "TMPDIR"]) process.env[key] = directory;
      await postgres.initialise();
      await postgres.start();
      started = true;
    } finally {
      for (const [key, value] of Object.entries(oldScratch)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const adminUrl = new URL(url);
    adminUrl.pathname = "/postgres";
    const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5_000 });
    try {
      await admin.connect();
      await admin.query("CREATE DATABASE dispatch_test");
    } finally {
      await admin.end();
    }
    if (initialize) await migrateDatabase({ url, binding });
    pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000 });
    pool.on("error", capture);
    await pool.query("SELECT 1");
    return { url, directory, storageRoot: binding.root, binding, pool, close };
  } catch (error) {
    await close();
    throw new Error(`Isolated PostgreSQL fixture failed to start: ${output.join("").replaceAll(password, "[redacted]")}`, { cause: error });
  }
}

module.exports = { startTestDatabase };
