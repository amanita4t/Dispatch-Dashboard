import { NextResponse } from "next/server";
import { driveConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ storage: driveConfigured() ? "drive" : "local" });
}
