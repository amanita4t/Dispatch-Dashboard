import { NextResponse } from "next/server";
import { apiHandler, readJsonObject } from "@/lib/api";
import { archiveLoad, editLoad, loadDetail } from "@/lib/loads";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => NextResponse.json(await loadDetail(positiveId(params.id))));
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const body = await readJsonObject(req);
    return withDataLock(async () => NextResponse.json(await editLoad(id, body)), {
      keys: [`load:${id}`, ...(body.driver_id === undefined ? [] : [`storage-load:${id}`])],
    });
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    return withDataLock(async () => NextResponse.json(await archiveLoad(id, true)), {
      keys: [`load:${id}`, `storage-load:${id}`],
    });
  });
}
