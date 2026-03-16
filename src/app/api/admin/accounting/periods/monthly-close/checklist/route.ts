import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { isValidMonthKey, loadMonthlyCloseRows } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const month = String(searchParams.get("month") || "").trim();
  if (!isValidMonthKey(month)) {
    return NextResponse.json({ error: "Month must be YYYY-MM." }, { status: 400 });
  }

  const [y, m] = month.split("-");
  const year = Number(y);
  const monthIdx = Number(m) - 1;
  const start = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999));

  const [draftEntries, openReconciliations, closedRows] = await Promise.all([
    prisma.journalEntry.count({
      where: {
        status: "DRAFT",
        entryDate: { gte: start, lte: end },
      },
    }),
    prisma.reconciliation.count({
      where: {
        status: { not: "CLOSED" },
        periodStart: { lte: end },
        periodEnd: { gte: start },
      },
    }),
    loadMonthlyCloseRows(),
  ]);

  const isClosed = closedRows.some((row) => row.month === month);
  return NextResponse.json({
    month,
    isClosed,
    draftEntries,
    openReconciliations,
    blockers: draftEntries + openReconciliations,
  });
}

