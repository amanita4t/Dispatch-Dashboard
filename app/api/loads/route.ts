import { NextResponse } from "next/server";
import { apiHandler, readFormData } from "@/lib/api";
import { withDataLock } from "@/lib/mutation-lock";
import { createLoad, listLoads } from "@/lib/loads";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return apiHandler(() => withDataLock(() => NextResponse.json(listLoads(new URL(req.url).searchParams))));
}

export async function POST(req: Request) {
  return apiHandler(async () => {
    const form = await readFormData(req);
    return withDataLock(async () => NextResponse.json(await createLoad(form), { status: 201 }));
  });
}
