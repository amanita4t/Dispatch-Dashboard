import { NextResponse } from "next/server";
import db, { LOAD_TYPES } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

function guessCategory(filename: string): string {
  const f = filename.toLowerCase();
  if (f.includes("bol") || f.includes("bill of lading")) return "bol";
  if (f.includes("lumper")) return "lumper_receipt";
  if (f.includes("invoice")) return "invoice";
  if (f.includes("rate") || f.includes("ratecon") || f.includes("rc")) return "rate_confirmation";
  return "other";
}

/**
 * Scans storage (Google Drive or local) for manually created
 * "Load #<num>" folders under each registered driver's folder and
 * imports any loads/files the dashboard doesn't know about yet.
 */
export async function POST() {
  const storage = getStorage();
  const drivers = db.prepare("SELECT id, name FROM drivers").all() as {
    id: number;
    name: string;
  }[];

  const summary = {
    driversScanned: drivers.length,
    loadsImported: 0,
    filesImported: 0,
    skippedExisting: 0,
    errors: [] as string[],
  };

  const insertLoad = db.prepare(
    `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date, delivery_date, rate_amount, status, folder_ref, notes, created_at)
     VALUES (?, ?, ?, '', '', '', '', 0, 'scheduled', ?, ?, ?)`
  );
  const insertFile = db.prepare(
    `INSERT INTO files (load_id, category, filename, storage_ref, web_link, size, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const loadByNumber = db.prepare(
    "SELECT id, folder_ref FROM loads WHERE load_number = ? AND load_type = ?"
  );
  const fileByRef = db.prepare("SELECT id FROM files WHERE storage_ref = ?");
  const updateFolderRef = db.prepare("UPDATE loads SET folder_ref = ? WHERE id = ?");

  for (const driver of drivers) {
    for (const loadType of LOAD_TYPES) {
      let folders;
      try {
        folders = await storage.listLoadFolders(driver.name, loadType);
      } catch (e: any) {
        summary.errors.push(`${driver.name} (${loadType}): ${e.message}`);
        continue;
      }

      for (const folder of folders) {
        try {
          const existing = loadByNumber.get(folder.loadNumber, loadType) as
            | { id: number; folder_ref: string }
            | undefined;

          let loadId: number;
          if (existing) {
            summary.skippedExisting++;
            loadId = existing.id;
            if (!existing.folder_ref) updateFolderRef.run(folder.folderRef, loadId);
          } else {
            const info = insertLoad.run(
              folder.loadNumber,
              loadType,
              driver.id,
              folder.folderRef,
              "Imported from storage sync",
              folder.createdAt
            );
            loadId = info.lastInsertRowid as number;
            summary.loadsImported++;
          }

          // import files not yet tracked (for both new and existing loads)
          const files = await storage.listFolderFiles(folder.folderRef);
          for (const f of files) {
            if (fileByRef.get(f.storageRef)) continue;
            insertFile.run(
              loadId,
              guessCategory(f.filename),
              f.filename,
              f.storageRef,
              f.webLink,
              f.size,
              f.createdAt
            );
            summary.filesImported++;
          }
        } catch (e: any) {
          summary.errors.push(
            `${driver.name} / ${loadType === "loadout" ? "Loadout" : "Load"} #${folder.loadNumber}: ${e.message}`
          );
        }
      }
    }
  }

  return NextResponse.json(summary);
}
