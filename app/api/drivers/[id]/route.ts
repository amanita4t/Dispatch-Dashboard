import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, readJsonObject, RequestError } from "@/lib/api";
import { editDriver, findDriver } from "@/lib/loads";
import { withDataLock } from "@/lib/mutation-lock";
import { positiveId, text } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    const id = positiveId(params.id);
    const body = await readJsonObject(req);
    return withDataLock(async () => {
      const current = findDriver(id);
      const fields = {
        name: body.name === undefined ? current.name : text(body.name, "Driver name", true),
        phone: body.phone === undefined ? current.phone : text(body.phone, "Phone"),
        truck: body.truck === undefined ? current.truck : text(body.truck, "Truck"),
      };
      return NextResponse.json(await editDriver(id, fields));
    });
  });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  return apiHandler(() => withDataLock(() => {
    const id = positiveId(params.id);
    findDriver(id);
    if (db.prepare("SELECT id FROM loads WHERE driver_id = ? LIMIT 1").get(id)) {
      throw new RequestError("Cannot delete a driver with assigned loads, including archived loads", 409);
    }
    db.prepare("DELETE FROM drivers WHERE id = ?").run(id);
    return NextResponse.json({ ok: true });
  }));
}
