import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, readJsonObject, RequestError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { archiveLoadIfMissing, assertDriverNameAvailable, assertMatchingFolder, bookingLockKey, findDriver, findLoad } from "@/lib/loads";
import { LOAD_TYPES } from "@/lib/models";
import type { DriverRecord, FileCategory, LoadRecord, SyncResponse, SyncSummary } from "@/lib/models";
import { lockDataKey, withDataLock } from "@/lib/mutation-lock";
import { getStorage, sameStorageRef, sanitizeName } from "@/lib/storage";
import type { StorageDriverFolder, StorageLoadFolder } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface SyncState {
  version: 1;
  drivers: Pick<DriverRecord, "id" | "name">[];
  driverIndex: number;
  typeIndex: number;
  stage: "scan" | "folders" | "reconcile" | "done";
  folders: StorageLoadFolder[];
  folderIndex: number;
  missing: Pick<LoadRecord, "id" | "load_number">[];
  missingIndex: number;
  discoverySucceeded: boolean;
  scanFailed: boolean;
  summary: SyncSummary;
}

function guessCategory(filename: string): FileCategory {
  const name = filename.toLowerCase();
  if (/(^|[^a-z])bol([^a-z]|$)|bill[\s_-]*of[\s_-]*lading/.test(name)) return "bol";
  if (name.includes("lumper")) return "lumper_receipt";
  if (name.includes("invoice")) return "invoice";
  if (/rate|ratecon|(^|[^a-z])rc([^a-z]|$)/.test(name)) {
    return name.includes("updated") ? "updated_rate_confirmation" : "rate_confirmation";
  }
  return "other";
}

function addError(summary: SyncSummary, message: string) {
  if (summary.errors.length < 100) {
    summary.errors.push(message);
    console.error(`[dispatch sync] ${message}`);
  }
  else if (summary.errors.length === 100) summary.errors.push("More sync errors occurred. Resolve the reported problems and run Sync storage again.");
}

function roster(drivers: DriverRecord[]) {
  return JSON.stringify(drivers.map(({ id, name }) => ({ id, name })));
}

async function startSync(): Promise<string> {
  const storage = getStorage();
  const { before, summary, candidates, discoverySucceeded } = await withDataLock(async () => {
    const before = await db.all<DriverRecord>("SELECT * FROM drivers ORDER BY id");
    const summary: SyncSummary = {
      driversScanned: 0, driversImported: 0, loadsImported: 0, loadsArchived: 0, filesImported: 0,
      skippedExisting: 0, skippedArchived: 0, errors: [],
    };
    const candidates = new Map<string, StorageDriverFolder[]>();
    let discoverySucceeded = false;
    try {
      const folders = await storage.listDriverFolders();
      discoverySucceeded = true;
      for (const folder of folders) {
        try {
          const key = sanitizeName(folder.name).toLowerCase();
          candidates.set(key, [...(candidates.get(key) ?? []), folder]);
        } catch (error) {
          addError(summary, `${folder.name}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      addError(summary, `Driver folder discovery: ${errorMessage(error)}`);
    }
    return { before, summary, candidates, discoverySucceeded };
  });

  return withDataLock(async () => {
    const drivers = await db.all<DriverRecord>("SELECT * FROM drivers ORDER BY id");
    if (roster(before) !== roster(drivers)) {
      throw new RequestError("The driver list changed during discovery. Retry Sync storage.", 409);
    }
    const blocked = new Set<string>();
    for (const [key, folders] of Array.from(candidates)) {
      const folder = folders[0];
      try {
        const imported = await db.transaction(async () => {
          if (folders.length !== 1) {
            throw new RequestError("Multiple driver folders have the same storage name; resolve the duplicates first", 409);
          }
          const matches = drivers.filter((driver) => sanitizeName(driver.name).toLowerCase() === key);
          if (matches.length > 1) {
            throw new RequestError("Multiple registered drivers share this storage name; resolve the duplicate driver names first", 409);
          }
          if (matches[0]) {
            if (storage.mode === "drive" && sanitizeName(matches[0].name) !== folder.name) {
              throw new RequestError("This folder conflicts with a registered driver's name; resolve the folder name before importing", 409);
            }
            return null;
          }
          if (sanitizeName(folder.name) !== folder.name) {
            throw new RequestError("Rename this driver folder to remove unsupported characters before importing", 409);
          }
          await assertDriverNameAvailable(folder.name);
          const result = await db.one<DriverRecord>("INSERT INTO drivers (name) VALUES ($1) RETURNING *", [folder.name]);
          if (!result) throw new Error("Imported driver record could not be read");
          return result;
        });
        if (imported) {
          drivers.push(imported);
          summary.driversImported++;
        }
      } catch (error) {
        blocked.add(key);
        addError(summary, `${folder.name}: ${errorMessage(error)}`);
      }
    }
    const selected = drivers.filter((driver) => !blocked.has(sanitizeName(driver.name).toLowerCase()));
    const state: SyncState = {
      version: 1, drivers: selected.map(({ id, name }) => ({ id, name })), driverIndex: 0, typeIndex: 0,
      stage: selected.length ? "scan" : "done", folders: [], folderIndex: 0, missing: [], missingIndex: 0,
      discoverySucceeded, scanFailed: false, summary,
    };
    const id = randomUUID();
    await db.query("DELETE FROM sync_runs WHERE updated_at < now() - interval '24 hours'");
    await db.query("INSERT INTO sync_runs (id, state) VALUES ($1, $2::jsonb)", [id, JSON.stringify(state)]);
    return id;
  }, { drivers: "exclusive" });
}

function nextType(state: SyncState) {
  state.typeIndex++;
  if (state.typeIndex === LOAD_TYPES.length) {
    state.typeIndex = 0;
    state.driverIndex++;
  }
  state.stage = state.driverIndex >= state.drivers.length ? "done" : "scan";
  state.folders = [];
  state.folderIndex = 0;
  state.missing = [];
  state.missingIndex = 0;
  state.scanFailed = false;
}

async function importFolder(driverId: number, type: (typeof LOAD_TYPES)[number], folder: StorageLoadFolder) {
  await lockDataKey(bookingLockKey(type, folder.loadNumber));
  let existing = await db.one<LoadRecord>("SELECT * FROM loads WHERE load_number = $1 AND load_type = $2", [folder.loadNumber, type])
    ?? await db.one<LoadRecord>("SELECT * FROM loads WHERE folder_ref = $1", [folder.folderRef]);
  if (existing) {
    await lockDataKey(`load:${existing.id}`);
    existing = await findLoad(existing.id);
    if (existing.archived_at) return { archived: true, existing: true, files: 0 };
    assertMatchingFolder(existing, driverId, folder.folderRef);
  }
  const files = await getStorage().listFolderFiles(folder.folderRef);
  let id = existing?.id;
  if (id === undefined) {
    const result = await db.one<{ id: number }>(
      `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date,
       delivery_date, rate_amount, status, folder_ref, notes, created_at)
       VALUES ($1, $2, $3, '', '', '', '', 0, 'scheduled', $4, 'Imported from storage sync', $5) RETURNING id`,
      [folder.loadNumber, type, driverId, folder.folderRef, folder.createdAt]
    );
    if (!result) throw new Error("Imported load record could not be read");
    id = result.id;
  } else if (!existing?.folder_ref) {
    await db.query("UPDATE loads SET folder_ref = $1 WHERE id = $2", [folder.folderRef, id]);
  }
  const tracked = await db.all<{ load_id: number; storage_ref: string }>(
    "SELECT load_id, storage_ref FROM files WHERE storage_ref = ANY($1::text[])", [files.map((file) => file.storageRef)]
  );
  if (tracked.some((file) => file.load_id !== id)) {
    throw new RequestError("A document is already tracked under a different load; resolve the conflict first", 409);
  }
  const known = new Set(tracked.map((file) => file.storage_ref));
  const fresh = files.filter((file) => {
    if (known.has(file.storageRef)) return false;
    known.add(file.storageRef);
    return true;
  }).map((file) => ({
    load_id: id, category: guessCategory(file.filename), filename: file.filename, storage_ref: file.storageRef,
    web_link: file.webLink, size: file.size, uploaded_at: file.createdAt,
  }));
  if (fresh.length) {
    await db.query(
      `INSERT INTO files (load_id, category, filename, storage_ref, web_link, size, uploaded_at)
       SELECT load_id, category, filename, storage_ref, web_link, size, uploaded_at
       FROM jsonb_to_recordset($1::jsonb) AS f(load_id int, category text, filename text,
       storage_ref text, web_link text, size double precision, uploaded_at text)`,
      [JSON.stringify(fresh)]
    );
  }
  return { archived: false, existing: Boolean(existing), files: fresh.length };
}

async function step(state: SyncState) {
  const driver = state.drivers[state.driverIndex];
  const type = LOAD_TYPES[state.typeIndex];
  const summary = state.summary;
  try {
    if ((await findDriver(driver.id)).name !== driver.name) {
      throw new RequestError("Driver name changed during sync. Start a new sync before importing its folders.", 409);
    }
  } catch (error) {
    addError(summary, `${driver.name}: ${errorMessage(error)}`);
    state.typeIndex = LOAD_TYPES.length - 1;
    nextType(state);
    return;
  }
  if (state.stage === "scan") {
    if (state.typeIndex === 0) summary.driversScanned++;
    try {
      state.folders = await getStorage().listLoadFolders(driver.name, type);
      const numbers = new Map<string, number>();
      for (const folder of state.folders) {
        const key = folder.loadNumber.toLowerCase();
        numbers.set(key, (numbers.get(key) ?? 0) + 1);
      }
      state.folders = state.folders.filter((folder) => {
        if ((numbers.get(folder.loadNumber.toLowerCase()) ?? 0) < 2) return true;
        state.scanFailed = true;
        addError(summary, `${driver.name} / ${type} #${folder.loadNumber}: This load number appears in multiple folders; resolve the duplicate layout before importing`);
        return false;
      });
      state.stage = "folders";
    } catch (error) {
      addError(summary, `${driver.name} (${type}): ${errorMessage(error)}`);
      nextType(state);
    }
    return;
  }
  if (state.stage === "folders") {
    const folder = state.folders[state.folderIndex++];
    if (folder) {
      try {
        const result = await db.transaction(() => importFolder(driver.id, type, folder));
        if (result.archived) summary.skippedArchived++;
        else if (result.existing) summary.skippedExisting++;
        else summary.loadsImported++;
        summary.filesImported += result.files;
      } catch (error) {
        state.scanFailed = true;
        addError(summary, `${driver.name} / ${type} #${folder.loadNumber}: ${errorMessage(error)}`);
      }
      return;
    }
    if (state.scanFailed || !state.discoverySucceeded) {
      nextType(state);
      return;
    }
    const active = await db.all<Pick<LoadRecord, "id" | "load_number" | "folder_ref">>(
      "SELECT id, load_number, folder_ref FROM loads WHERE driver_id = $1 AND load_type = $2 AND archived_at IS NULL",
      [driver.id, type]
    );
    state.missing = active.filter((load) => !state.folders.some((folder) => sameStorageRef(folder.folderRef, load.folder_ref)));
    state.stage = "reconcile";
    return;
  }
  const load = state.missing[state.missingIndex++];
  if (!load) {
    nextType(state);
    return;
  }
  try {
    const archived = await db.transaction(async () => {
      await lockDataKey(`load:${load.id}`);
      const current = await findLoad(load.id);
      if (current.driver_id !== driver.id || current.load_type !== type) return false;
      return archiveLoadIfMissing(load.id);
    });
    if (archived) summary.loadsArchived++;
  } catch (error) {
    addError(summary, `${driver.name} / ${type} #${load.load_number}: ${errorMessage(error)}`);
  }
}

async function continueSync(id: string): Promise<SyncResponse> {
  return withDataLock(async () => {
    const row = await db.one<{ state: SyncState }>(
      "SELECT state FROM sync_runs WHERE id = $1 AND updated_at >= now() - interval '24 hours' FOR UPDATE", [id]
    );
    if (!row) throw new RequestError("This sync has expired. Start a new sync.", 410);
    const state = row.state;
    if (state.version !== 1) throw new RequestError("This sync belongs to an older app version. Start a new sync.", 409);
    const deadline = Date.now() + 20_000;
    for (let count = 0; count < 5 && state.stage !== "done" && Date.now() < deadline; count++) {
      await step(state);
    }
    await db.query("UPDATE sync_runs SET state = $1::jsonb, updated_at = now() WHERE id = $2", [JSON.stringify(state), id]);
    return { ...state.summary, cursor: state.stage === "done" ? null : id };
  }, { keys: [`sync:${id}`] });
}

export async function POST(req: Request) {
  return apiHandler(async () => {
    const body = await readJsonObject(req, { allowEmpty: true });
    if (body.cursor !== undefined && (typeof body.cursor !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.cursor))) {
      throw new RequestError("Invalid sync cursor");
    }
    const id = typeof body.cursor === "string" ? body.cursor : await startSync();
    return NextResponse.json(await continueSync(id), { headers: { "Cache-Control": "no-store" } });
  });
}
