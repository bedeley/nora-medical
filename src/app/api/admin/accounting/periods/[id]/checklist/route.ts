import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = await prisma.fiscalPeriod.findUnique({
    where: { id: params.id },
  });
  if (!period) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [draftEntries, openReconciliations] = await Promise.all([
    prisma.journalEntry.count({
      where: {
        status: "DRAFT",
        entryDate: {
          gte: period.startDate,
          lte: period.endDate,
        },
      },
    }),
    prisma.reconciliation.count({
      where: {
        status: { not: "CLOSED" },
        periodStart: { lte: period.endDate },
        periodEnd: { gte: period.startDate },
      },
    }),
  ]);

  return NextResponse.json({
    periodId: period.id,
    status: period.status,
    draftEntries,
    openReconciliations,
  });
}
