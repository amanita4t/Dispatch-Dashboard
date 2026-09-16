import db from "./db";
import { RequestError } from "./api";
import { errorMessage } from "./errors";
import { getStorage, movedReference, sanitizeName, sameStorageRef } from "./storage";
import type { SavedFile, StorageMove, StorageProvider } from "./storage";
import { LOAD_STATUSES, LOAD_TYPES } from "./models";
import type { DriverRecord, FileCategory, FileRecord, LoadDetail, LoadRecord, LoadWithDriver } from "./models";
import { bookingFields, dateValue, enumValue, loadChanges, positiveId, uploadFile } from "./validation";

export function findDriver(id: number): DriverRecord {
  const driver = db.prepare<[number], DriverRecord>("SELECT * FROM drivers WHERE id = ?").get(id);
  if (!driver) throw new RequestError("Driver not found", 404);
  return driver;
}

export function findLoad(id: number): LoadWithDriver {
  const load = db.prepare<[number], LoadWithDriver>(
    "SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = ?"
  ).get(id);
  if (!load) throw new RequestError("Load not found", 404);
  return load;
}

export function loadFiles(id: number): FileRecord[] {
  return db.prepare<[number], FileRecord>("SELECT * FROM files WHERE load_id = ? ORDER BY uploaded_at DESC, id DESC").all(id);
}

export function loadDetail(id: number): LoadDetail {
  return { ...findLoad(id), files: loadFiles(id) };
}

export function listLoads(params: URLSearchParams): LoadWithDriver[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const archived = enumValue(params.get("archived") || "active", ["active", "archived", "all"], "archive filter");
  if (archived !== "all") where.push(`l.archived_at IS ${archived === "active" ? "" : "NOT "}NULL`);
  if (params.get("status")) {
    where.push("l.status = ?");
    args.push(enumValue(params.get("status"), LOAD_STATUSES, "status"));
  }
  if (params.get("driver_id")) {
    where.push("l.driver_id = ?");
    args.push(positiveId(params.get("driver_id"), "driver ID"));
  }
  if (params.get("load_type")) {
    where.push("l.load_type = ?");
    args.push(enumValue(params.get("load_type"), LOAD_TYPES, "load type"));
  }
  const search = params.get("q")?.trim();
  if (search) {
    where.push("(l.load_number LIKE ? OR l.pickup_city LIKE ? OR l.delivery_city LIKE ? OR d.name LIKE ?)");
    args.push(...Array<string>(4).fill(`%${search}%`));
  }
  const dateField = enumValue(params.get("date_field") || "delivery_date",
    ["pickup_date", "delivery_date", "invoice_due_date"], "date field");
  const from = dateValue(params.get("date_from") ?? "", "Start date");
  const to = dateValue(params.get("date_to") ?? "", "End date");
  if (from && to && from > to) throw new RequestError("End date cannot be before start date");
  if (from || to) where.push(`l.${dateField} != ''`);
  if (from) { where.push(`l.${dateField} >= ?`); args.push(from); }
  if (to) { where.push(`l.${dateField} <= ?`); args.push(to); }
  const sort = enumValue(params.get("sort") || "created_at",
    ["created_at", "pickup_date", "delivery_date", "invoice_due_date", "rate_amount", "load_number", "driver_name", "status"],
    "sort column");
  const order = enumValue(params.get("order") || "desc", ["asc", "desc"], "sort order");
  const column = sort === "driver_name" ? "d.name" : `l.${sort}`;
  const emptyDatesLast = sort.endsWith("_date") ? `CASE WHEN ${column} = '' THEN 1 ELSE 0 END, ` : "";
  return db.prepare<(string | number)[], LoadWithDriver>(
    `SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${emptyDatesLast}${column} ${order.toUpperCase()}, l.id DESC`
  ).all(...args);
}

export function insertFile(loadId: number, category: FileCategory, file: File, saved: SavedFile): FileRecord {
  const result = db.prepare(
    "INSERT INTO files (load_id, category, filename, storage_ref, web_link, size) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(loadId, category, saved.filename, saved.storageRef, saved.webLink, file.size);
  const record = db.prepare<[number], FileRecord>("SELECT * FROM files WHERE id = ?").get(Number(result.lastInsertRowid));
  if (!record) throw new Error("Uploaded document record could not be read");
  return record;
}

async function rollbackFiles(storage: StorageProvider, files: SavedFile[], folder: string, cause: unknown): Promise<never> {
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
    throw new Error(`${errorMessage(cause)}. Some new files/folders need manual cleanup: ${failures.join("; ")}`);
  }
  throw cause;
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
  const driver = findDriver(fields.driver_id);
  const existing = db.prepare<[string, string], Pick<LoadRecord, "archived_at">>(
    "SELECT archived_at FROM loads WHERE load_number = ? AND load_type = ?"
  ).get(fields.load_number, fields.load_type);
  if (existing) {
    throw new RequestError(existing.archived_at
      ? "This load is archived. Restore it from the Archived view instead of booking it again."
      : "A load with this number and type already exists", 409);
  }
  const storage = getStorage();
  let folder = "";
  let id: number;
  const saved: { file: File; category: FileCategory; record: SavedFile }[] = [];
  const uploadErrors: string[] = [];
  try {
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
    id = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date, delivery_date,
          rate_amount, status, invoice_due_date, folder_ref) VALUES
          (@load_number, @load_type, @driver_id, @pickup_city, @delivery_city, @pickup_date, @delivery_date,
          @rate_amount, @status, @invoice_due_date, @folder_ref)`
      ).run({ ...fields, folder_ref: folder });
      const loadId = Number(result.lastInsertRowid);
      for (const upload of saved) insertFile(loadId, upload.category, upload.file, upload.record);
      return loadId;
    })();
  } catch (error) {
    return rollbackFiles(storage, saved.map((entry) => entry.record), folder, error);
  }
  return { load: findLoad(id), uploadErrors };
}

async function rollbackMove(move: StorageMove | null, error: unknown): Promise<never> {
  if (move) {
    try { await move.rollback(); }
    catch (rollbackError) {
      throw new Error(`${errorMessage(error)}. Folder rollback also failed: ${errorMessage(rollbackError)}. Documents remain at ${move.folderRef}`);
    }
  }
  throw error;
}

function updateMovedFiles(files: FileRecord[], move: StorageMove) {
  const update = db.prepare("UPDATE files SET storage_ref = ? WHERE id = ?");
  for (const file of files) update.run(movedReference(file.storage_ref, move), file.id);
}

export async function editLoad(id: number, body: Record<string, unknown>): Promise<LoadDetail> {
  const current = findLoad(id);
  if (current.archived_at) throw new RequestError("Restore this archived load before editing it", 409);
  const fields = loadChanges(body, current);
  const driver = findDriver(fields.driver_id);
  const files = loadFiles(id);
  let move: StorageMove | null = null;
  try {
    if (fields.driver_id !== current.driver_id) {
      move = await getStorage().moveLoadFolder(current.folder_ref, driver.name, current.load_number, current.load_type, false);
    }
    db.transaction(() => {
      if (move) updateMovedFiles(files, move);
      db.prepare(
        `UPDATE loads SET driver_id = @driver_id, pickup_city = @pickup_city, delivery_city = @delivery_city,
         pickup_date = @pickup_date, delivery_date = @delivery_date, rate_amount = @rate_amount,
         status = @status, notes = @notes, invoice_due_date = @invoice_due_date, folder_ref = @folder_ref WHERE id = @id`
      ).run({ ...fields, id, folder_ref: move?.folderRef ?? current.folder_ref });
    })();
  } catch (error) {
    return rollbackMove(move, error);
  }
  return loadDetail(id);
}

export async function archiveLoadIfMissing(id: number): Promise<boolean> {
  const current = findLoad(id);
  if (current.archived_at) return false;
  if (!current.folder_ref) {
    throw new RequestError("No storage folder is linked to this load; link it before syncing missing loads", 409);
  }
  const storage = getStorage();
  if (await storage.loadFolderPresent(current.driver_name, current.folder_ref)) return false;
  if (await storage.loadFolderExists(current.driver_name, current.load_number, current.load_type)) {
    throw new RequestError("A matching active or archived folder still exists in another location; resolve its link instead of treating it as deleted", 409);
  }
  return db.prepare("UPDATE loads SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(new Date().toISOString(), id).changes === 1;
}

export async function archiveLoad(id: number, archived: boolean): Promise<LoadDetail> {
  const current = findLoad(id);
  if (Boolean(current.archived_at) === archived) return loadDetail(id);
  const storage = getStorage();
  if (archived && await archiveLoadIfMissing(id)) return loadDetail(id);
  if (!archived && (!current.folder_ref || !await storage.loadFolderPresent(current.driver_name, current.folder_ref))) {
    throw new RequestError("The load folder is missing. Recover the original folder and its documents at the original storage location before restoring this load.", 409);
  }
  const files = loadFiles(id);
  const move = await storage.moveLoadFolder(current.folder_ref, current.driver_name, current.load_number, current.load_type, archived);
  try {
    db.transaction(() => {
      updateMovedFiles(files, move);
      db.prepare("UPDATE loads SET archived_at = ?, folder_ref = ? WHERE id = ?")
        .run(archived ? new Date().toISOString() : null, move.folderRef, id);
    })();
  } catch (error) {
    return rollbackMove(move, error);
  }
  return loadDetail(id);
}

export function assertDriverNameAvailable(name: string, exceptId?: number) {
  const normalized = sanitizeName(name).toLowerCase();
  const drivers = db.prepare<[], DriverRecord>("SELECT * FROM drivers").all();
  if (drivers.some((driver) => driver.id !== exceptId && sanitizeName(driver.name).toLowerCase() === normalized)) {
    throw new RequestError("A driver with the same name or storage folder already exists", 409);
  }
}

export async function editDriver(id: number, fields: { name: string; phone: string; truck: string }) {
  const current = findDriver(id);
  assertDriverNameAvailable(fields.name, id);
  const loads = db.prepare<[number], LoadRecord>("SELECT * FROM loads WHERE driver_id = ?").all(id);
  const files = db.prepare<[number], FileRecord>(
    "SELECT f.* FROM files f JOIN loads l ON l.id = f.load_id WHERE l.driver_id = ?"
  ).all(id);
  let move: StorageMove | null = null;
  try {
    if (current.name !== fields.name) {
      move = await getStorage().renameDriverFolder(current.name, fields.name);
      if (!move && loads.some((load) => load.folder_ref)) {
        throw new RequestError("The driver's storage folder is missing; restore it before renaming the driver", 409);
      }
    }
    db.transaction(() => {
      if (move) {
        const update = db.prepare("UPDATE loads SET folder_ref = ? WHERE id = ?");
        for (const load of loads) update.run(movedReference(load.folder_ref, move), load.id);
        updateMovedFiles(files, move);
      }
      db.prepare("UPDATE drivers SET name = ?, phone = ?, truck = ? WHERE id = ?")
        .run(fields.name, fields.phone, fields.truck, id);
    })();
  } catch (error) {
    return rollbackMove(move, error);
  }
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
