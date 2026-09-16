import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { RequestError } from "./api";
import { getDataPaths, getStorageMode } from "./config";
import { hasErrorCode } from "./errors";
import { FILE_CATEGORIES, LOAD_STATUSES, LOAD_TYPES } from "./models";

const FORMAT = "dispatch-dashboard-local-backup";
const VERSION = 1;
const DATABASE_FILE = "database.sqlite";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_HASH_FILE = "manifest.sha256";
const BACKUP_ID = /^local-\d{8}T\d{9}Z-[a-f0-9]{12}$/;
const STAGING_ID = /^\.(?:backup|restore)-stage-[a-f0-9-]{36}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const TABLES = ["drivers", "loads", "files"] as const;
type Table = typeof TABLES[number];
type Row = Record<string, unknown>;
type BackupReason = "manual" | "pre-restore";

export interface BackupCounts {
  drivers: number;
  loads: number;
  archivedLoads: number;
  documents: number;
  storedFiles: number;
  directories: number;
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  reason: BackupReason;
  counts: BackupCounts;
  sizeBytes: number;
}

export interface BackupListing {
  storage: "local";
  location: string;
  backups: BackupSummary[];
  warnings: string[];
}

export interface RestoreResult {
  restoredBackupId: string;
  safetyBackup: BackupSummary;
  warnings: string[];
}

interface InventoryFile {
  path: string;
  size: number;
  sha256: string;
}

interface Inventory {
  directories: string[];
  files: InventoryFile[];
}

interface Manifest extends BackupSummary {
  format: typeof FORMAT;
  version: typeof VERSION;
  schemaVersion: 1;
  storage: "local";
  sourceStorageRoot: string;
  sourcePathStyle: "win32" | "posix";
  database: { filename: typeof DATABASE_FILE; size: number; sha256: string };
  inventory: Inventory;
}

interface Dataset {
  drivers: Row[];
  loads: Row[];
  files: Row[];
  sequences: { name: Table; seq: number }[];
}

// These are the only columns restored. No SQL from a backup is executed.
const COLUMNS: Record<Table, Record<string, [string, number]>> = {
  drivers: {
    id: ["INTEGER", 0], name: ["TEXT", 1], phone: ["TEXT", 0],
    truck: ["TEXT", 0], created_at: ["TEXT", 1],
  },
  loads: {
    id: ["INTEGER", 0], load_number: ["TEXT", 1], load_type: ["TEXT", 1],
    driver_id: ["INTEGER", 1], pickup_city: ["TEXT", 1], delivery_city: ["TEXT", 1],
    pickup_date: ["TEXT", 1], delivery_date: ["TEXT", 1], rate_amount: ["REAL", 1],
    status: ["TEXT", 1], folder_ref: ["TEXT", 0], notes: ["TEXT", 0],
    created_at: ["TEXT", 1], archived_at: ["TEXT", 0], invoice_due_date: ["TEXT", 1],
  },
  files: {
    id: ["INTEGER", 0], load_id: ["INTEGER", 1], category: ["TEXT", 1],
    filename: ["TEXT", 1], storage_ref: ["TEXT", 1], web_link: ["TEXT", 0],
    size: ["INTEGER", 0], uploaded_at: ["TEXT", 1],
  },
};

function fail(message: string, status = 409): never {
  throw new RequestError(message, status);
}

function actionError(action: string, error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const access = ["EACCES", "EPERM", "EBUSY"].some((code) => hasErrorCode(error, code));
  return new RequestError(
    access
      ? `${action} failed because a file is locked or inaccessible. Close programs using local documents and check folder permissions, then retry.`
      : `${action} failed. Check free disk space, folder permissions, and the integrity of the local data, then retry.`,
    500
  );
}

export function assertLocalBackupsEnabled(): void {
  if (getStorageMode() !== "local") {
    fail("Backups and restores are available only in LOCAL storage mode. Google Drive data and credentials are not backed up.", 409);
  }
}

// The shared data lock should call this before business reads/writes as well.
// A process interruption or failed compensation must not expose a mixed dataset.
export function assertNoPendingLocalRestore(): void {
  if (getStorageMode() !== "local") return;
  try {
    if (statIfExists(getDataPaths().database + ".restore-recovery.json")) {
      fail("An interrupted local restore requires recovery. Stop all app servers and preserve the .restore-recovery.json marker, its named recovery folder, and safety backup before repairing the dataset.");
    }
  } catch (error) {
    throw actionError("Checking restore recovery", error);
  }
}

function statIfExists(filename: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function checkRegular(stat: fs.Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (!directory && stat.nlink !== 1)) {
    fail("Linked, reparse-point, hard-linked, or special files are not supported. Use regular local files and folders before backing up or restoring.");
  }
}

function checkWindowsAttributes(roots: string[], recursive = false): void {
  if (process.platform !== "win32" || roots.length === 0) return;
  // lstat detects symlinks/junctions, but not every Windows reparse-point type.
  // Pass paths as data, never interpolate document names into a shell command.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$paths = ConvertFrom-Json $env:DISPATCH_BACKUP_CHECK_PATHS",
    "$pending = New-Object 'System.Collections.Generic.Stack[string]'",
    "foreach ($item in $paths) { $pending.Push([string]$item) }",
    "while ($pending.Count -gt 0) {",
    "  $item = $pending.Pop()",
    "  $attributes = [System.IO.File]::GetAttributes($item)",
    "  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 37 }",
    recursive
      ? "  if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) { foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($item)) { $pending.Push($child) } }"
      : "",
    "}",
  ].join("\n");
  try {
    execFileSync(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, DISPATCH_BACKUP_CHECK_PATHS: JSON.stringify(roots) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
  } catch {
    fail("Windows filesystem safety checks failed. Linked/reparse-point paths are not supported; check folder access and Windows PowerShell availability.");
  }
}

function checkAncestors(targets: string[]): void {
  const checked = new Set<string>();
  for (const target of targets) {
    let current = path.resolve(target);
    while (!checked.has(current)) {
      const stat = statIfExists(current);
      if (stat) {
        checkRegular(stat, stat.isDirectory());
        checked.add(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  checkWindowsAttributes(Array.from(checked));
}

function localPaths() {
  assertLocalBackupsEnabled();
  assertNoPendingLocalRestore();
  const paths = getDataPaths();
  if (path.basename(paths.database) !== "dispatch-local.db" ||
      inside(paths.storage, paths.backups) || inside(paths.backups, paths.storage) ||
      samePath(paths.storage, paths.backups) || !inside(process.cwd(), paths.storage) ||
      !inside(process.cwd(), paths.backups) || !inside(paths.data, paths.database)) {
    fail("Local backup paths are unsafe. The local database, storage, and backup directories must be separate project-owned paths.");
  }
  checkAncestors([
    paths.database, paths.database + "-wal", paths.database + "-shm",
    paths.database + "-journal",
    paths.storage, paths.backups,
  ]);
  return paths;
}

async function liveDatabase(paths: ReturnType<typeof getDataPaths>): Promise<Database.Database> {
  // Do not import db before the mode/path checks: importing it opens a database.
  const loadedDatabase = await import("./db");
  if (!samePath(loadedDatabase.databasePath, paths.database) || !samePath(loadedDatabase.default.name, paths.database)) {
    fail("The open database does not match this LOCAL dataset. Restart the server in local mode before using backups.");
  }
  checkAncestors([paths.database, paths.database + "-wal", paths.database + "-shm", paths.database + "-journal"]);
  return loadedDatabase.default;
}

function validPart(part: string): boolean {
  return Boolean(part) && part !== "." && part !== ".." &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part);
}

function portableParts(value: unknown): string[] {
  if (typeof value !== "string" || !value || value.length > 32760) {
    fail("The backup contains an invalid document path.");
  }
  const parts = value.split("/");
  if (!parts.every(validPart)) fail("The backup contains an escaping or unsupported document path.");
  return parts;
}

function documentPath(root: string, relative: string): string {
  const target = path.join(root, ...portableParts(relative));
  if (!inside(root, target)) fail("A document path is outside the local storage folder.");
  return target;
}

function unchanged(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function digestFile(filename: string, copyTo?: string): { size: number; sha256: string } {
  const before = fs.lstatSync(filename);
  checkRegular(before, false);
  if (!Number.isSafeInteger(before.size) || before.size < 0) fail("A document is too large to back up safely.");
  let source: number | undefined;
  let destination: number | undefined;
  try {
    source = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!unchanged(before, fs.fstatSync(source))) fail("A document changed while it was being backed up. Stop external file changes and retry.");
    if (copyTo) destination = fs.openSync(copyTo, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const length = fs.readSync(source, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
      if (destination !== undefined) {
        let written = 0;
        while (written < length) {
          const count = fs.writeSync(destination, buffer, written, length - written);
          if (count === 0) fail("An incomplete document copy was detected.");
          written += count;
        }
      }
      size += length;
    }
    if (size !== before.size || !unchanged(before, fs.fstatSync(source)) ||
        !unchanged(before, fs.lstatSync(filename))) {
      fail("A document changed while it was being backed up. Stop external file changes and retry.");
    }
    if (destination !== undefined) fs.fsyncSync(destination);
    return { size, sha256: hash.digest("hex") };
  } finally {
    if (destination !== undefined) fs.closeSync(destination);
    if (source !== undefined) fs.closeSync(source);
  }
}

function scanTree(root: string, copyTo?: string, hashFiles = true): Inventory {
  const rootStat = fs.lstatSync(root);
  checkRegular(rootStat, true);
  checkWindowsAttributes([root], true);
  if (copyTo) fs.mkdirSync(copyTo, { mode: 0o700 });
  const inventory: Inventory = { directories: [], files: [] };
  const keys = new Set<string>();
  function visit(folder: string, parts: string[]) {
    const before = fs.lstatSync(folder);
    checkRegular(before, true);
    if (!samePath(fs.realpathSync.native(folder), folder)) fail("Linked storage paths are not supported.");
    for (const name of fs.readdirSync(folder).sort()) {
      if (!validPart(name)) fail("A local document name is not portable or safe. Rename unsupported files before backing up.");
      const entryParts = [...parts, name];
      const relative = entryParts.join("/");
      const key = relative.toLowerCase();
      if (keys.has(key)) fail("Document names collide on Windows. Rename case-only duplicates before backing up.");
      keys.add(key);
      const filename = path.join(folder, name);
      const stat = fs.lstatSync(filename);
      checkRegular(stat, stat.isDirectory());
      if (stat.isDirectory()) {
        inventory.directories.push(relative);
        if (copyTo) fs.mkdirSync(path.join(copyTo, ...entryParts), { mode: 0o700 });
        visit(filename, entryParts);
      } else {
        const info = hashFiles || copyTo
          ? digestFile(filename, copyTo ? path.join(copyTo, ...entryParts) : undefined)
          : { size: stat.size, sha256: "" };
        inventory.files.push({ path: relative, ...info });
      }
    }
    const after = fs.lstatSync(folder);
    if (before.ino !== after.ino || before.dev !== after.dev ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("A storage folder changed during backup validation. Stop external file changes and retry.");
    }
  }
  visit(root, []);
  return inventory;
}

function compareInventory(expected: Inventory, actual: Inventory, hashes: boolean): void {
  if (expected.directories.length !== actual.directories.length || expected.files.length !== actual.files.length) {
    fail("The backup document inventory is incomplete or contains unexpected entries.");
  }
  const directories = new Set(actual.directories);
  if (expected.directories.some((name) => !directories.has(name))) fail("A backed-up document folder is missing.");
  const files = new Map(actual.files.map((file) => [file.path, file]));
  for (const file of expected.files) {
    const actualFile = files.get(file.path);
    if (!actualFile || actualFile.size !== file.size || (hashes && actualFile.sha256 !== file.sha256)) {
      fail("A backed-up document is missing or failed its SHA256 integrity check. No local data was replaced.");
    }
  }
}

function validateSchema(database: Database.Database): void {
  database.pragma("trusted_schema = OFF");
  if (database.pragma("user_version", { simple: true }) !== 1) fail("The backup database schema version is not supported.");
  const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all() as Row[];
  for (const object of objects) {
    const table = String(object.tbl_name);
    if (object.type === "table" && (TABLES.includes(table as Table) || table === "sqlite_sequence") &&
        typeof object.sql === "string" && /^CREATE TABLE\b/i.test(object.sql.trim())) continue;
    if (object.type === "index" && TABLES.includes(table as Table)) continue;
    fail("The local database contains an unsupported table, view, trigger, or virtual schema object.");
  }
  for (const table of TABLES) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all() as Row[];
    const expected = COLUMNS[table];
    if (columns.length !== Object.keys(expected).length) fail("The local database table schema is incompatible with this backup format.");
    for (const column of columns) {
      const specification = expected[String(column.name)];
      if (!specification || String(column.type).toUpperCase() !== specification[0] ||
          column.notnull !== specification[1] || column.pk !== (column.name === "id" ? 1 : 0) ||
          column.hidden !== 0) fail("The local database table schema is incompatible with this backup format.");
    }
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Row[];
    if (table === "drivers") {
      if (foreignKeys.length) fail("The database has incompatible relationships.");
    } else {
      const key = foreignKeys[0];
      if (foreignKeys.length !== 1 || key.from !== (table === "loads" ? "driver_id" : "load_id") ||
          key.table !== (table === "loads" ? "drivers" : "loads") || key.to !== "id" ||
          key.on_delete !== (table === "loads" ? "NO ACTION" : "CASCADE") || key.on_update !== "NO ACTION") {
        fail("The database has incompatible relationships.");
      }
    }
    if (table !== "files") {
      const expectedNames = table === "drivers" ? ["name"] : ["load_number", "load_type"];
      const indexes = database.prepare("SELECT name FROM pragma_index_list(?) WHERE \"unique\" = 1 AND partial = 0").all(table) as { name: string }[];
      const valid = indexes.some((index) => {
        const columns = database.prepare("SELECT name, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(index.name) as { name: string; coll: string }[];
        return columns.length === expectedNames.length && columns.every((column, i) =>
          column.name === expectedNames[i] && column.coll === "BINARY");
      });
      if (!valid) fail("The database is missing a required uniqueness constraint.");
    }
  }
  const integrity = database.pragma("integrity_check") as Row[];
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" ||
      (database.pragma("foreign_key_check") as Row[]).length !== 0) {
    fail("The local database failed SQLite integrity or relationship checks. Repair it before backing up or restoring.");
  }
}

function readDataset(database: Database.Database): Dataset {
  validateSchema(database);
  const dataset = { drivers: [], loads: [], files: [], sequences: [] } as Dataset;
  for (const table of TABLES) {
    dataset[table] = database.prepare(`SELECT ${Object.keys(COLUMNS[table]).join(", ")} FROM ${table} ORDER BY id`).all() as Row[];
    for (const row of dataset[table]) {
      for (const [name, [type, required]] of Object.entries(COLUMNS[table])) {
        const value = row[name];
        if (value === null && !required && name !== "id") continue;
        if (type === "TEXT" ? typeof value !== "string"
          : typeof value !== "number" || !Number.isFinite(value) ||
            (type === "INTEGER" && !Number.isSafeInteger(value))) {
          fail("The database contains unsupported or damaged record values.");
        }
      }
      if ((row.id as number) < 1 || ("driver_id" in row && (row.driver_id as number) < 1) ||
          ("load_id" in row && (row.load_id as number) < 1) ||
          ("size" in row && row.size !== null && (row.size as number) < 0)) {
        fail("The database contains invalid identifiers or document sizes.");
      }
    }
  }
  if (dataset.loads.some((row) => !LOAD_TYPES.includes(row.load_type as typeof LOAD_TYPES[number]) ||
      !LOAD_STATUSES.includes(row.status as typeof LOAD_STATUSES[number])) ||
      dataset.files.some((row) => !FILE_CATEGORIES.includes(row.category as typeof FILE_CATEGORIES[number]))) {
    fail("The database contains load types, statuses, or document categories not supported by this app version.");
  }
  const sequences = database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all() as Row[];
  const names = new Set<string>();
  for (const row of sequences) {
    if (typeof row.name !== "string" || !TABLES.includes(row.name as Table) ||
        names.has(row.name) || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 0) {
      fail("The database contains an invalid SQLite sequence.");
    }
    const table = row.name as Table;
    if (dataset[table].some((record) => (record.id as number) > (row.seq as number))) {
      fail("The database identifier sequence is inconsistent.");
    }
    names.add(row.name);
    dataset.sequences.push({ name: table, seq: row.seq });
  }
  if (TABLES.some((table) => dataset[table].length > 0 && !names.has(table))) fail("A database identifier sequence is missing.");
  return dataset;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countValue(value: unknown): number {
  if (!nonnegativeInteger(value)) fail("This backup has invalid record counts.");
  return value;
}

function validateSourceRoot(manifest: Pick<Manifest, "sourcePathStyle" | "sourceStorageRoot">): void {
  if ((manifest.sourcePathStyle !== "win32" && manifest.sourcePathStyle !== "posix") ||
      typeof manifest.sourceStorageRoot !== "string" || /[\x00-\x1f]/.test(manifest.sourceStorageRoot)) {
    fail("The backup source storage root is invalid.");
  }
  const api = manifest.sourcePathStyle === "win32" ? path.win32 : path.posix;
  const root = manifest.sourceStorageRoot;
  if (!api.isAbsolute(root) || api.parse(root).root === api.normalize(root) ||
      (manifest.sourcePathStyle === "win32" && (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(root) || /^\\\\[?.]\\/.test(root)))) {
    fail("The backup source storage root is not a supported absolute path.");
  }
}

function manifestFrom(value: unknown, id: string): Manifest {
  if (!record(value) || value.format !== FORMAT || value.version !== VERSION ||
      value.schemaVersion !== 1 || value.storage !== "local" || value.id !== id ||
      (value.reason !== "manual" && value.reason !== "pre-restore") ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      !record(value.database) || value.database.filename !== DATABASE_FILE ||
      !nonnegativeInteger(value.database.size) || typeof value.database.sha256 !== "string" ||
      !SHA256.test(value.database.sha256) || !record(value.inventory) ||
      !Array.isArray(value.inventory.directories) || !Array.isArray(value.inventory.files) ||
      !record(value.counts) || !nonnegativeInteger(value.sizeBytes) ||
      typeof value.sourceStorageRoot !== "string" ||
      (value.sourcePathStyle !== "win32" && value.sourcePathStyle !== "posix")) {
    fail("This backup has an invalid or unsupported manifest.");
  }
  const manifest: Manifest = {
    format: FORMAT, version: VERSION, schemaVersion: 1, storage: "local",
    id, createdAt: value.createdAt, reason: value.reason,
    sourceStorageRoot: value.sourceStorageRoot, sourcePathStyle: value.sourcePathStyle,
    database: { filename: DATABASE_FILE, size: value.database.size, sha256: value.database.sha256 },
    inventory: { directories: [], files: [] },
    counts: {
      drivers: countValue(value.counts.drivers), loads: countValue(value.counts.loads),
      archivedLoads: countValue(value.counts.archivedLoads), documents: countValue(value.counts.documents),
      storedFiles: countValue(value.counts.storedFiles), directories: countValue(value.counts.directories),
    },
    sizeBytes: value.sizeBytes,
  };
  validateSourceRoot(manifest);
  const keys = new Set<string>();
  const directories = new Set<string>();
  for (const entry of value.inventory.directories) {
    const parts = portableParts(entry);
    const key = parts.join("/").toLowerCase();
    if (keys.has(key)) fail("The backup contains colliding document paths.");
    keys.add(key);
    directories.add(key);
    manifest.inventory.directories.push(parts.join("/"));
  }
  let sizeBytes = manifest.database.size;
  for (const entry of value.inventory.files) {
    if (!record(entry) || !nonnegativeInteger(entry.size) || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      fail("The backup has an invalid document inventory.");
    }
    const relative = portableParts(entry.path).join("/");
    const key = relative.toLowerCase();
    if (keys.has(key)) fail("The backup contains colliding document paths.");
    keys.add(key);
    sizeBytes += entry.size;
    manifest.inventory.files.push({ path: relative, size: entry.size, sha256: entry.sha256 });
  }
  for (const key of Array.from(keys)) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length++) {
      if (!directories.has(parts.slice(0, length).join("/"))) fail("The backup is missing a parent document folder.");
    }
  }
  if (!Number.isSafeInteger(sizeBytes) || manifest.sizeBytes !== sizeBytes ||
      manifest.counts.storedFiles !== manifest.inventory.files.length ||
      manifest.counts.directories !== manifest.inventory.directories.length ||
      manifest.counts.archivedLoads > manifest.counts.loads) {
    fail("The backup manifest inventory totals do not match.");
  }
  return manifest;
}

function referencePath(ref: unknown, manifest: Pick<Manifest, "sourceStorageRoot" | "sourcePathStyle">): string {
  if (typeof ref !== "string" || !ref || /[\x00-\x1f]/.test(ref)) fail("A stored document reference is invalid.");
  const api = manifest.sourcePathStyle === "win32" ? path.win32 : path.posix;
  if (!api.isAbsolute(ref)) fail("A stored document reference is not an absolute local path.");
  const relative = api.relative(manifest.sourceStorageRoot, ref);
  if (!relative || relative === ".." || relative.startsWith(".." + api.sep) || api.isAbsolute(relative)) {
    fail("A stored document or folder reference is outside its source storage folder. Repair external references before backing up or restoring.");
  }
  return portableParts(relative.split(api.sep).join("/")).join("/");
}

function checkReferences(dataset: Dataset, manifest: Pick<Manifest, "sourceStorageRoot" | "sourcePathStyle" | "inventory">, targetRoot?: string): void {
  validateSourceRoot(manifest);
  const key = (name: string) => manifest.sourcePathStyle === "win32" ? name.toLowerCase() : name;
  const directories = new Map(manifest.inventory.directories.map((name) => [key(name), name]));
  const files = new Map(manifest.inventory.files.map((file) => [key(file.path), file.path]));
  for (const row of dataset.loads) {
    if (row.folder_ref === null || row.folder_ref === "") continue;
    const relative = directories.get(key(referencePath(row.folder_ref, manifest)));
    if (!relative) fail("A tracked local load folder is missing. Repair the current dataset or choose a complete backup; no data was replaced.");
    if (targetRoot) row.folder_ref = documentPath(targetRoot, relative);
  }
  for (const row of dataset.files) {
    const relative = files.get(key(referencePath(row.storage_ref, manifest)));
    if (!relative) fail("A tracked local document is missing. Repair the current dataset or choose a complete backup; no data was replaced.");
    if (targetRoot) row.storage_ref = documentPath(targetRoot, relative);
  }
}

function countsFor(dataset: Dataset, inventory: Inventory): BackupCounts {
  return {
    drivers: dataset.drivers.length,
    loads: dataset.loads.length,
    archivedLoads: dataset.loads.filter((load) => load.archived_at !== null).length,
    documents: dataset.files.length,
    storedFiles: inventory.files.length,
    directories: inventory.directories.length,
  };
}

function summaryFor(manifest: Manifest): BackupSummary {
  return {
    id: manifest.id, createdAt: manifest.createdAt, reason: manifest.reason,
    counts: manifest.counts, sizeBytes: manifest.sizeBytes,
  };
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || !BACKUP_ID.test(id)) fail("Invalid backup ID.", 400);
  return id;
}

function readSmallFile(filename: string, limit: number): Buffer {
  const stat = fs.lstatSync(filename);
  checkRegular(stat, false);
  if (stat.size > limit) fail("The backup metadata is too large or damaged.");
  return fs.readFileSync(filename);
}

function readManifest(folder: string, id: string): Manifest {
  const stat = statIfExists(folder);
  if (!stat) fail("Backup not found.", 404);
  checkRegular(stat, true);
  checkAncestors([folder]);
  const expected = [DATABASE_FILE, MANIFEST_FILE, MANIFEST_HASH_FILE, "storage"].sort();
  const actual = fs.readdirSync(folder).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("The backup directory is incomplete or contains unexpected files.");
  checkWindowsAttributes([folder], true);
  const bytes = readSmallFile(path.join(folder, MANIFEST_FILE), MAX_MANIFEST_BYTES);
  const checksum = readSmallFile(path.join(folder, MANIFEST_HASH_FILE), 65).toString("utf8").trim();
  if (!SHA256.test(checksum) || createHash("sha256").update(bytes).digest("hex") !== checksum) {
    fail("The backup manifest failed its SHA256 integrity check.");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("The backup manifest is not valid JSON.");
  }
  return manifestFrom(value, id);
}

function verifyBackup(folder: string, id: string, full: boolean): { manifest: Manifest; dataset?: Dataset } {
  const manifest = readManifest(folder, id);
  const filename = path.join(folder, DATABASE_FILE);
  const stat = fs.lstatSync(filename);
  checkRegular(stat, false);
  if (stat.size !== manifest.database.size || (full && digestFile(filename).sha256 !== manifest.database.sha256)) {
    fail("The backup database failed its SHA256 integrity check.");
  }
  compareInventory(manifest.inventory, scanTree(path.join(folder, "storage"), undefined, full), full);
  if (!full) return { manifest };
  const header = Buffer.alloc(100);
  const descriptor = fs.openSync(filename, "r");
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length ||
        header.subarray(0, 16).toString("binary") !== "SQLite format 3\x00" || header[18] !== 1 || header[19] !== 1) {
      fail("The backup database is not a complete standalone SQLite snapshot.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let database: Database.Database | undefined;
  try {
    database = new Database(filename, { readonly: true, fileMustExist: true });
    database.pragma("query_only = ON");
    if (database.pragma("journal_mode", { simple: true }) !== "delete") fail("The backup database is not a complete standalone SQLite snapshot.");
    const dataset = readDataset(database);
    checkReferences(dataset, manifest);
    const counts = countsFor(dataset, manifest.inventory);
    if (Object.keys(counts).some((key) => counts[key as keyof BackupCounts] !== manifest.counts[key as keyof BackupCounts])) {
      fail("The backup database does not match its manifest counts.");
    }
    return { manifest, dataset };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("The backup database is unreadable, damaged, or incompatible. Check access or choose a complete compatible backup; no local data was replaced.", 409);
  } finally {
    if (database) database.close();
  }
}

function writeDurable(filename: string, content: string): void {
  const descriptor = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnedStage(folder: string, root: string): void {
  if (!samePath(path.dirname(folder), root) || !STAGING_ID.test(path.basename(folder))) {
    fail("Refusing to remove an unrecognized recovery directory.");
  }
  if (!statIfExists(folder)) return;
  checkAncestors([folder]);
  checkWindowsAttributes([folder], true);
  fs.rmSync(folder, { recursive: true });
}

/** Caller must hold withDataLock for the entire operation. */
export async function listBackups(): Promise<BackupListing> {
  try {
    const paths = localPaths();
    const listing: BackupListing = { storage: "local", location: paths.backups, backups: [], warnings: [] };
    const stat = statIfExists(paths.backups);
    if (!stat) return listing;
    checkRegular(stat, true);
    for (const name of fs.readdirSync(paths.backups).sort().reverse()) {
      if (STAGING_ID.test(name)) {
        listing.warnings.push(`Unfinished staging/recovery material is present (${name}). It is not a usable backup; preserve it if a restore needs recovery.`);
        continue;
      }
      if (!BACKUP_ID.test(name)) continue;
      try {
        const { manifest } = verifyBackup(path.join(paths.backups, name), name, false);
        listing.backups.push(summaryFor(manifest));
      } catch {
        listing.warnings.push(`Backup ${name} is incomplete, inaccessible, or incompatible and was not listed. Its files were left untouched.`);
      }
    }
    return listing;
  } catch (error) {
    throw actionError("Listing backups", error);
  }
}

/** Caller must hold withDataLock; restore uses this without reacquiring the lock. */
export async function createBackup(reason: BackupReason = "manual"): Promise<BackupSummary> {
  let stage: string | undefined;
  let root: string | undefined;
  try {
    const paths = localPaths();
    root = paths.backups;
    if (reason !== "manual" && reason !== "pre-restore") fail("Invalid backup reason.", 400);
    const database = await liveDatabase(paths);
    validateSchema(database);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    checkAncestors([root]);
    const createdAt = new Date().toISOString();
    const id = `local-${createdAt.replace(/[-:.]/g, "")}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    validateId(id);
    stage = path.join(root, `.backup-stage-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const snapshotPath = path.join(stage, DATABASE_FILE);
    await database.backup(snapshotPath);
    const snapshot = new Database(snapshotPath, { fileMustExist: true });
    let dataset: Dataset;
    try {
      snapshot.pragma("journal_mode = DELETE");
      dataset = readDataset(snapshot);
    } finally {
      snapshot.close();
    }
    const documentRoot = path.join(stage, "storage");
    let inventory: Inventory;
    const storageStat = statIfExists(paths.storage);
    if (storageStat) {
      checkRegular(storageStat, true);
      inventory = scanTree(paths.storage, documentRoot);
    } else {
      fs.mkdirSync(documentRoot, { mode: 0o700 });
      inventory = { directories: [], files: [] };
    }
    const source = {
      sourceStorageRoot: path.resolve(paths.storage),
      sourcePathStyle: process.platform === "win32" ? "win32" as const : "posix" as const,
      inventory,
    };
    checkReferences(dataset, source);
    const databaseInfo = digestFile(snapshotPath);
    const sizeBytes = inventory.files.reduce((size, file) => size + file.size, databaseInfo.size);
    if (!Number.isSafeInteger(sizeBytes)) fail("The dataset is too large to back up safely.");
    const manifest: Manifest = {
      format: FORMAT, version: VERSION, schemaVersion: 1, storage: "local",
      id, createdAt, reason, ...source,
      counts: countsFor(dataset, inventory), sizeBytes,
      database: { filename: DATABASE_FILE, ...databaseInfo },
    };
    const serialized = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) fail("The backup inventory is too large for this backup format.");
    writeDurable(path.join(stage, MANIFEST_FILE), serialized);
    writeDurable(path.join(stage, MANIFEST_HASH_FILE), createHash("sha256").update(serialized).digest("hex") + "\n");
    verifyBackup(stage, id, true);
    const destination = path.join(root, id);
    if (statIfExists(destination)) fail("A backup with this ID already exists. Retry to generate a new ID.");
    fs.renameSync(stage, destination);
    stage = undefined;
    return summaryFor(manifest);
  } catch (error) {
    if (stage && root) {
      try {
        removeOwnedStage(stage, root);
      } catch {
        fail(`Backup failed and its incomplete staging directory (${path.basename(stage)}) could not be removed. It was not published. Close open files and preserve recovery material until the failure is resolved.`, 500);
      }
    }
    throw actionError("Creating the local backup", error);
  }
}

function replaceRows(database: Database.Database, dataset: Dataset): void {
  database.prepare("DELETE FROM files").run();
  database.prepare("DELETE FROM loads").run();
  database.prepare("DELETE FROM drivers").run();
  for (const table of TABLES) {
    const columns = Object.keys(COLUMNS[table]);
    const insert = database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of dataset[table]) insert.run(...columns.map((column) => row[column]));
  }
  database.prepare("DELETE FROM sqlite_sequence WHERE name IN ('drivers', 'loads', 'files')").run();
  const insertSequence = database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)");
  for (const sequence of dataset.sequences) insertSequence.run(sequence.name, sequence.seq);
  if ((database.pragma("foreign_key_check") as Row[]).length) fail("Restored database relationships failed validation.");
}

/** Caller must hold withDataLock from validation through the last storage swap. */
export async function restoreBackup(value: unknown): Promise<RestoreResult> {
  let stage: string | undefined;
  let root: string | undefined;
  let preserveStage = false;
  let markerOwned = false;
  let marker: string | undefined;
  let changeAttempted = false;
  try {
    const paths = localPaths();
    root = paths.backups;
    const id = validateId(value);
    const { manifest, dataset } = verifyBackup(path.join(root, id), id, true);
    if (!dataset) fail("The backup database could not be validated.");
    checkReferences(dataset, manifest, paths.storage);
    stage = path.join(root, `.restore-stage-${randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const newStorage = path.join(stage, "new-storage");
    const oldStorage = path.join(stage, "previous-storage");
    compareInventory(manifest.inventory, scanTree(path.join(root, id, "storage"), newStorage), true);
    let safetyBackup: BackupSummary;
    try {
      safetyBackup = await createBackup("pre-restore");
    } catch (error) {
      const detail = actionError("Creating the safety backup", error);
      fail(`Restore stopped before replacing any local data because a complete safety backup could not be made. Repair missing/inaccessible current documents or database damage first. ${detail.message}`, detail.status);
    }
    const database = await liveDatabase(paths);
    const originalDataset = JSON.stringify(readDataset(database));
    checkAncestors([paths.storage, stage]);
    compareInventory(manifest.inventory, scanTree(newStorage), true);
    if (fs.statSync(stage).dev !== fs.statSync(path.dirname(paths.storage)).dev) {
      fail("Restore staging and local storage must be on the same filesystem. No local data was replaced.");
    }
    const hadStorage = Boolean(statIfExists(paths.storage));
    marker = paths.database + ".restore-recovery.json";
    const recovery = {
      version: 1, phase: "prepared", createdAt: new Date().toISOString(),
      recoveryDirectory: path.basename(stage), originalStorageExisted: hadStorage,
      restoredBackupId: id, safetyBackupId: safetyBackup.id,
    };
    const markerDescriptor = fs.openSync(marker, "wx", 0o600);
    markerOwned = true;
    try {
      fs.writeFileSync(markerDescriptor, JSON.stringify(recovery, null, 2) + "\n");
      fs.fsyncSync(markerDescriptor);
    } finally {
      fs.closeSync(markerDescriptor);
    }
    let oldMoved = false;
    let newInstalled = false;
    try {
      // Begin the SQLite write transaction before moving documents. Everything
      // through commit/compensation is synchronous while the outer lock is held.
      changeAttempted = true;
      database.transaction(() => {
        if (hadStorage) {
          fs.renameSync(paths.storage, oldStorage);
          oldMoved = true;
        }
        if (statIfExists(paths.storage)) fail("The storage destination changed during restore.");
        fs.renameSync(newStorage, paths.storage);
        newInstalled = true;
        replaceRows(database, dataset);
      }).immediate();
    } catch (error) {
      try {
        if (database.inTransaction) database.exec("ROLLBACK");
        if (JSON.stringify(readDataset(database)) !== originalDataset) {
          fail("The database rollback could not be verified.");
        }
        if (newInstalled) {
          if (statIfExists(newStorage)) fail("The restore staging destination changed.");
          fs.renameSync(paths.storage, newStorage);
          newInstalled = false;
        }
        if (oldMoved) {
          if (statIfExists(paths.storage)) fail("The original storage destination is occupied.");
          fs.renameSync(oldStorage, paths.storage);
          oldMoved = false;
        }
      } catch {
        preserveStage = true;
        fail(`Restore failed and rollback could not be completed and verified. Stop all app servers. Preserve ${path.basename(stage)}, the .restore-recovery.json marker, and safety backup ${safetyBackup.id}. Repair the database/document pairing before using the app.`, 500);
      }
      try {
        fs.unlinkSync(marker);
        markerOwned = false;
      } catch {
        preserveStage = true;
        fail(`Restore did not commit and the original database and documents were recovered, but the recovery marker could not be cleared. Stop all app servers and preserve ${recovery.recoveryDirectory} and safety backup ${safetyBackup.id} until the marker is resolved.`, 500);
      }
      const detail = actionError("Restoring local data", error);
      fail(`Restore failed; the original local database and documents were kept. Safety backup ${safetyBackup.id} is available. ${detail.message}`, detail.status);
    }
    const warnings: string[] = [];
    try {
      const committedMarker = path.join(stage, "committed-recovery.json");
      writeDurable(committedMarker, JSON.stringify({ ...recovery, phase: "committed" }, null, 2) + "\n");
      fs.renameSync(committedMarker, marker);
    } catch {
      warnings.push("The restore committed, but its recovery marker could not be updated. Keep the safety backup.");
    }
    try {
      removeOwnedStage(stage, root);
      stage = undefined;
    } catch {
      warnings.push(`Restore completed, but old documents remain in recovery directory ${recovery.recoveryDirectory}. The safety backup is also retained; close open files before cleaning that specific recovery directory.`);
      preserveStage = true;
    }
    try {
      fs.unlinkSync(marker);
      markerOwned = false;
    } catch {
      warnings.push("Restore completed, but its .restore-recovery.json marker could not be removed. Stop the server and resolve the committed recovery marker before continuing to use the dataset.");
    }
    return { restoredBackupId: id, safetyBackup, warnings };
  } catch (error) {
    if (markerOwned && marker && !changeAttempted) {
      try {
        fs.unlinkSync(marker);
        markerOwned = false;
      } catch {
        preserveStage = true;
        fail("Restore stopped before changing local data, but its recovery marker could not be removed. Stop all app servers and preserve the marker and its named staging directory until access is repaired.", 500);
      }
    }
    if (markerOwned) preserveStage = true;
    if (stage && root && !preserveStage) {
      try {
        removeOwnedStage(stage, root);
      } catch {
        fail(`Restore stopped. Its staging directory (${path.basename(stage)}) could not be removed; preserve it and close open files before retrying. No backup was deleted.`, 500);
      }
    }
    throw actionError("Restoring the local backup", error);
  }
}
