import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { APP_STAGE, isLiveStage } from "@/lib/env";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

export async function GET() {
  if (isLiveStage()) {
    const session = await getServerSession(authOptions);
    const user = session?.user as AuthenticatedUser | undefined;
    if (!session || user?.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return NextResponse.json({
    ok: dbOk,
    ...(isLiveStage() ? {} : { stage: APP_STAGE }),
  });
}
