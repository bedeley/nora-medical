import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { APP_STAGE } from "@/lib/env";

export async function GET() {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return NextResponse.json({
    ok: dbOk,
    stage: APP_STAGE,
  });
}
