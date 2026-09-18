import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, readJsonObject, RequestError } from "@/lib/api";
import { editDriver, findDriver } from "@/lib/loads";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId, text } from "@/lib/validation";
import { assertStorageWritable, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const body = await readJsonObject(req);
    return withDataLock(async () => {
      const current = await findDriver(id);
      const fields = {
        name: body.name === undefined ? current.name : text(body.name, "Driver name", true),
        phone: body.phone === undefined ? current.phone : text(body.phone, "Phone"),
        truck: body.truck === undefined ? current.truck : text(body.truck, "Truck"),
      };
      return NextResponse.json(await editDriver(id, fields));
    }, { drivers: "exclusive" });
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(async () => {
    assertStorageWritable(getStorage());
    const id = positiveId(params.id);
    await findDriver(id);
    if (await db.one("SELECT id FROM loads WHERE driver_id = $1 LIMIT 1", [id])) {
      throw new RequestError("Cannot delete a driver with assigned loads, including archived loads", 409);
    }
    await db.query("DELETE FROM drivers WHERE id = $1", [id]);
    return NextResponse.json({ ok: true });
  }, { drivers: "exclusive" }));
}
