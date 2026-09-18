import { NextResponse } from "next/server";
import { errorMessage, hasErrorCode } from "./errors";
import { uploadLimitError } from "./upload-limits";

const MAX_MULTIPART_BYTES = 4_250_000;

export class RequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "RequestError";
  }
}

export async function apiHandler(action: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (hasErrorCode(error, "23505")) {
      return NextResponse.json({ error: "This record or storage reference already exists. Refresh before retrying." }, { status: 409 });
    }
    if (hasErrorCode(error, "23503")) {
      return NextResponse.json({ error: "An assigned driver or load changed. Refresh before retrying." }, { status: 409 });
    }
    if (["40001", "40P01", "55P03"].some((code) => hasErrorCode(error, code))) {
      return NextResponse.json({ error: "Another operation is changing this data. Please retry." }, { status: 409 });
    }
    if (!(error instanceof RequestError)) console.error(`[dispatch] ${errorMessage(error)}`);
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: error instanceof RequestError ? error.status : 500 }
    );
  }
}

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new RequestError("Invalid JSON body");
    throw error;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RequestError("A JSON object is required");
  }
  return body as Record<string, unknown>;
}

export async function readFormData(req: Request): Promise<FormData> {
  const tooLarge = () => new RequestError(
    "Uploads are limited to 4 MB total per request. Add larger documents directly in Google Drive, then Sync storage.", 413
  );
  if (Number(req.headers.get("content-length")) > MAX_MULTIPART_BYTES) throw tooLarge();
  if (!req.body) throw new RequestError("Valid form data is required for this upload");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MULTIPART_BYTES) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: req.headers }).formData();
  } catch (error) {
    if (error instanceof TypeError) throw new RequestError("Valid form data is required for this upload");
    throw error;
  }
  const limitError = uploadLimitError(form);
  if (limitError) throw new RequestError(limitError, 413);
  return form;
}
