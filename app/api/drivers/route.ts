import { NextResponse } from "next/server";
import db from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const drivers = db
    .prepare(
      `SELECT d.*, COUNT(l.id) AS load_count
       FROM drivers d LEFT JOIN loads l ON l.driver_id = d.id
       GROUP BY d.id ORDER BY d.name`
    )
    .all();
  return NextResponse.json(drivers);
}

export async function POST(req: Request) {
  const body = await req.json();
  const name = (body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "Driver name is required" }, { status: 400 });
  }
  try {
    const info = db
      .prepare("INSERT INTO drivers (name, phone, truck) VALUES (?, ?, ?)")
      .run(name, (body.phone || "").trim(), (body.truck || "").trim());
    const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(info.lastInsertRowid);
    return NextResponse.json(driver, { status: 201 });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) {
      return NextResponse.json({ error: "A driver with that name already exists" }, { status: 409 });
    }
    throw e;
  }
}
