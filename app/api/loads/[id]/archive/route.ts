import { NextResponse } from "next/server";
import { apiHandler, readJsonObject, RequestError } from "@/lib/api";
import { archiveLoad } from "@/lib/loads";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const body = await readJsonObject(req);
    if (typeof body.archived !== "boolean") throw new RequestError("archived must be true or false");
    const archived = body.archived;
    return withDataLock(async () => NextResponse.json(await archiveLoad(id, archived)));
  });
}
