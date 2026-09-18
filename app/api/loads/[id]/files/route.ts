import { NextResponse } from "next/server";
import { apiHandler, readFormData, RequestError } from "@/lib/api";
import { findLoad, insertFile } from "@/lib/loads";
import { getStorage } from "@/lib/storage";
import { withDataLock } from "@/lib/mutation-lock";
import { fileCategory, positiveId, uploadFile } from "@/lib/validation";
import { errorMessage } from "@/lib/errors";
import db from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const form = await readFormData(req);
    const file = uploadFile(form.get("file"), "Document");
    const category = fileCategory(form.get("category") || "other");
    return withDataLock(async () => {
      const load = await findLoad(id);
      if (load.archived_at) throw new RequestError("Restore this load before uploading documents", 409);
      const storage = getStorage();
      const saved = await storage.saveFile(load.folder_ref, file.name, Buffer.from(await file.arrayBuffer()), file.type || "application/octet-stream");
      db.onRollback(async () => {
        try { await storage.deleteFile(saved.storageRef); }
        catch (cleanupError) {
          throw new Error(`Failed to remove the untracked upload: ${errorMessage(cleanupError)}`);
        }
      });
      return NextResponse.json(await insertFile(id, category, file, saved), { status: 201 });
    }, { keys: [`load:${id}`] });
  });
}
