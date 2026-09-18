import { requestJson } from "./client-api";
import { errorMessage } from "./errors";
import type { FileCategory, FileRecord } from "./models";
import { uploadLimitError } from "./upload-limits";

export async function uploadSelectedFiles(loadId: string, category: FileCategory, files: File[]) {
  const uploaded: FileRecord[] = [];
  const failedFiles: File[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("category", category);
      const limitError = uploadLimitError(body);
      if (limitError) throw new Error(limitError);
      uploaded.push(await requestJson<FileRecord>(`/api/loads/${encodeURIComponent(loadId)}/files`, {
        method: "POST",
        body,
      }));
    } catch (failure: unknown) {
      failedFiles.push(file);
      errors.push(`${file.name}: ${errorMessage(failure)}`);
    }
  }

  return { uploaded, failedFiles, errors };
}
