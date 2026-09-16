import { NextResponse } from "next/server";
import { apiHandler, readJsonObject, RequestError } from "@/lib/api";
import { assertLocalBackupsEnabled, restoreBackup } from "@/lib/backup";
import { withDataLock } from "@/lib/mutation-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return apiHandler(async () => {
    assertLocalBackupsEnabled();
    const body = await readJsonObject(req);
    if (body.confirmation !== "RESTORE LOCAL DATA") {
      throw new RequestError("Type RESTORE LOCAL DATA to confirm replacement of the current LOCAL dataset.");
    }
    return withDataLock(async () => NextResponse.json(await restoreBackup(params.id)));
  });
}
