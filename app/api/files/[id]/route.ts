import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(params.id) as any;
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

  const storage = getStorage();
  if (storage.mode === "drive" && file.web_link) {
    return NextResponse.redirect(file.web_link);
  }
  try {
    const buf = await storage.readFile(file.storage_ref);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Download failed: ${e.message}` }, { status: 502 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(params.id) as any;
  if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });
  try {
    await getStorage().deleteFile(file.storage_ref);
  } catch {
    // remove DB record even if the physical file is already gone
  }
  db.prepare("DELETE FROM files WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
