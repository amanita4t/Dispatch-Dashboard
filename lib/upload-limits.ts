export const MAX_UPLOAD_BYTES = 4_000_000;

export const UPLOAD_LIMIT_MESSAGE =
  "Uploads are limited to 4 MB total per request. Add larger documents directly in Google Drive, then Sync storage.";

export function uploadLimitError(form: FormData): string | null {
  let fileBytes = 0;
  for (const value of Array.from(form.values())) {
    if (typeof value === "string") continue;
    fileBytes += value.size;
    if (fileBytes > MAX_UPLOAD_BYTES) return UPLOAD_LIMIT_MESSAGE;
  }
  return null;
}
