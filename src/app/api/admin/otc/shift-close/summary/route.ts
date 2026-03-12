import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import {
  buildUtcDayRange,
  getLatestOtcPaymentDayUtcYmd,
  getOtcShiftSummary,
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
  let day = url.searchParams.get("day") || undefined;
  if (!day) {
    day = (await getLatestOtcPaymentDayUtcYmd()) || undefined;
  }
  const range = buildUtcDayRange(day);
  const summary = await getOtcShiftSummary(range);

  return NextResponse.json({
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      day: range.from.toISOString().slice(0, 10),
    },
    summary,
  });
}
