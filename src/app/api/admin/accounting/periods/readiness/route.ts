import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const periods = await prisma.fiscalPeriod.findMany({
    select: { id: true, startDate: true, endDate: true, status: true },
    orderBy: { startDate: "desc" },
  });

  if (periods.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const [arOpenBalances, products, totals] = await Promise.all([
    prisma.balance.count({
      where: { balance: { gt: 0 } },
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

  const rows = await Promise.all(
    periods.map(async (period) => {
      const [draftEntries, openReconciliations, cashReconciliations, vatFilings] = await Promise.all([
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
      ]);

      const checks = [
        Math.abs(inventoryDifference) <= 0.01,
        negativeStockCount === 0,
      ];
      const systemReadyCount = checks.filter(Boolean).length;
      const systemTotal = checks.length;
      const hasBlocker = negativeStockCount > 0;
      const status = hasBlocker ? "BLOCKED" : systemReadyCount === systemTotal ? "READY" : "ATTENTION";

      return {
        periodId: period.id,
        status,
        readyCount: systemReadyCount,
        totalChecks: systemTotal,
        draftEntries,
        openReconciliations,
        cashReconciliations,
        vatFilings,
        arOpenBalances,
        inventoryDifference,
        negativeStockCount,
      };
    }),
  );

  return NextResponse.json({ rows });
}
