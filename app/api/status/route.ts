import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { apiHandler } from "@/lib/api";
import db from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return apiHandler(async () => {
    const storage = getStorage();
    await db.query("SELECT 1");
    return NextResponse.json({ storage: storage.mode, readOnly: storage.readOnly, database: "postgresql" });
  });
}
