import { NextResponse } from "next/server";
import { getStorage } from "@/lib/storage";
import { apiHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return apiHandler(() => NextResponse.json({ storage: getStorage().mode }));
}
