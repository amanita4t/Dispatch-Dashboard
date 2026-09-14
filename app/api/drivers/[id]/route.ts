import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(params.id) as
    | { id: number; name: string }
    | undefined;
  if (!driver) return NextResponse.json({ error: "Driver not found" }, { status: 404 });

  const newName = body.name !== undefined ? String(body.name).trim() : undefined;
  if (newName !== undefined && !newName) {
    return NextResponse.json({ error: "Driver name cannot be empty" }, { status: 400 });
  }

  // Rename the storage folder first so a failure leaves the DB untouched
  if (newName && newName !== driver.name) {
    const clash = db
      .prepare("SELECT id FROM drivers WHERE name = ? AND id != ?")
      .get(newName, params.id);
    if (clash) {
      return NextResponse.json(
        { error: "A driver with that name already exists" },
        { status: 409 }
      );
    }
    let renamed: { oldPrefix: string; newPrefix: string } | null = null;
    try {
      renamed = await getStorage().renameDriverFolder(driver.name, newName);
    } catch (e: any) {
      return NextResponse.json({ error: e.message || "Storage rename failed" }, { status: 409 });
    }
    if (renamed) {
      // Local storage refs embed the path — rewrite them to the new prefix
      const loads = db
        .prepare("SELECT id, folder_ref FROM loads WHERE driver_id = ?")
        .all(params.id) as { id: number; folder_ref: string }[];
      const updLoad = db.prepare("UPDATE loads SET folder_ref = ? WHERE id = ?");
      const files = db
        .prepare(
          "SELECT f.id, f.storage_ref FROM files f JOIN loads l ON l.id = f.load_id WHERE l.driver_id = ?"
        )
        .all(params.id) as { id: number; storage_ref: string }[];
      const updFile = db.prepare("UPDATE files SET storage_ref = ? WHERE id = ?");
      db.transaction(() => {
        for (const l of loads) {
          if (l.folder_ref?.startsWith(renamed!.oldPrefix)) {
            updLoad.run(renamed!.newPrefix + l.folder_ref.slice(renamed!.oldPrefix.length), l.id);
          }
        }
        for (const f of files) {
          if (f.storage_ref?.startsWith(renamed!.oldPrefix)) {
            updFile.run(renamed!.newPrefix + f.storage_ref.slice(renamed!.oldPrefix.length), f.id);
          }
        }
      })();
    }
    db.prepare("UPDATE drivers SET name = ? WHERE id = ?").run(newName, params.id);
  }

  if (body.phone !== undefined) {
    db.prepare("UPDATE drivers SET phone = ? WHERE id = ?").run(String(body.phone).trim(), params.id);
  }
  if (body.truck !== undefined) {
    db.prepare("UPDATE drivers SET truck = ? WHERE id = ?").run(String(body.truck).trim(), params.id);
  }

  const updated = db.prepare("SELECT * FROM drivers WHERE id = ?").get(params.id);
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const loadCount = db
    .prepare("SELECT COUNT(*) AS c FROM loads WHERE driver_id = ?")
    .get(params.id) as { c: number };
  if (loadCount.c > 0) {
    return NextResponse.json(
      { error: "Cannot delete a driver that has loads assigned" },
      { status: 409 }
    );
  }
  db.prepare("DELETE FROM drivers WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
