import { NextResponse } from "next/server";
import db, { LOAD_STATUSES, LOAD_TYPES, type LoadType } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const q = url.searchParams.get("q");

  let sql = `SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id`;
  const where: string[] = [];
  const args: any[] = [];
  if (status && (LOAD_STATUSES as readonly string[]).includes(status)) {
    where.push("l.status = ?");
    args.push(status);
  }
  if (q) {
    where.push("(l.load_number LIKE ? OR l.pickup_city LIKE ? OR l.delivery_city LIKE ? OR d.name LIKE ?)");
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY l.created_at DESC";

  return NextResponse.json(db.prepare(sql).all(...args));
}

export async function POST(req: Request) {
  const form = await req.formData();

  const loadNumber = String(form.get("load_number") || "").trim();
  const driverId = Number(form.get("driver_id") || 0);
  const pickupCity = String(form.get("pickup_city") || "").trim();
  const deliveryCity = String(form.get("delivery_city") || "").trim();
  const pickupDate = String(form.get("pickup_date") || "").trim();
  const deliveryDate = String(form.get("delivery_date") || "").trim();
  const rateAmount = Number(form.get("rate_amount") || 0);
  const status = String(form.get("status") || "scheduled");
  const loadType = String(form.get("load_type") || "load") as LoadType;
  const rateCon = form.get("rate_confirmation") as File | null;

  if (!loadNumber || !driverId || !pickupCity || !deliveryCity || !pickupDate || !deliveryDate || !rateAmount) {
    return NextResponse.json({ error: "All load fields are required" }, { status: 400 });
  }
  if (!(LOAD_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (!(LOAD_TYPES as readonly string[]).includes(loadType)) {
    return NextResponse.json({ error: "Invalid load type" }, { status: 400 });
  }
  if (!rateCon || rateCon.size === 0) {
    return NextResponse.json({ error: "Rate confirmation file is required" }, { status: 400 });
  }

  const driver = db.prepare("SELECT * FROM drivers WHERE id = ?").get(driverId) as
    | { id: number; name: string }
    | undefined;
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 400 });
  }
  const existing = db
    .prepare("SELECT id FROM loads WHERE load_number = ? AND load_type = ?")
    .get(loadNumber, loadType);
  if (existing) {
    const label = loadType === "loadout" ? "Loadout" : "Load";
    return NextResponse.json({ error: `${label} #${loadNumber} already exists` }, { status: 409 });
  }

  const storage = getStorage();

  // One folder per load number: block creation if the folder already exists
  // in storage (e.g. pre-existing loads in Google Drive not tracked by the app).
  try {
    if (await storage.loadFolderExists(driver.name, loadNumber, loadType)) {
      const folderName = loadType === "loadout" ? `Loadout #${loadNumber}` : `Load #${loadNumber}`;
      return NextResponse.json(
        {
          error: `A folder "${folderName}" already exists in ${driver.name}'s ${loadType === "loadout" ? "Loadout" : "Loads"} folder. This load already exists — use a different load number or manage the existing folder.`,
        },
        { status: 409 }
      );
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: `Failed to check for existing load folder: ${e.message}` },
      { status: 502 }
    );
  }

  let folderRef = "";
  try {
    folderRef = await storage.ensureLoadFolder(driver.name, loadNumber, loadType);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Failed to create load folder: ${e.message}` },
      { status: 502 }
    );
  }

  const info = db
    .prepare(
      `INSERT INTO loads (load_number, load_type, driver_id, pickup_city, delivery_city, pickup_date, delivery_date, rate_amount, status, folder_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(loadNumber, loadType, driverId, pickupCity, deliveryCity, pickupDate, deliveryDate, rateAmount, status, folderRef);
  const loadId = info.lastInsertRowid as number;

  // Save uploaded files: rate_confirmation required, others optional
  const uploads: { category: string; file: File }[] = [
    { category: "rate_confirmation", file: rateCon },
  ];
  for (const [key, cat] of [
    ["bol", "bol"],
    ["other_1", "other"],
    ["other_2", "other"],
  ] as const) {
    const f = form.get(key) as File | null;
    if (f && f.size > 0) uploads.push({ category: cat, file: f });
  }

  const errors: string[] = [];
  for (const { category, file } of uploads) {
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const saved = await storage.saveFile(
        driver.name,
        loadNumber,
        loadType,
        file.name,
        buf,
        file.type || "application/octet-stream"
      );
      db.prepare(
        `INSERT INTO files (load_id, category, filename, storage_ref, web_link, size) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(loadId, category, file.name, saved.storageRef, saved.webLink, file.size);
    } catch (e: any) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }

  const load = db
    .prepare("SELECT l.*, d.name AS driver_name FROM loads l JOIN drivers d ON d.id = l.driver_id WHERE l.id = ?")
    .get(loadId);
  return NextResponse.json({ load, uploadErrors: errors }, { status: 201 });
}
