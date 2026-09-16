import { NextResponse } from "next/server";
import { errorMessage } from "./errors";

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
    if (!(error instanceof RequestError)) console.error(error);
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
  try {
    return await req.formData();
  } catch (error) {
    if (error instanceof TypeError) throw new RequestError("Valid form data is required for this upload");
    throw error;
  }
}
