const fs = require("node:fs");
const path = require("node:path");
const {
  SCHEMA_VERSION,
  loadEnvironment,
  getDatabaseUrl,
  getStorageBinding,
  validateBinding,
  connectDatabase,
  beginMigration,
  existingTables,
  assertDatabaseBinding,
  safeErrorMessage,
  definiteCommitFailure,
} = require("./postgres-tools.cjs");

async function migrateDatabase({ url, binding }) {
  binding = validateBinding(binding);
  const client = await connectDatabase(url);
  let committing = false;
  try {
    await beginMigration(client);
    const tables = await existingTables(client);
    if (tables.has("dispatch_meta")) {
      await assertDatabaseBinding(client, binding);
      committing = true;
      await client.query("COMMIT");
      return { version: SCHEMA_VERSION, created: false, binding };
    }
    if (tables.size) {
      throw new Error("The target already contains unversioned DispatchBoard tables. Refusing to overwrite or adopt an unknown dataset.");
    }
    const schema = fs.readFileSync(path.join(__dirname, "..", "migrations", "001-postgresql.sql"), "utf8");
    await client.query(schema);
    await client.query(
      "INSERT INTO dispatch_meta(singleton, schema_version, storage_mode, storage_root) VALUES (TRUE, $1, $2, $3)",
      [SCHEMA_VERSION, binding.mode, binding.root]
    );
    await assertDatabaseBinding(client, binding);
    committing = true;
    await client.query("COMMIT");
    return { version: SCHEMA_VERSION, created: true, binding };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (committing && !definiteCommitFailure(error)) {
      throw new Error("The schema commit outcome could not be confirmed. Inspect the target database before retrying; no storage documents were changed.", { cause: error });
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  if (process.argv.slice(2).length) throw new Error("Usage: node scripts\\db-migrate.cjs");
  loadEnvironment();
  const result = await migrateDatabase({ url: getDatabaseUrl(), binding: getStorageBinding() });
  console.log(`PostgreSQL schema ${result.version} ${result.created ? "created" : "already initialized"}; storage binding verified (${result.binding.mode}).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

module.exports = { migrateDatabase };
