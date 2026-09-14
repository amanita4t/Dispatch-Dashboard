import { NextResponse } from "next/server";
import db, { LOAD_STATUSES } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const load = db
    .prepare(
      "SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = ?"
    )
    .get(params.id);
  if (!load) return NextResponse.json({ error: "Load not found" }, { status: 404 });
  const files = db
    .prepare("SELECT * FROM files WHERE load_id = ? ORDER BY uploaded_at DESC")
    .all(params.id);
  return NextResponse.json({ ...load, files });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const load = db.prepare("SELECT * FROM loads WHERE id = ?").get(params.id);
  if (!load) return NextResponse.json({ error: "Load not found" }, { status: 404 });

  if (body.status !== undefined) {
    if (!(LOAD_STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    db.prepare("UPDATE loads SET status = ? WHERE id = ?").run(body.status, params.id);
  }
  if (body.notes !== undefined) {
    db.prepare("UPDATE loads SET notes = ? WHERE id = ?").run(String(body.notes), params.id);
  }

  // Editable trip details
  const textFields = ["pickup_city", "delivery_city", "pickup_date", "delivery_date"] as const;
  for (const f of textFields) {
    if (body[f] !== undefined) {
      db.prepare(`UPDATE loads SET ${f} = ? WHERE id = ?`).run(String(body[f]).trim(), params.id);
    }
  }
  if (body.rate_amount !== undefined) {
    const rate = Number(body.rate_amount);
    if (Number.isNaN(rate) || rate < 0) {
      return NextResponse.json({ error: "Invalid rate amount" }, { status: 400 });
    }
    db.prepare("UPDATE loads SET rate_amount = ? WHERE id = ?").run(rate, params.id);
  }

  const updated = db
    .prepare(
      "SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = ?"
    )
    .get(params.id);
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  db.prepare("DELETE FROM loads WHERE id = ?").run(params.id);
  return NextResponse.json({ ok: true });
}
