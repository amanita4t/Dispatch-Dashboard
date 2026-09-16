import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api";
import { assertLocalBackupsEnabled, createBackup, listBackups } from "@/lib/backup";
import { withDataLock } from "@/lib/mutation-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return apiHandler(() => {
    assertLocalBackupsEnabled();
    return withDataLock(async () => NextResponse.json(await listBackups(), {
      headers: { "Cache-Control": "no-store" },
    }));
  });
}

export async function POST() {
  return apiHandler(() => {
    assertLocalBackupsEnabled();
    return withDataLock(async () => NextResponse.json({ backup: await createBackup() }, { status: 201 }));
  });
}
