const path = require("node:path");
const { Client } = require("pg");

const SCHEMA_VERSION = 1;
const TABLES = ["drivers", "loads", "files", "dispatch_meta", "sync_runs"];

function loadEnvironment(directory = process.cwd()) {
  require("@next/env").loadEnvConfig(directory);
}

function validateDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("A valid PostgreSQL database URL is required; no database was changed.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error("A PostgreSQL URL with a host and database name is required; no database was changed.");
  }
  return value;
}

function getDatabaseUrl(environment = process.env) {
  const value = environment.DATABASE_URL_UNPOOLED || environment.POSTGRES_URL_NON_POOLING
    || environment.DATABASE_URL || environment.POSTGRES_URL;
  if (!value) {
    throw new Error("Set DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING, DATABASE_URL, or POSTGRES_URL before running a migration.");
  }
  return validateDatabaseUrl(value);
}

function validateBinding(binding) {
  if (!binding || !["local", "drive"].includes(binding.mode) || typeof binding.root !== "string" || !binding.root) {
    throw new Error("A valid, explicit storage mode and root are required.");
  }
  if (binding.mode === "drive" && !/^[A-Za-z0-9_-]+$/.test(binding.root)) {
    throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID must be a Drive folder ID, not a URL or filesystem path.");
  }
  if (binding.mode === "local" && (!path.isAbsolute(binding.root) || path.normalize(binding.root) !== binding.root)) {
    throw new Error("The local storage root must be an absolute, normalized path.");
  }
  return {
    mode: binding.mode,
    root: binding.mode === "local" && process.platform === "win32" ? binding.root.toLowerCase() : binding.root,
  };
}

function getStorageBinding(environment = process.env, directory = process.cwd()) {
  const mode = environment.STORAGE_MODE ?? "local";
  if (environment.VERCEL && mode !== "drive") {
    throw new Error("Vercel requires STORAGE_MODE=drive; local document storage is not persistent there.");
  }
  return validateBinding({
    mode,
    root: mode === "drive" ? environment.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() : path.resolve(directory, "storage"),
  });
}

async function connectDatabase(url) {
  const client = new Client({
    connectionString: validateDatabaseUrl(url),
    connectionTimeoutMillis: 5_000,
    application_name: "dispatch-migration",
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw new Error("Unable to connect to PostgreSQL. Check the private database configuration and availability.", { cause: error });
  }
}

async function beginMigration(client) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '60s'");
  await client.query("SET LOCAL search_path TO public");
  const result = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('dispatch:dataset', 0)) AS acquired");
  if (!result.rows[0].acquired) {
    throw new Error("The dataset is currently being updated. Stop app mutations and retry the migration.");
  }
}

async function existingTables(client) {
  const result = await client.query(
    "SELECT name, to_regclass('public.' || name)::text AS relation FROM unnest($1::text[]) AS name",
    [TABLES]
  );
  return new Set(result.rows.filter((row) => row.relation).map((row) => row.name));
}

async function assertDatabaseBinding(client, requested) {
  const binding = validateBinding(requested);
  let result;
  try {
    result = await client.query("SELECT singleton, schema_version, storage_mode, storage_root FROM public.dispatch_meta");
  } catch (error) {
    if (error.code === "42P01" || error.code === "42703") {
      throw new Error("The PostgreSQL schema is not initialized. Run scripts\\db-migrate.cjs first.", { cause: error });
    }
    throw error;
  }
  if (result.rows.length !== 1 || result.rows[0].singleton !== true || result.rows[0].schema_version !== SCHEMA_VERSION) {
    throw new Error("The PostgreSQL schema version or dataset metadata is incompatible. No data was changed.");
  }
  const actual = result.rows[0];
  if (actual.storage_mode !== binding.mode || actual.storage_root !== binding.root) {
    throw new Error("The PostgreSQL database is bound to a different storage mode/root. Use its exact configured dataset or a separate empty database.");
  }
  const tables = await existingTables(client);
  if (TABLES.some((table) => !tables.has(table))) {
    throw new Error("The PostgreSQL schema is incomplete. Restore or repair it explicitly before migrating data.");
  }
}

function safeErrorMessage(error) {
  if (error && typeof error.severity === "string" && error.severity && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) {
    return `PostgreSQL rejected the migration (SQLSTATE ${error.code}). Check the schema, constraints, and database availability; no credentials are logged.`;
  }
  if (!(error instanceof Error)) return "The migration failed.";
  return error.message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL URL]");
}

function definiteCommitFailure(error) {
  const code = error?.code;
  return typeof error?.severity === "string" && Boolean(error.severity)
    && typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
    && code !== "40003" && !/^(08|57|58|XX)/.test(code);
}

module.exports = {
  SCHEMA_VERSION,
  loadEnvironment,
  getDatabaseUrl,
  validateDatabaseUrl,
  getStorageBinding,
  validateBinding,
  connectDatabase,
  beginMigration,
  existingTables,
  assertDatabaseBinding,
  safeErrorMessage,
  definiteCommitFailure,
};
