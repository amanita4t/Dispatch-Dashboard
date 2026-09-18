require("./register.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, beforeEach, after, afterEach } = require("node:test");
const { getStorageMode, getDriveReadOnly, getStoragePath, getDatabaseUrl, getStorageBinding } = require("../lib/config.ts");
const originalCwd = process.cwd();
const keys = [
  "STORAGE_MODE", "VERCEL", "DATABASE_URL", "POSTGRES_URL", "GOOGLE_DRIVE_ROOT_FOLDER_ID",
  "GOOGLE_DRIVE_READ_ONLY", "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN",
];
const environment = new Map(keys.map((key) => [key, process.env[key]]));
let workspace;

before(() => {
  workspace = path.resolve(fs.mkdtempSync(".dispatch-config-"));
  process.chdir(workspace);
});

beforeEach(() => {
  for (const key of keys) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[require.resolve("../lib/storage.ts")];
});

after(() => {
  process.chdir(originalCwd);
  if (workspace) {
    assert.equal(path.dirname(workspace), originalCwd);
    assert.ok(path.basename(workspace).startsWith(".dispatch-config-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("local remains the default with Google credentials configured", () => {
  for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_DRIVE_ROOT_FOLDER_ID"]) {
    process.env[key] = "unused-test-value";
  }
  assert.equal(getStorageMode(), "local");
  assert.equal(getStoragePath(), path.join(workspace, "storage"));
  const filename = require.resolve("../lib/storage.ts");
  delete require.cache[filename];
  assert.equal(require(filename).getStorage().mode, "local");
  process.env.STORAGE_MODE = "drive";
  assert.equal(getStorageMode(), "drive");
  delete require.cache[filename];
  assert.equal(require(filename).getStorage().mode, "drive");
  process.env.STORAGE_MODE = "unknown";
  assert.throws(getStorageMode, /STORAGE_MODE/);
});

test("Drive read-only settings are explicit and invalid values never enable writes", () => {
  assert.equal(getDriveReadOnly(), false);
  process.env.GOOGLE_DRIVE_READ_ONLY = "true";
  assert.equal(getDriveReadOnly(), true);
  process.env.GOOGLE_DRIVE_READ_ONLY = "false";
  assert.equal(getDriveReadOnly(), false);
  for (const value of ["", "yes", "TRUE", "0"]) {
    process.env.GOOGLE_DRIVE_READ_ONLY = value;
    assert.throws(getDriveReadOnly, /GOOGLE_DRIVE_READ_ONLY/);
  }
});

test("DATABASE_URL is required with POSTGRES_URL as its pooled PostgreSQL fallback", () => {
  assert.throws(getDatabaseUrl, /DATABASE_URL|POSTGRES_URL/);
  const fallback = "postgres://dispatch:synthetic@127.0.0.1:5432/fallback?sslmode=require";
  const primary = "postgresql://dispatch:synthetic@127.0.0.1:5432/primary?sslmode=require";
  process.env.POSTGRES_URL = fallback;
  assert.equal(getDatabaseUrl(), fallback);
  process.env.DATABASE_URL = primary;
  assert.equal(getDatabaseUrl(), primary);
  process.env.POSTGRES_URL = "not-a-database-url";
  assert.equal(getDatabaseUrl(), primary);
  delete process.env.DATABASE_URL;
  assert.throws(getDatabaseUrl, /DATABASE_URL|POSTGRES_URL|PostgreSQL/);
});

test("database configuration rejects malformed URLs and non-PostgreSQL schemes", () => {
  process.env.POSTGRES_URL = "postgres://dispatch:synthetic@127.0.0.1:5432/fallback";
  for (const invalid of [
    "not a URL", "postgresql://", "file:///not-a-database",
    "mysql://dispatch:synthetic@127.0.0.1/database", "https://127.0.0.1/database",
  ]) {
    process.env.DATABASE_URL = invalid;
    assert.throws(getDatabaseUrl, /DATABASE_URL|PostgreSQL/, invalid);
  }
});

test("local storage bindings use an absolute normalized document root", () => {
  const binding = getStorageBinding();
  assert.equal(binding.mode, "local");
  assert.equal(path.isAbsolute(binding.root), true);
  const root = path.resolve(workspace, "storage");
  assert.equal(binding.root, process.platform === "win32" ? root.toLowerCase() : root);
});

test("Drive storage bindings require and distinguish the configured root folder", () => {
  process.env.STORAGE_MODE = "drive";
  assert.throws(getStorageBinding, /GOOGLE_DRIVE_ROOT_FOLDER_ID/);
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "synthetic-first-root";
  assert.deepEqual(getStorageBinding(), { mode: "drive", root: "synthetic-first-root" });
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "synthetic-second-root";
  assert.deepEqual(getStorageBinding(), { mode: "drive", root: "synthetic-second-root" });
});

test("Vercel rejects implicit and explicit local storage instead of using ephemeral documents", () => {
  for (const value of ["1", "true", "0"]) {
    process.env.VERCEL = value;
    delete process.env.STORAGE_MODE;
    assert.throws(getStorageMode, /Vercel|STORAGE_MODE|drive/i, `VERCEL=${value}, default local`);
    assert.throws(getStorageBinding, /Vercel|STORAGE_MODE|drive/i);
    process.env.STORAGE_MODE = "local";
    assert.throws(getStorageMode, /Vercel|STORAGE_MODE|drive/i, `VERCEL=${value}, explicit local`);
    process.env.STORAGE_MODE = "drive";
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "synthetic-serverless-root";
    assert.equal(getStorageMode(), "drive");
    assert.deepEqual(getStorageBinding(), { mode: "drive", root: "synthetic-serverless-root" });
  }
  process.env.VERCEL = "";
  delete process.env.STORAGE_MODE;
  assert.equal(getStorageMode(), "local");
});
