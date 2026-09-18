import { NextResponse } from "next/server";
import { legacyBackupUnavailable } from "@/lib/backup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(legacyBackupUnavailable(), {
    status: 410,
    headers: { "Cache-Control": "no-store" },
  });
}
