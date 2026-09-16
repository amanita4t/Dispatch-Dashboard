import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, RequestError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { archiveLoadIfMissing, assertDriverNameAvailable, assertMatchingFolder, findDriver } from "@/lib/loads";
import { LOAD_TYPES } from "@/lib/models";
import type { DriverRecord, FileCategory, LoadRecord, SyncSummary } from "@/lib/models";
import { withDataLock } from "@/lib/mutation-lock";
import { getStorage, sameStorageRef, sanitizeName } from "@/lib/storage";
import type { StorageDriverFolder } from "@/lib/storage";

export const dynamic = "force-dynamic";

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

export async function POST() {
  return apiHandler(() => withDataLock(async () => {
    const storage = getStorage();
    const drivers = db.prepare<[], DriverRecord>("SELECT * FROM drivers ORDER BY id").all();
    const summary: SyncSummary = {
      driversScanned: 0, driversImported: 0, loadsImported: 0, loadsArchived: 0, filesImported: 0,
      skippedExisting: 0, skippedArchived: 0, errors: [],
    };
    const blockedDriverNames = new Set<string>();
    let discoverySucceeded = false;
    try {
      const candidates = new Map<string, StorageDriverFolder[]>();
      const driverFolders = await storage.listDriverFolders();
      discoverySucceeded = true;
      for (const folder of driverFolders) {
        try {
          const key = sanitizeName(folder.name).toLowerCase();
          candidates.set(key, [...(candidates.get(key) ?? []), folder]);
        } catch (error) {
          summary.errors.push(`${folder.name}: ${errorMessage(error)}`);
        }
      }
      for (const [key, folders] of Array.from(candidates)) {
        const folder = folders[0];
        try {
          if (folders.length !== 1) {
            throw new RequestError("Multiple driver folders have the same storage name; resolve the duplicates first", 409);
          }
          const matches = drivers.filter((driver) => sanitizeName(driver.name).toLowerCase() === key);
          if (matches.length > 1) {
            throw new RequestError("Multiple registered drivers share this storage name; resolve the duplicate driver names first", 409);
          }
          const existing = matches[0];
          if (existing) {
            if (storage.mode === "drive" && sanitizeName(existing.name) !== folder.name) {
              throw new RequestError("This folder conflicts with a registered driver's name; resolve the folder name before importing", 409);
            }
            continue;
          }
          if (sanitizeName(folder.name) !== folder.name) {
            throw new RequestError("Rename this driver folder to remove unsupported characters before importing", 409);
          }
          assertDriverNameAvailable(folder.name);
          const result = db.prepare("INSERT INTO drivers (name) VALUES (?)").run(folder.name);
          drivers.push(findDriver(Number(result.lastInsertRowid)));
          summary.driversImported++;
        } catch (error) {
          blockedDriverNames.add(key);
          summary.errors.push(`${folder.name}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      summary.errors.push(`Driver folder discovery: ${errorMessage(error)}`);
    }
    for (const driver of drivers) {
      if (blockedDriverNames.has(sanitizeName(driver.name).toLowerCase())) continue;
      summary.driversScanned++;
      for (const type of LOAD_TYPES) {
        let folders;
        try {
          folders = await storage.listLoadFolders(driver.name, type);
        } catch (error) {
          summary.errors.push(`${driver.name} (${type}): ${errorMessage(error)}`);
          continue;
        }
        const numbers = new Map<string, number>();
        for (const folder of folders) {
          const key = folder.loadNumber.toLowerCase();
          numbers.set(key, (numbers.get(key) ?? 0) + 1);
        }
        let scanFailed = false;
        for (const folder of folders) {
          try {
            if ((numbers.get(folder.loadNumber.toLowerCase()) ?? 0) > 1) {
              throw new RequestError("This load number appears in multiple folders; resolve the duplicate layout before importing", 409);
            }
            const existing = db.prepare<[string, string], LoadRecord>(
              "SELECT * FROM loads WHERE load_number = ? AND load_type = ?"
            ).get(folder.loadNumber, type) ?? db.prepare<[string], LoadRecord>(
              "SELECT * FROM loads WHERE folder_ref = ?"
            ).get(folder.folderRef);
            if (existing?.archived_at) {
              summary.skippedArchived++;
              continue;
            }
            if (existing) assertMatchingFolder(existing, driver.id, folder.folderRef);
            const files = await storage.listFolderFiles(folder.folderRef);
            const imported = db.transaction(() => {
              let id = existing?.id;
              if (id === undefined) {
                const result = db.prepare(
                  `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date,
                   delivery_date, rate_amount, status, folder_ref, notes, created_at)
                   VALUES (?, ?, ?, '', '', '', '', 0, 'scheduled', ?, 'Imported from storage sync', ?)`
                ).run(folder.loadNumber, type, driver.id, folder.folderRef, folder.createdAt);
                id = Number(result.lastInsertRowid);
              } else if (!existing?.folder_ref) {
                db.prepare("UPDATE loads SET folder_ref = ? WHERE id = ?").run(folder.folderRef, id);
              }
              let fileCount = 0;
              for (const file of files) {
                const tracked = db.prepare<[string], { load_id: number }>(
                  "SELECT load_id FROM files WHERE storage_ref = ?"
                ).get(file.storageRef);
                if (tracked) {
                  if (tracked.load_id !== id) {
                    throw new RequestError("A document is already tracked under a different load; resolve the conflict first", 409);
                  }
                  continue;
                }
                db.prepare(
                  `INSERT INTO files (load_id, category, filename, storage_ref, web_link, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
                ).run(id, guessCategory(file.filename), file.filename, file.storageRef, file.webLink, file.size, file.createdAt);
                fileCount++;
              }
              return fileCount;
            })();
            if (existing) summary.skippedExisting++;
            else summary.loadsImported++;
            summary.filesImported += imported;
          } catch (error) {
            scanFailed = true;
            summary.errors.push(`${driver.name} / ${type} #${folder.loadNumber}: ${errorMessage(error)}`);
          }
        }
        if (!discoverySucceeded || scanFailed) continue;
        const active = db.prepare<[number, string], Pick<LoadRecord, "id" | "load_number" | "folder_ref">>(
          "SELECT id, load_number, folder_ref FROM loads WHERE driver_id = ? AND load_type = ? AND archived_at IS NULL"
        ).all(driver.id, type);
        for (const load of active) {
          if (folders.some((folder) => sameStorageRef(folder.folderRef, load.folder_ref))) continue;
          try {
            if (await archiveLoadIfMissing(load.id)) summary.loadsArchived++;
          } catch (error) {
            summary.errors.push(`${driver.name} / ${type} #${load.load_number}: ${errorMessage(error)}`);
          }
        }
      }
    }
    return NextResponse.json(summary);
  }));
}
