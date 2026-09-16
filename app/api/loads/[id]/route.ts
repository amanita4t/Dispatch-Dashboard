import { NextResponse } from "next/server";
import { apiHandler, readJsonObject } from "@/lib/api";
import { archiveLoad, editLoad, loadDetail } from "@/lib/loads";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(() => NextResponse.json(loadDetail(positiveId(params.id)))));
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const body = await readJsonObject(req);
    return withDataLock(async () => NextResponse.json(await editLoad(id, body)));
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(async () => NextResponse.json(await archiveLoad(positiveId(params.id), true))));
}
