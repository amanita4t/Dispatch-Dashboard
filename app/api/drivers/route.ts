import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, readJsonObject } from "@/lib/api";
import { assertDriverNameAvailable } from "@/lib/loads";
import type { DriverRecord, DriverSummary } from "@/lib/models";
import { withDataLock } from "@/lib/mutation-lock";
import { text } from "@/lib/validation";
import { assertStorageWritable, getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return apiHandler(async () => NextResponse.json(await db.all<DriverSummary>(
    `SELECT d.*, COUNT(l.id)::int AS load_count FROM drivers d LEFT JOIN loads l ON l.driver_id = d.id
     GROUP BY d.id ORDER BY lower(d.name), d.id`
  )));
}

export async function POST(req: Request) {
  return apiHandler(async () => {
    const body = await readJsonObject(req);
    const name = text(body.name, "Driver name", true);
    const phone = text(body.phone ?? "", "Phone");
    const truck = text(body.truck ?? "", "Truck");
    return withDataLock(async () => {
      assertStorageWritable(getStorage());
      await assertDriverNameAvailable(name);
      const driver = await db.one<DriverRecord>(
        "INSERT INTO drivers (name, phone, truck) VALUES ($1, $2, $3) RETURNING *", [name, phone, truck]
      );
      if (!driver) throw new Error("Created driver record could not be read");
      return NextResponse.json(driver, { status: 201 });
    }, { drivers: "exclusive" });
  });
}
