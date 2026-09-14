import { NextResponse } from "next/server";
import db, { FILE_CATEGORIES } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const load = db
    .prepare(
      "SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = ?"
    )
    .get(params.id) as any;
  if (!load) return NextResponse.json({ error: "Load not found" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const category = String(form.get("category") || "other");
  if (!file || file.size === 0) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const cat = (FILE_CATEGORIES as readonly string[]).includes(category) ? category : "other";

  try {
    const storage = getStorage();
    const buf = Buffer.from(await file.arrayBuffer());
    const saved = await storage.saveFile(
      load.driver_name,
      load.load_number,
      (load.load_type || "load") as any,
      file.name,
      buf,
      file.type || "application/octet-stream"
    );
    const info = db
      .prepare(
        `INSERT INTO files (load_id, category, filename, storage_ref, web_link, size) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(load.id, cat, file.name, saved.storageRef, saved.webLink, file.size);
    const rec = db.prepare("SELECT * FROM files WHERE id = ?").get(info.lastInsertRowid);
    return NextResponse.json(rec, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: `Upload failed: ${e.message}` }, { status: 502 });
  }
}
