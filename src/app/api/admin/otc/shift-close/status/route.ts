import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import {
  canStaffOpenShiftNow,
  getLatestOtcShiftCloseGlobal,
  getOtcShiftDayStatus,
} from "@/lib/otc-shift-close";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const day = url.searchParams.get("day") || undefined;
  const [status, latestClose] = await Promise.all([
    getOtcShiftDayStatus(day),
    getLatestOtcShiftCloseGlobal(),
  ]);
  const now = new Date();
  return NextResponse.json({
    ...status,
    canOpenNow: isAdmin || (isStaff && canStaffOpenShiftNow(now)),
    openWindowStartHourUtc: 6,
    requiresHandoverAck: Boolean(latestClose?.entityId && !status.isOpen),
    lastClose: latestClose
      ? {
          shiftCloseId: latestClose.entityId,
          createdAt: latestClose.createdAt.toISOString(),
          closedBy: latestClose.actor
            ? {
                id: latestClose.actor.id,
                name: latestClose.actor.name,
                email: latestClose.actor.email,
                role: latestClose.actor.role,
              }
            : null,
        }
      : null,
  });
}
