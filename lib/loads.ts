import db from "./db";
import { RequestError } from "./api";
import { errorMessage } from "./errors";
import { assertStorageWritable, getStorage, movedReference, sanitizeName, sameStorageRef } from "./storage";
import type { SavedFile, StorageMove, StorageProvider } from "./storage";
import { LOAD_STATUSES, LOAD_TYPES } from "./models";
import type { DriverRecord, FileCategory, FileRecord, LoadDetail, LoadRecord, LoadWithDriver } from "./models";
import { bookingFields, dateValue, enumValue, loadChanges, positiveId, uploadFile } from "./validation";
import { lockDataKey } from "./mutation-lock";

export async function findDriver(id: number): Promise<DriverRecord> {
  const driver = await db.one<DriverRecord>("SELECT * FROM drivers WHERE id = $1", [id]);
  if (!driver) throw new RequestError("Driver not found", 404);
  return driver;
}

export async function findLoad(id: number): Promise<LoadWithDriver> {
  const load = await db.one<LoadWithDriver>(
    "SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = $1", [id]
  );
  if (!load) throw new RequestError("Load not found", 404);
  return load;
}

export function loadFiles(id: number): Promise<FileRecord[]> {
  return db.all<FileRecord>("SELECT * FROM files WHERE load_id = $1 ORDER BY uploaded_at DESC, id DESC", [id]);
}

export async function loadDetail(id: number): Promise<LoadDetail> {
  const load = await db.one<LoadDetail>(
    `SELECT l.*, d.name AS driver_name,
     COALESCE((SELECT json_agg(f ORDER BY f.uploaded_at DESC, f.id DESC) FROM files f WHERE f.load_id = l.id), '[]'::json) AS files
     FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = $1`, [id]
  );
  if (!load) throw new RequestError("Load not found", 404);
  return load;
}

export function listLoads(params: URLSearchParams): Promise<LoadWithDriver[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const parameter = (value: string | number) => {
    args.push(value);
    return `$${args.length}`;
  };
  const archived = enumValue(params.get("archived") || "active", ["active", "archived", "all"], "archive filter");
  if (archived !== "all") where.push(`l.archived_at IS ${archived === "active" ? "" : "NOT "}NULL`);
  if (params.get("status")) {
    where.push(`l.status = ${parameter(enumValue(params.get("status"), LOAD_STATUSES, "status"))}`);
  }
  if (params.get("driver_id")) {
    where.push(`l.driver_id = ${parameter(positiveId(params.get("driver_id"), "driver ID"))}`);
  }
  if (params.get("load_type")) {
    where.push(`l.load_type = ${parameter(enumValue(params.get("load_type"), LOAD_TYPES, "load type"))}`);
  }
  const search = params.get("q")?.trim();
  if (search) {
    const value = parameter(`%${search}%`);
    where.push(`(l.load_number ILIKE ${value} OR l.pickup_city ILIKE ${value} OR l.delivery_city ILIKE ${value} OR d.name ILIKE ${value})`);
  }
  const dateField = enumValue(params.get("date_field") || "delivery_date",
    ["pickup_date", "delivery_date", "invoice_due_date"], "date field");
  const from = dateValue(params.get("date_from") ?? "", "Start date");
  const to = dateValue(params.get("date_to") ?? "", "End date");
  if (from && to && from > to) throw new RequestError("End date cannot be before start date");
  if (from || to) where.push(`l.${dateField} != ''`);
  if (from) where.push(`l.${dateField} >= ${parameter(from)}`);
  if (to) where.push(`l.${dateField} <= ${parameter(to)}`);
  const sort = enumValue(params.get("sort") || "created_at",
    ["created_at", "pickup_date", "delivery_date", "invoice_due_date", "rate_amount", "load_number", "driver_name", "status"],
    "sort column");
  const order = enumValue(params.get("order") || "desc", ["asc", "desc"], "sort order");
  const column = sort === "driver_name" ? "d.name" : `l.${sort}`;
  const emptyDatesLast = sort.endsWith("_date") ? `CASE WHEN ${column} = '' THEN 1 ELSE 0 END, ` : "";
  return db.all<LoadWithDriver>(
    `SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${emptyDatesLast}${column} ${order.toUpperCase()}, l.id DESC`,
    args
  );
}

export async function insertFile(loadId: number, category: FileCategory, file: File, saved: SavedFile): Promise<FileRecord> {
  const record = await db.one<FileRecord>(
    "INSERT INTO files (load_id, category, filename, storage_ref, web_link, size) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [loadId, category, saved.filename, saved.storageRef, saved.webLink, file.size]
  );
  if (!record) throw new Error("Uploaded document record could not be read");
  return record;
}

async function rollbackFiles(storage: StorageProvider, files: SavedFile[], folder: string): Promise<void> {
  const failures: string[] = [];
  for (const file of files) {
    try { await storage.deleteFile(file.storageRef); }
    catch (error) { failures.push(errorMessage(error)); }
  }
  if (folder) {
    try { await storage.removeEmptyLoadFolder(folder); }
    catch (error) { failures.push(errorMessage(error)); }
  }
  if (failures.length) {
    throw new Error(`Some new files/folders need manual cleanup: ${failures.join("; ")}`);
  }
}

export function bookingLockKey(loadType: string, loadNumber: string): string {
  return `booking:${loadType}:${sanitizeName(loadNumber).toLowerCase()}`;
}

export async function createLoad(form: FormData) {
  const fields = bookingFields(form);
  sanitizeName(fields.load_number);
  const rateCon = uploadFile(form.get("rate_confirmation"), "Rate confirmation");
  const optional: { category: FileCategory; file: File }[] = [];
  for (const [key, category] of [["bol", "bol"], ["other_1", "other"], ["other_2", "other"]] as const) {
    const entry = form.get(key);
    if (entry !== null && (!(entry instanceof File) || entry.size > 0)) {
      optional.push({ category, file: uploadFile(entry, key) });
    }
  }
  await lockDataKey(bookingLockKey(fields.load_type, fields.load_number));
  await lockDataKey(`storage-driver:${fields.driver_id}`);
  const driver = await findDriver(fields.driver_id);
  const existing = await db.one<Pick<LoadRecord, "archived_at">>(
    "SELECT archived_at FROM loads WHERE load_number = $1 AND load_type = $2", [fields.load_number, fields.load_type]
  );
  if (existing) {
    throw new RequestError(existing.archived_at
      ? "This load is archived. Restore it from the Archived view instead of booking it again."
      : "A load with this number and type already exists", 409);
  }
  const storage = getStorage();
  let folder = "";
  const saved: { file: File; category: FileCategory; record: SavedFile }[] = [];
  const uploadErrors: string[] = [];
  db.onRollback(() => rollbackFiles(storage, saved.map((entry) => entry.record), folder));
  folder = await storage.createLoadFolder(driver.name, fields.load_number, fields.load_type);
  const required = await storage.saveFile(folder, rateCon.name, Buffer.from(await rateCon.arrayBuffer()), rateCon.type || "application/octet-stream");
  saved.push({ file: rateCon, category: "rate_confirmation", record: required });
  for (const upload of optional) {
    try {
      const record = await storage.saveFile(folder, upload.file.name, Buffer.from(await upload.file.arrayBuffer()), upload.file.type || "application/octet-stream");
      saved.push({ ...upload, record });
    } catch (error) {
      uploadErrors.push(`${upload.file.name}: ${errorMessage(error)}`);
    }
  }
  const record = await db.one<{ id: number }>(
    `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date, delivery_date,
      rate_amount, status, invoice_due_date, folder_ref)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [fields.load_number, fields.load_type, fields.driver_id, fields.pickup_city, fields.delivery_city,
      fields.pickup_date, fields.delivery_date, fields.rate_amount, fields.status, fields.invoice_due_date, folder]
  );
  if (!record) throw new Error("Booked load record could not be read");
  for (const upload of saved) await insertFile(record.id, upload.category, upload.file, upload.record);
  return { load: await findLoad(record.id), uploadErrors };
}

function trackMove(move: StorageMove) {
  db.onRollback(async () => {
    try { await move.rollback(); }
    catch (rollbackError) {
      throw new Error(`Folder rollback failed: ${errorMessage(rollbackError)}. Documents remain at ${move.folderRef}`);
    }
  });
}

async function updateMovedFiles(files: FileRecord[], move: StorageMove) {
  if (!move.localPrefixes || !files.length) return;
  const changed = files.map((file) => ({ id: file.id, storage_ref: movedReference(file.storage_ref, move) }));
  await db.query(
    `UPDATE files f SET storage_ref = changed.storage_ref
     FROM jsonb_to_recordset($1::jsonb) AS changed(id int, storage_ref text) WHERE f.id = changed.id`,
    [JSON.stringify(changed)]
  );
}

export async function editLoad(id: number, body: Record<string, unknown>): Promise<LoadDetail> {
  const current = await findLoad(id);
  if (current.archived_at) throw new RequestError("Restore this archived load before editing it", 409);
  const fields = loadChanges(body, current);
  const driver = await findDriver(fields.driver_id);
  const files = await loadFiles(id);
  let move: StorageMove | null = null;
  if (fields.driver_id !== current.driver_id) {
    for (const driverId of [current.driver_id, fields.driver_id].sort((left, right) => left - right)) {
      await lockDataKey(`storage-driver:${driverId}`);
    }
    move = await getStorage().moveLoadFolder(current.folder_ref, driver.name, current.load_number, current.load_type, false);
    trackMove(move);
    await updateMovedFiles(files, move);
  }
  await db.query(
    `UPDATE loads SET driver_id = $1, pickup_city = $2, delivery_city = $3, pickup_date = $4,
     delivery_date = $5, rate_amount = $6, status = $7, notes = $8, invoice_due_date = $9, folder_ref = $10 WHERE id = $11`,
    [fields.driver_id, fields.pickup_city, fields.delivery_city, fields.pickup_date, fields.delivery_date,
      fields.rate_amount, fields.status, fields.notes, fields.invoice_due_date, move?.folderRef ?? current.folder_ref, id]
  );
  return loadDetail(id);
}

export async function archiveLoadIfMissing(id: number): Promise<boolean> {
  const current = await findLoad(id);
  if (current.archived_at) return false;
  if (!current.folder_ref) {
    throw new RequestError("No storage folder is linked to this load; link it before syncing missing loads", 409);
  }
  const storage = getStorage();
  if (await storage.loadFolderPresent(current.driver_name, current.folder_ref)) return false;
  if (await storage.loadFolderExists(current.driver_name, current.load_number, current.load_type)) {
    throw new RequestError("A matching active or archived folder still exists in another location; resolve its link instead of treating it as deleted", 409);
  }
  return (await db.query("UPDATE loads SET archived_at = $1 WHERE id = $2 AND archived_at IS NULL",
    [new Date().toISOString(), id])).rowCount === 1;
}

export async function archiveLoad(id: number, archived: boolean): Promise<LoadDetail> {
  const current = await findLoad(id);
  if (Boolean(current.archived_at) === archived) return loadDetail(id);
  const storage = getStorage();
  assertStorageWritable(storage);
  await lockDataKey(`storage-driver:${current.driver_id}`);
  if (archived && await archiveLoadIfMissing(id)) return loadDetail(id);
  if (!archived && (!current.folder_ref || !await storage.loadFolderPresent(current.driver_name, current.folder_ref))) {
    throw new RequestError("The load folder is missing. Recover the original folder and its documents at the original storage location before restoring this load.", 409);
  }
  const files = await loadFiles(id);
  const move = await storage.moveLoadFolder(current.folder_ref, current.driver_name, current.load_number, current.load_type, archived);
  trackMove(move);
  await updateMovedFiles(files, move);
  await db.query("UPDATE loads SET archived_at = $1, folder_ref = $2 WHERE id = $3",
    [archived ? new Date().toISOString() : null, move.folderRef, id]);
  return loadDetail(id);
}

export async function assertDriverNameAvailable(name: string, exceptId?: number) {
  const normalized = sanitizeName(name).toLowerCase();
  const drivers = await db.all<DriverRecord>("SELECT * FROM drivers");
  if (drivers.some((driver) => driver.id !== exceptId && sanitizeName(driver.name).toLowerCase() === normalized)) {
    throw new RequestError("A driver with the same name or storage folder already exists", 409);
  }
}

export async function editDriver(id: number, fields: { name: string; phone: string; truck: string }) {
  const current = await findDriver(id);
  await assertDriverNameAvailable(fields.name, id);
  const loads = await db.all<LoadRecord>("SELECT * FROM loads WHERE driver_id = $1", [id]);
  const files = await db.all<FileRecord>(
    "SELECT f.* FROM files f JOIN loads l ON l.id = f.load_id WHERE l.driver_id = $1", [id]
  );
  let move: StorageMove | null = null;
  if (current.name !== fields.name) {
    move = await getStorage().renameDriverFolder(current.name, fields.name);
    if (!move && loads.some((load) => load.folder_ref)) {
      throw new RequestError("The driver's storage folder is missing; restore it before renaming the driver", 409);
    }
  }
  if (move) {
    trackMove(move);
    if (move.localPrefixes && loads.length) {
      const changed = loads.map((load) => ({ id: load.id, folder_ref: movedReference(load.folder_ref, move), }));
      await db.query(
        `UPDATE loads l SET folder_ref = changed.folder_ref
         FROM jsonb_to_recordset($1::jsonb) AS changed(id int, folder_ref text) WHERE l.id = changed.id`,
        [JSON.stringify(changed)]
      );
    }
    await updateMovedFiles(files, move);
  }
  await db.query("UPDATE drivers SET name = $1, phone = $2, truck = $3 WHERE id = $4",
    [fields.name, fields.phone, fields.truck, id]);
  return findDriver(id);
}

export function assertMatchingFolder(load: LoadRecord, driverId: number, folderRef: string) {
  if (load.driver_id !== driverId) {
    throw new RequestError("Load number is already assigned to another driver; no documents were imported", 409);
  }
  if (load.folder_ref && !sameStorageRef(load.folder_ref, folderRef)) {
    throw new RequestError("Load number points to a different folder; resolve the conflict before importing", 409);
  }
}
