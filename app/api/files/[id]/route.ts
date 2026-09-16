import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, RequestError } from "@/lib/api";
import { findLoad } from "@/lib/loads";
import type { FileRecord } from "@/lib/models";
import { getStorage } from "@/lib/storage";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId } from "@/lib/validation";

export const dynamic = "force-dynamic";

function findFile(id: number): FileRecord {
  const file = db.prepare<[number], FileRecord>("SELECT * FROM files WHERE id = ?").get(id);
  if (!file) throw new RequestError("File not found", 404);
  return file;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(async () => {
    const file = findFile(positiveId(params.id));
    const storage = getStorage();
    if (storage.mode === "drive" && file.web_link) return NextResponse.redirect(file.web_link);
    const data = await storage.readFile(file.storage_ref);
    const fallback = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, "%27")}`,
        "Content-Type": "application/octet-stream",
      },
    });
  }));
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(async () => {
    const file = findFile(positiveId(params.id));
    if (findLoad(file.load_id).archived_at) throw new RequestError("Restore this load before deleting documents", 409);
    await getStorage().deleteFile(file.storage_ref);
    db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
    return NextResponse.json({ ok: true });
  }));
}
