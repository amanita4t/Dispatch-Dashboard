require("./register.cjs");
const assert = require("node:assert/strict");
const { test, after, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const originalCwd = process.cwd();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-regression-"));
process.chdir(workspace);
process.env.STORAGE_MODE = "local";
fs.mkdirSync("data");
fs.writeFileSync(path.join("data", "dispatch.db"), "preserved-drive-database");
const old = new Database(path.join("data", "dispatch-local.db"));
old.exec(`
  CREATE TABLE drivers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', truck TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE loads (id INTEGER PRIMARY KEY AUTOINCREMENT, load_number TEXT NOT NULL, load_type TEXT NOT NULL DEFAULT 'load', driver_id INTEGER NOT NULL REFERENCES drivers(id), pickup_city TEXT NOT NULL, delivery_city TEXT NOT NULL, pickup_date TEXT NOT NULL, delivery_date TEXT NOT NULL, rate_amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', folder_ref TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(load_number,load_type));
  INSERT INTO drivers(name) VALUES ('Existing Driver');
  INSERT INTO loads(load_number,driver_id,pickup_city,delivery_city,pickup_date,delivery_date,rate_amount) VALUES('EXISTING',1,'A','B','2026-09-01','2026-09-02',1250);
`);
old.close();

const db = require("../lib/db.ts").default;
const { getStorage, loadFolderName, sanitizeName } = require("../lib/storage.ts");
const { withDataLock } = require("../lib/mutation-lock.ts");
const { todayLocal, overdueLabel } = require("../lib/dates.ts");
const routes = {
  drivers: require("../app/api/drivers/route.ts"),
  driver: require("../app/api/drivers/[id]/route.ts"),
  loads: require("../app/api/loads/route.ts"),
  load: require("../app/api/loads/[id]/route.ts"),
  archive: require("../app/api/loads/[id]/archive/route.ts"),
  upload: require("../app/api/loads/[id]/files/route.ts"),
  file: require("../app/api/files/[id]/route.ts"),
  sync: require("../app/api/sync/route.ts"),
};

async function call(route, method, { id = 1, body, query = "" } = {}) {
  const options = { method };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { "Content-Type": "application/json" };
  }
  const response = await routes[route][method](new Request("http://localhost/api?" + query, options), { params: { id: String(id) } });
  const content = await response.text();
  return {
    status: response.status,
    data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(content) : content,
  };
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

afterEach(() => {
  db.exec("DROP TRIGGER IF EXISTS reject_load; DROP TRIGGER IF EXISTS reject_edit; DELETE FROM files; DELETE FROM loads; DELETE FROM drivers");
  const storage = path.join(workspace, "storage");
  if (fs.existsSync(storage)) {
    for (const entry of fs.readdirSync(storage)) fs.rmSync(path.join(storage, entry), { recursive: true });
  }
  assert.equal(fs.readFileSync(path.join(workspace, "data", "dispatch.db"), "utf8"), "preserved-drive-database");
});

after(() => {
  db.close();
  process.chdir(originalCwd);
  assert.equal(path.dirname(workspace), os.tmpdir());
  assert.ok(path.basename(workspace).startsWith("dispatch-regression-"));
  fs.rmSync(workspace, { recursive: true });
});

test("additive migrations preserve existing records and add archive/due-date fields", () => {
  const row = db.prepare("SELECT * FROM loads").get();
  assert.equal(row.load_number, "EXISTING");
  assert.equal(row.rate_amount, 1250);
  assert.equal(row.archived_at, null);
  assert.equal(row.invoice_due_date, "");
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loads").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads", "Load #100")), false);
});

test("database failure after uploading rolls back files and the load folder", async (t) => {
  t.mock.method(console, "error", () => {});
  const id = await driver();
  db.exec("CREATE TRIGGER reject_load BEFORE INSERT ON loads BEGIN SELECT RAISE(ABORT,'forced database failure'); END");
  const result = await call("loads", "POST", { body: form(id) });
  assert.equal(result.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
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
  assert.equal((await call("upload", "POST", { body: {} })).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loads").get().n, 0);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loads").get().n, 1);
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

test("database edit failure rolls back physical archive and document paths", async (t) => {
  t.mock.method(console, "error", () => {});
  const item = await load(await driver());
  db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE ON loads BEGIN SELECT RAISE(ABORT,'forced edit failure'); END");
  assert.equal((await call("archive", "POST", { id: item.id, body: { archived: true } })).status, 500);
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
    skippedExisting: 0, skippedArchived: 0, errors: [],
  });
  const drivers = db.prepare("SELECT * FROM drivers ORDER BY id").all();
  assert.deepEqual(drivers.map((item) => item.name).sort(), ["New Driver", "Williams"]);
  for (const item of drivers) {
    assert.equal(item.phone, "");
    assert.equal(item.truck, "");
  }
  for (const document of documents) {
    const item = db.prepare("SELECT * FROM loads WHERE load_number = ? AND load_type = ?").get(document.number, document.type);
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
  const loads = db.prepare("SELECT * FROM loads ORDER BY id").all();
  const files = db.prepare("SELECT * FROM files ORDER BY id").all();
  const repeated = await call("sync", "POST");
  assert.deepEqual(repeated.data, {
    driversScanned: 2, driversImported: 0, loadsImported: 0, loadsArchived: 0, filesImported: 0,
    skippedExisting: 4, skippedArchived: 0, errors: [],
  });
  assert.deepEqual(db.prepare("SELECT * FROM drivers ORDER BY id").all(), drivers);
  assert.deepEqual(db.prepare("SELECT * FROM loads ORDER BY id").all(), loads);
  assert.deepEqual(db.prepare("SELECT * FROM files ORDER BY id").all(), files);
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
  assert.equal(db.prepare("SELECT category FROM files WHERE storage_ref = ?").get(bol).category, "bol");
});

test("sync reuses the registered driver behind a sanitized folder name", async () => {
  const id = await driver("A/B");
  const document = manualLoad("A_B", ["Load #100"]);
  const result = await call("sync", "POST");
  assert.equal(result.data.driversImported, 0);
  assert.equal(result.data.loadsImported, 1);
  assert.deepEqual(result.data.errors, []);
  assert.equal(db.prepare("SELECT driver_id FROM loads").get().driver_id, id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM drivers").get().n, 1);
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
  assert.deepEqual(db.prepare("SELECT name FROM drivers ORDER BY name").all(), [{ name: "Allowed" }, { name: "Existing" }]);
  assert.deepEqual(db.prepare("SELECT load_number FROM loads").all(), [{ load_number: "200" }]);
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
  assert.deepEqual(db.prepare("SELECT name FROM drivers").all(), [{ name: "Valid" }]);
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
  assert.deepEqual(db.prepare("SELECT load_number FROM loads").all(), [{ load_number: "200" }]);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loads").get().n, 0);
  assert.equal(fs.existsSync(path.join(workspace, "storage", "Test Driver", "Loads")), false);
});

test("directly imported loads support uploads, archive, restore, and later reassignment", async () => {
  const documents = [manualLoad("Williams", ["Load #100"]), manualLoad("Williams", ["Loadout #200"])];
  await call("sync", "POST");
  const target = await driver("Reassigned");
  for (const document of documents) {
    const item = db.prepare("SELECT * FROM loads WHERE folder_ref = ?").get(document.folder);
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
    const { id } = db.prepare("SELECT id FROM loads WHERE folder_ref = ?").get(document.folder);
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
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 6);
  assert.equal(fs.readFileSync(keeper.file, "utf8"), "manual rate content");
  const archived = db.prepare("SELECT id, archived_at FROM loads ORDER BY id").all();
  const repeated = await call("sync", "POST");
  assert.equal(repeated.data.loadsArchived, 0);
  assert.deepEqual(repeated.data.errors, []);
  assert.deepEqual(db.prepare("SELECT id, archived_at FROM loads ORDER BY id").all(), archived);
});

test("missing-folder loads cannot be restored until their folder is recovered and never reactivate through sync", async () => {
  const document = manualLoad("Driver", ["Load #100"]);
  await call("sync", "POST");
  const { id } = db.prepare("SELECT id FROM loads").get();
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
  db.prepare("UPDATE loads SET folder_ref = '' WHERE id = ?").run(unlinked.id);
  db.exec("CREATE TRIGGER reject_edit BEFORE UPDATE ON loads BEGIN SELECT RAISE(ABORT,'forced archive failure'); END");
  const result = await call("sync", "POST");
  assert.equal(result.data.loadsArchived, 0);
  assert.ok(result.data.errors.some((error) => /No storage folder is linked/.test(error)));
  assert.ok(result.data.errors.some((error) => /forced archive failure/.test(error)));
  assert.deepEqual((await call("load", "GET", { id: unlinked.id })).data, { ...unlinked, folder_ref: "" });
  assert.deepEqual((await call("load", "GET", { id: failed.id })).data, failed);
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
  for (const query of ["driver_id=-1", "load_type=no", "status=no", "archived=no", "date_field=no",
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

test("data lock serializes mutations and releases after failures", async () => {
  const events = [];
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const first = withDataLock(async () => { events.push("first"); await hold; events.push("released"); });
  const second = withDataLock(async () => { events.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "released", "second"]);
  await assert.rejects(withDataLock(() => { throw new Error("expected"); }), /expected/);
  assert.equal(fs.existsSync(path.join(workspace, "data", "dispatch-local.db.lock")), false);
});

test("an interrupted restore blocks business access until its recovery state is resolved", async () => {
  const marker = path.join(workspace, "data", "dispatch-local.db.restore-recovery.json");
  fs.writeFileSync(marker, "{}");
  try {
    await assert.rejects(withDataLock(() => assert.fail("Business action must not run")), /interrupted local restore/);
    const result = await call("loads", "GET");
    assert.equal(result.status, 409);
    assert.match(result.data.error, /requires recovery/);
    assert.equal(fs.existsSync(path.join(workspace, "data", "dispatch-local.db.lock")), false);
  } finally {
    fs.unlinkSync(marker);
  }
});
