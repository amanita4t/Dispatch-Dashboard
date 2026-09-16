import { NextResponse } from "next/server";
import db from "@/lib/db";
import { apiHandler, readJsonObject } from "@/lib/api";
import { assertDriverNameAvailable, findDriver } from "@/lib/loads";
import type { DriverSummary } from "@/lib/models";
import { withDataLock } from "@/lib/mutation-lock";
import { text } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiHandler(() => withDataLock(() => NextResponse.json(db.prepare<[], DriverSummary>(
    `SELECT d.*, COUNT(l.id) AS load_count FROM drivers d LEFT JOIN loads l ON l.driver_id = d.id
     GROUP BY d.id ORDER BY d.name COLLATE NOCASE`
  ).all())));
}

export async function POST(req: Request) {
  return apiHandler(async () => {
    const body = await readJsonObject(req);
    const name = text(body.name, "Driver name", true);
    const phone = text(body.phone ?? "", "Phone");
    const truck = text(body.truck ?? "", "Truck");
    return withDataLock(() => {
      assertDriverNameAvailable(name);
      const result = db.prepare("INSERT INTO drivers (name, phone, truck) VALUES (?, ?, ?)").run(name, phone, truck);
      return NextResponse.json(findDriver(Number(result.lastInsertRowid)), { status: 201 });
    });
  });
}
