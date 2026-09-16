import { NextResponse } from "next/server";
import { apiHandler, readFormData, RequestError } from "@/lib/api";
import { findLoad, insertFile } from "@/lib/loads";
import { getStorage } from "@/lib/storage";
import { withDataLock } from "@/lib/mutation-lock";
import { fileCategory, positiveId, uploadFile } from "@/lib/validation";
import { errorMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const form = await readFormData(req);
    const file = uploadFile(form.get("file"), "Document");
    const category = fileCategory(form.get("category") || "other");
    return withDataLock(async () => {
      const load = findLoad(id);
      if (load.archived_at) throw new RequestError("Restore this load before uploading documents", 409);
      const storage = getStorage();
      const saved = await storage.saveFile(load.folder_ref, file.name, Buffer.from(await file.arrayBuffer()), file.type || "application/octet-stream");
      try {
        return NextResponse.json(insertFile(id, category, file, saved), { status: 201 });
      } catch (error) {
        try { await storage.deleteFile(saved.storageRef); }
        catch (cleanupError) {
          throw new Error(`${errorMessage(error)}. Failed to remove the untracked upload: ${errorMessage(cleanupError)}`);
        }
        throw error;
      }
    });
  });
}
