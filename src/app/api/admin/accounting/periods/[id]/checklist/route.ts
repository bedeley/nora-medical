import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const resolvedParams = await Promise.resolve(params);
  const periodId = String(resolvedParams?.id || "").trim();
  if (!periodId) {
    return NextResponse.json({ error: "Missing period id." }, { status: 400 });
  }

  const period = await prisma.fiscalPeriod.findUnique({
    where: { id: periodId },
  });
  if (!period) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [draftEntries, openReconciliations, cashReconciliations, vatFilings, arOpenBalances, products, totals] = await Promise.all([
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
    prisma.cashReconciliation.count({
      where: {
        countedAt: {
          gte: period.startDate,
          lte: period.endDate,
        },
      },
    }),
    prisma.vatFilingRun.count({
      where: {
        startDate: { lte: period.endDate },
        endDate: { gte: period.startDate },
      },
    }),
    prisma.balance.count({
      where: {
        balance: { gt: 0 },
      },
    }),
    prisma.product.findMany({
      select: { stock: true, cost: true },
    }),
    loadAccountTotals(),
  ]);

  const inventoryRow = totals.find((row) => row.code === "1200");
  const inventoryLedgerBalance = inventoryRow ? toNet(inventoryRow) : 0;
  const inventoryValuation = products.reduce(
    (sum, product) => sum + Number(product.cost || 0) * Number(product.stock || 0),
    0,
  );
  const inventoryDifference = Number((inventoryLedgerBalance - inventoryValuation).toFixed(2));
  const negativeStockCount = products.filter((p) => Number(p.stock || 0) < 0).length;

  return NextResponse.json({
    periodId: period.id,
    status: period.status,
    draftEntries,
    openReconciliations,
    cashReconciliations,
    vatFilings,
    arOpenBalances,
    inventoryDifference,
    negativeStockCount,
  });
}
