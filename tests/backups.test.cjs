/* eslint-disable @typescript-eslint/no-require-imports -- The existing Node test harness uses CommonJS to register TypeScript imports. */
require("./register.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const Database = require("better-sqlite3");

const project = path.resolve(__dirname, "..");
const originalCwd = process.cwd();
const originalMode = process.env.STORAGE_MODE;
const workspace = fs.mkdtempSync(path.join(project, "tests", ".backup-fixture-"));
process.chdir(workspace);

const backup = require("../lib/backup.ts");
const api = require("../app/api/backups/route.ts");
const restoreApi = require("../app/api/backups/[id]/restore/route.ts");
const { withDataLock } = require("../lib/mutation-lock.ts");
const backupRoot = path.join(workspace, "backups", "local");
const storageRoot = path.join(workspace, "storage");
const folder = path.join(storageRoot, "Fixture", "Loads", "Archived - Load #100");
const document = path.join(folder, "rate.txt");
const marker = path.join(workspace, "data", "dispatch-local.db.restore-recovery.json");
let db;
let baseline;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (action) => withDataLock(action);
const published = () => fs.readdirSync(backupRoot).filter((name) => name.startsWith("local-")).length;
const rows = () => JSON.stringify([
  db.prepare("SELECT * FROM drivers ORDER BY id").all(),
  db.prepare("SELECT * FROM loads ORDER BY id").all(),
  db.prepare("SELECT * FROM files ORDER BY id").all(),
  db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
]);

function writeManifest(directory, manifest) {
  const bytes = JSON.stringify(manifest, null, 2) + "\n";
  fs.writeFileSync(path.join(directory, "manifest.json"), bytes);
  fs.writeFileSync(path.join(directory, "manifest.sha256"), hash(bytes) + "\n");
}

function cloneSnapshot(mutateManifest, mutateDatabase) {
  const id = baseline.id.replace(/[a-f0-9]{12}$/, randomUUID().replaceAll("-", "").slice(0, 12));
  const directory = path.join(backupRoot, id);
  fs.cpSync(path.join(backupRoot, baseline.id), directory, { recursive: true, errorOnExist: true, force: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  manifest.id = id;
  if (mutateDatabase) {
    const filename = path.join(directory, "database.sqlite");
    const snapshot = new Database(filename);
    try {
      mutateDatabase(snapshot);
    } finally {
      snapshot.close();
    }
    const bytes = fs.readFileSync(filename);
    manifest.sizeBytes += bytes.length - manifest.database.size;
    manifest.database.size = bytes.length;
    manifest.database.sha256 = hash(bytes);
  }
  if (mutateManifest) mutateManifest(manifest);
  writeManifest(directory, manifest);
  return { id, directory };
}

async function rejectSnapshot(copy, pattern) {
  const before = rows();
  const count = published();
  try {
    await assert.rejects(run(() => backup.restoreBackup(copy.id)), pattern);
    assert.equal(rows(), before);
    assert.equal(published(), count, "invalid backups must be rejected before making a safety snapshot");
    assert.equal(fs.readFileSync(document, "utf8"), "original document");
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(copy.directory, { recursive: true });
  }
}

function restoreRequest(id, confirmation = "RESTORE LOCAL DATA") {
  return restoreApi.POST(new Request("http://localhost/api/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation }),
  }), { params: { id } });
}

test("local backups use isolated project-owned data and never touch Drive", async (t) => {
  try {
    fs.mkdirSync("data");
    const driveDatabase = path.join(workspace, "data", "dispatch.db");
    fs.writeFileSync(driveDatabase, "untouched-drive-sentinel");
    fs.writeFileSync(".env.local", "unused-credential-sentinel");
    process.env.STORAGE_MODE = "drive";

    await t.test("Drive mode rejects all backup APIs without opening either database", async () => {
      assert.equal((await api.GET()).status, 409);
      assert.equal((await api.POST()).status, 409);
      assert.equal((await restoreRequest("../escape")).status, 409);
      assert.equal(fs.existsSync(path.join(workspace, "data", "dispatch-local.db")), false);
      assert.equal(fs.existsSync(driveDatabase + "-wal"), false);
      assert.equal(fs.existsSync(driveDatabase + "-shm"), false);
      assert.equal(fs.readFileSync(driveDatabase, "utf8"), "untouched-drive-sentinel");
    });

    process.env.STORAGE_MODE = "local";
    await t.test("empty datasets create standalone, complete, credential-free snapshots", async () => {
      const response = await api.POST();
      const body = await response.json();
      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.backup.counts.drivers, 0);
      assert.equal(body.backup.counts.storedFiles, 0);
      assert.deepEqual(fs.readdirSync(path.join(backupRoot, body.backup.id)).sort(),
        ["database.sqlite", "manifest.json", "manifest.sha256", "storage"]);
      const listing = await (await api.GET()).json();
      assert.equal(listing.location, backupRoot);
      assert.equal(listing.backups.length, 1);
    });

    db = require("../lib/db.ts").default;
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(path.join(storageRoot, "empty-folder"));
    fs.writeFileSync(document, "original document");
    fs.writeFileSync(path.join(storageRoot, "untracked.txt"), "untracked document");
    db.prepare("INSERT INTO drivers (id,name,phone,truck,created_at) VALUES (?,?,?,?,?)")
      .run(7, "Fixture", null, "unit", "2026-09-01 10:00:00");
    db.prepare(`INSERT INTO loads
      (id,load_number,load_type,driver_id,pickup_city,delivery_city,pickup_date,delivery_date,rate_amount,status,folder_ref,notes,created_at,archived_at,invoice_due_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(8, "100", "load", 7, "A", "B", "2026-09-01", "2026-09-02", 1250.25, "invoiced", folder, "fixture notes",
        "2026-09-01 10:00:00", "2026-09-03 12:00:00", "2026-09-16");
    db.prepare("INSERT INTO files (id,load_id,category,filename,storage_ref,web_link,size,uploaded_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(9, 8, "rate_confirmation", "rate.txt", document, "", 17, "2026-09-01 10:00:00");
    db.prepare("UPDATE sqlite_sequence SET seq=100 WHERE name='drivers'").run();

    await t.test("snapshots include archived loads, every untracked file, and empty folders", async () => {
      baseline = await run(() => backup.createBackup());
      assert.deepEqual(baseline.counts, {
        drivers: 1, loads: 1, archivedLoads: 1, documents: 1, storedFiles: 2, directories: 4,
      });
      const directory = path.join(backupRoot, baseline.id);
      assert.equal(fs.readFileSync(path.join(directory, "storage", "untracked.txt"), "utf8"), "untracked document");
      assert.ok(fs.statSync(path.join(directory, "storage", "empty-folder")).isDirectory());
      assert.equal(fs.existsSync(path.join(directory, ".env.local")), false);
    });

    await t.test("restores preserve IDs, relationships, all dates, nullable values, and SQLite sequences", async () => {
      const original = rows();
      db.prepare("UPDATE drivers SET name='Changed fixture' WHERE id=7").run();
      fs.writeFileSync(document, "modified document");
      const response = await restoreRequest(baseline.id);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(rows(), original);
      assert.equal(db.open, true, "restore must not close or replace the imported database handle");
      assert.equal(fs.readFileSync(document, "utf8"), "original document");
      assert.equal(result.safetyBackup.reason, "pre-restore");
      assert.equal(fs.readFileSync(path.join(backupRoot, result.safetyBackup.id, "storage",
        "Fixture", "Loads", "Archived - Load #100", "rate.txt"), "utf8"), "modified document");
      assert.equal(fs.existsSync(marker), false);
      assert.deepEqual(result.warnings, []);
    });

    await t.test("confirmation and traversal IDs are rejected without creating safety snapshots", async () => {
      const count = published();
      assert.equal((await restoreRequest(baseline.id, "yes")).status, 400);
      for (const id of ["../escape", "..\\escape", "%2e%2e", "", "local-invalid"]) {
        assert.equal((await restoreRequest(id)).status, 400);
      }
      assert.equal(published(), count);
    });

    await t.test("missing tracked current documents prevent backups and safe restore", async () => {
      const count = published();
      const before = rows();
      fs.unlinkSync(document);
      try {
        await assert.rejects(run(() => backup.createBackup()), /tracked local document is missing/i);
        await assert.rejects(run(() => backup.restoreBackup(baseline.id)), /safety backup could not be made/i);
        assert.equal(rows(), before);
        assert.equal(published(), count);
        assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith(".")), false);
        assert.equal(fs.existsSync(marker), false);
      } finally {
        fs.writeFileSync(document, "original document");
      }
    });

    await t.test("manifest/version/path, checksum, schema and foreign-key corruption fail before changes", async () => {
      await rejectSnapshot(cloneSnapshot((manifest) => { manifest.version = 999; }), /manifest/i);
      await rejectSnapshot(cloneSnapshot((manifest) => { manifest.inventory.files[0].path = "../outside"; }), /path/i);
      await rejectSnapshot(cloneSnapshot(null, (snapshot) => {
        snapshot.exec("ALTER TABLE loads ADD COLUMN unexpected TEXT");
      }), /schema/i);
      await rejectSnapshot(cloneSnapshot(null, (snapshot) => {
        snapshot.exec("CREATE TRIGGER unexpected BEFORE INSERT ON drivers BEGIN SELECT RAISE(ABORT, 'fixture'); END");
      }), /schema object/i);
      await rejectSnapshot(cloneSnapshot(null, (snapshot) => {
        snapshot.exec("PRAGMA foreign_keys=OFF; UPDATE files SET load_id=999");
      }), /integrity|relationship/i);
      const changed = cloneSnapshot();
      fs.writeFileSync(path.join(changed.directory, "storage", "untracked.txt"), "different document");
      await rejectSnapshot(changed, /integrity|inventory/i);
      const missing = cloneSnapshot();
      fs.unlinkSync(path.join(missing.directory, "storage", "untracked.txt"));
      await rejectSnapshot(missing, /inventory/i);
      const checksum = cloneSnapshot();
      fs.appendFileSync(path.join(checksum.directory, "manifest.json"), " ");
      await rejectSnapshot(checksum, /SHA256/i);
      const corruptedDatabase = cloneSnapshot();
      const filename = path.join(corruptedDatabase.directory, "database.sqlite");
      const bytes = fs.readFileSync(filename);
      bytes[18] = 2;
      bytes[19] = 2;
      fs.writeFileSync(filename, bytes);
      const manifest = JSON.parse(fs.readFileSync(path.join(corruptedDatabase.directory, "manifest.json"), "utf8"));
      manifest.database.sha256 = hash(bytes);
      writeManifest(corruptedDatabase.directory, manifest);
      await rejectSnapshot(corruptedDatabase, /standalone SQLite snapshot/i);
    });

    await t.test("external file and load-folder references never write outside local storage", async () => {
      const outside = path.join(workspace, "outside-document.txt");
      fs.writeFileSync(outside, "outside sentinel");
      for (const field of ["file", "folder"]) {
        const copy = cloneSnapshot(null, (snapshot) => {
          snapshot.prepare(field === "file" ? "UPDATE files SET storage_ref=?" : "UPDATE loads SET folder_ref=?").run(outside);
        });
        await rejectSnapshot(copy, /outside its source storage/i);
        assert.equal(fs.readFileSync(outside, "utf8"), "outside sentinel");
      }
    });

    await t.test("junctions and hard links cannot pull external files into a snapshot", async () => {
      const external = path.join(workspace, "outside-storage");
      fs.mkdirSync(external);
      const file = path.join(external, "outside.txt");
      fs.writeFileSync(file, "external sentinel");
      const linked = path.join(storageRoot, "linked-folder");
      const hardLink = path.join(storageRoot, "linked-file.txt");
      const count = published();
      fs.symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
      try {
        await assert.rejects(run(() => backup.createBackup()), /reparse|linked/i);
      } finally {
        fs.unlinkSync(linked);
      }
      fs.linkSync(file, hardLink);
      try {
        await assert.rejects(run(() => backup.createBackup()), /linked/i);
      } finally {
        fs.unlinkSync(hardLink);
      }
      assert.equal(published(), count);
      assert.equal(fs.readFileSync(file, "utf8"), "external sentinel");
      const linkedSnapshot = cloneSnapshot();
      fs.symlinkSync(external, path.join(linkedSnapshot.directory, "storage", "linked-folder"),
        process.platform === "win32" ? "junction" : "dir");
      await rejectSnapshot(linkedSnapshot, /reparse|linked/i);
      assert.equal(fs.readFileSync(file, "utf8"), "external sentinel");
    });

    await t.test("locked storage installation restores the original tree and leaves DB rows intact", async (test) => {
      const before = rows();
      const rename = fs.renameSync;
      test.mock.method(fs, "renameSync", (from, to) => {
        if (path.basename(from) === "new-storage" && to === storageRoot) {
          throw Object.assign(new Error("fixture locked rename"), { code: "EPERM" });
        }
        return rename(from, to);
      });
      await assert.rejects(run(() => backup.restoreBackup(baseline.id)), /original local database and documents were kept/i);
      assert.equal(rows(), before);
      assert.equal(fs.readFileSync(document, "utf8"), "original document");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith(".")), false);
    });

    await t.test("SQL failure after the storage swap rolls back rows, sequences, and documents", async (test) => {
      db.prepare("UPDATE drivers SET name='Current fixture' WHERE id=7").run();
      fs.writeFileSync(document, "current document");
      const before = rows();
      const prepare = db.prepare;
      test.mock.method(db, "prepare", function (sql) {
        if (sql.startsWith("INSERT INTO drivers (")) return { run() { throw new Error("fixture insert failure"); } };
        return prepare.call(this, sql);
      });
      try {
        await assert.rejects(run(() => backup.restoreBackup(baseline.id)), /original local database and documents were kept/i);
        assert.equal(rows(), before);
        assert.equal(fs.readFileSync(document, "utf8"), "current document");
        assert.equal(fs.existsSync(marker), false);
        assert.equal(fs.readdirSync(backupRoot).some((name) => name.startsWith(".")), false);
      } finally {
        db.prepare("UPDATE drivers SET name='Fixture' WHERE id=7").run();
        fs.writeFileSync(document, "original document");
      }
    });

    await t.test("failed compensation preserves recovery material and blocks further backup actions", async (test) => {
      db.prepare("UPDATE drivers SET name='Current fixture' WHERE id=7").run();
      fs.writeFileSync(document, "current document");
      const before = rows();
      const prepare = db.prepare;
      const rename = fs.renameSync;
      test.mock.method(db, "prepare", function (sql) {
        if (sql.startsWith("INSERT INTO drivers (")) return { run() { throw new Error("fixture insert failure"); } };
        return prepare.call(this, sql);
      });
      test.mock.method(fs, "renameSync", (from, to) => {
        if (from === storageRoot && path.basename(to) === "new-storage") {
          throw Object.assign(new Error("fixture compensation failure"), { code: "EPERM" });
        }
        return rename(from, to);
      });
      try {
        await assert.rejects(run(() => backup.restoreBackup(baseline.id)), /rollback could not be completed and verified/i);
        assert.equal(rows(), before);
        const recovery = JSON.parse(fs.readFileSync(marker, "utf8"));
        assert.ok(fs.statSync(path.join(backupRoot, recovery.recoveryDirectory, "previous-storage")).isDirectory());
        assert.equal(fs.readFileSync(path.join(backupRoot, recovery.recoveryDirectory, "previous-storage",
          "Fixture", "Loads", "Archived - Load #100", "rate.txt"), "utf8"), "current document");
        assert.equal(fs.readFileSync(document, "utf8"), "original document");
        assert.ok(fs.statSync(path.join(backupRoot, recovery.safetyBackupId)).isDirectory());
        assert.throws(() => backup.assertNoPendingLocalRestore(), /interrupted local restore/i);
        await assert.rejects(run(() => backup.createBackup()), /interrupted local restore/i);
      } finally {
        test.mock.restoreAll();
        if (fs.existsSync(marker)) {
          const recovery = JSON.parse(fs.readFileSync(marker, "utf8"));
          const recoveryRoot = path.join(backupRoot, recovery.recoveryDirectory);
          assert.match(recovery.recoveryDirectory, /^\.restore-stage-[a-f0-9-]+$/);
          fs.renameSync(storageRoot, path.join(recoveryRoot, "new-storage"));
          fs.renameSync(path.join(recoveryRoot, "previous-storage"), storageRoot);
          fs.unlinkSync(marker);
          fs.rmSync(recoveryRoot, { recursive: true });
        }
        db.prepare("UPDATE drivers SET name='Fixture' WHERE id=7").run();
        fs.writeFileSync(document, "original document");
      }
    });

    await t.test("a copied snapshot restores into a different checkout and rebases all local references", () => {
      const destination = path.join(workspace, "other-checkout");
      fs.mkdirSync(path.join(destination, "backups", "local"), { recursive: true });
      fs.cpSync(path.join(backupRoot, baseline.id), path.join(destination, "backups", "local", baseline.id), { recursive: true });
      fs.mkdirSync(path.join(destination, "data"));
      fs.writeFileSync(path.join(destination, "data", "dispatch.db"), "other-drive-sentinel");
      const code = `
        const assert = require("node:assert/strict");
        const fs = require("node:fs");
        const path = require("node:path");
        const project = process.env.DISPATCH_BACKUP_TEST_PROJECT;
        require(path.join(project, "tests", "register.cjs"));
        const backup = require(path.join(project, "lib", "backup.ts"));
        const { withDataLock } = require(path.join(project, "lib", "mutation-lock.ts"));
        (async () => {
          let db;
          try {
            const result = await withDataLock(() => backup.restoreBackup(process.env.DISPATCH_BACKUP_TEST_ID));
            db = require(path.join(project, "lib", "db.ts")).default;
            const folder = path.join(process.cwd(), "storage", "Fixture", "Loads", "Archived - Load #100");
            assert.equal(db.prepare("SELECT folder_ref FROM loads WHERE id=8").get().folder_ref, folder);
            assert.equal(db.prepare("SELECT storage_ref FROM files WHERE id=9").get().storage_ref, path.join(folder, "rate.txt"));
            assert.equal(fs.readFileSync(path.join(folder, "rate.txt"), "utf8"), "original document");
            assert.equal(result.safetyBackup.counts.loads, 0);
            assert.equal(fs.readFileSync(path.join(process.cwd(), "data", "dispatch.db"), "utf8"), "other-drive-sentinel");
          } finally { if (db && db.open) db.close(); }
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const result = spawnSync(process.execPath, ["-e", code], {
        cwd: destination,
        encoding: "utf8",
        env: { ...process.env, STORAGE_MODE: "local", DISPATCH_BACKUP_TEST_PROJECT: project, DISPATCH_BACKUP_TEST_ID: baseline.id },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
    });

    assert.equal(fs.readFileSync(driveDatabase, "utf8"), "untouched-drive-sentinel");
    assert.equal(fs.readFileSync(".env.local", "utf8"), "unused-credential-sentinel");
  } finally {
    if (db && db.open) db.close();
    if (originalMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = originalMode;
    process.chdir(originalCwd);
    assert.equal(path.dirname(workspace), path.join(project, "tests"));
    assert.ok(path.basename(workspace).startsWith(".backup-fixture-"));
    fs.rmSync(workspace, { recursive: true });
  }
});
