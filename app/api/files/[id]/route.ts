import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, RequestError } from "@/lib/api";
import { findLoad } from "@/lib/loads";
import type { FileRecord } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function findFile(id: number): Promise<FileRecord> {
  const file = await db.one<FileRecord>("SELECT * FROM files WHERE id = $1", [id]);
  if (!file) throw new RequestError("File not found", 404);
  return file;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const file = await findFile(positiveId(params.id));
    const storage = getStorage();
    if (storage.mode === "drive") {
      return NextResponse.redirect(file.web_link || `https://drive.google.com/file/d/${encodeURIComponent(file.storage_ref)}/view`);
    }
    return withDataLock(async () => {
      const current = await findFile(file.id);
      const data = await storage.readFile(current.storage_ref);
      const fallback = current.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
      return new NextResponse(new Uint8Array(data), {
        headers: {
          "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(current.filename).replace(/'/g, "%27")}`,
          "Content-Type": "application/octet-stream",
        },
      });
    }, { sharedKeys: [`storage-load:${file.load_id}`] });
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const existing = await findFile(id);
    return withDataLock(async () => {
      const file = await findFile(id);
      if ((await findLoad(file.load_id)).archived_at) throw new RequestError("Restore this load before deleting documents", 409);
      await db.query("DELETE FROM files WHERE id = $1", [id]);
      await db.query("SET CONSTRAINTS ALL IMMEDIATE");
      await getStorage().deleteFile(file.storage_ref);
      db.onRollback(async () => {
        throw new Error("The document was removed from storage, but its database deletion did not commit. Its metadata may need reconciliation.");
      });
      return NextResponse.json({ ok: true });
    }, { keys: [`load:${existing.load_id}`, `storage-load:${existing.load_id}`] });
  });
}
