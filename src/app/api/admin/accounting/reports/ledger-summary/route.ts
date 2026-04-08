import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfWeek, format, parseISO, isValid, startOfDay, endOfDay } from "date-fns";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const DEFAULT_ACCOUNT_CODES = {
  CASH: "1000",
  BANK: "1010",
  AR: "1100",
  INVENTORY: "1200",
  AP: "2000",
  VAT_PAYABLE: "2100",
  SALES: "4000",
  SALES_DISCOUNTS: "4010",
  COGS: "5000",
  OPERATING_EXPENSE: "6000",
  PAYROLL_EXPENSE: "6100",
};

async function getAccountCodes() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  return {
    ...DEFAULT_ACCOUNT_CODES,
    ...(value as Record<string, string> | null),
  };
}

const formatKey = (groupBy: string, d: Date) => {
  if (groupBy === "year") return format(d, "yyyy");
  if (groupBy === "month") return format(d, "yyyy-MM");
  if (groupBy === "week") {
    const wk = startOfWeek(d, { weekStartsOn: 1 });
    return format(wk, "RRRR-'W'II");
  }
  return format(d, "yyyy-MM-dd");
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const customer = searchParams.get("customer");
  const category = searchParams.get("category");
  const groupBy = (searchParams.get("groupBy") as "day" | "week" | "month" | "year") || "day";

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
  if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));

  const accountCodes = await getAccountCodes();
  const salesCode = accountCodes.SALES;
  const salesDiscountsCode = accountCodes.SALES_DISCOUNTS || "4010";
  const cogsCode = accountCodes.COGS;
  const vatPayableCode = accountCodes.VAT_PAYABLE;
  const payrollCode = accountCodes.PAYROLL_EXPENSE;
  const cashCode = accountCodes.CASH;
  const bankCode = accountCodes.BANK;

  const hasCustomerFilter = Boolean(customer);
  const hasCategoryFilter = Boolean(category);
  const [orderIds, paymentIds, expenseIds] = await Promise.all([
    hasCustomerFilter
      ? prisma.order.findMany({
          where: {
            createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
            NOT: { status: { in: ["CANCELLED", "CANCELED"] } },
            user: { name: { contains: customer as string, mode: "insensitive" } },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    hasCustomerFilter
      ? prisma.payment.findMany({
          where: {
            deletedAt: null,
            createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
            status: { not: "VOID" },
            user: { name: { contains: customer as string, mode: "insensitive" } },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    hasCategoryFilter
      ? prisma.expense.findMany({
          where: {
            createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
            category: { contains: category as string, mode: "insensitive" },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const entryFilters: Array<{ sourceType: "ORDER" | "PAYMENT" | "EXPENSE"; sourceId?: { in: string[] } }> = [];
  if (hasCustomerFilter) {
    entryFilters.push({ sourceType: "ORDER", sourceId: { in: orderIds.map((o) => o.id) } });
    entryFilters.push({ sourceType: "PAYMENT", sourceId: { in: paymentIds.map((p) => p.id) } });
  } else {
    entryFilters.push({ sourceType: "ORDER" });
    entryFilters.push({ sourceType: "PAYMENT" });
  }
  if (hasCategoryFilter) {
    entryFilters.push({ sourceType: "EXPENSE", sourceId: { in: expenseIds.map((e) => e.id) } });
  } else {
    entryFilters.push({ sourceType: "EXPENSE" });
  }

  const lines = await prisma.journalLine.findMany({
    where: {
      entry: {
        status: "POSTED",
        entryDate: Object.keys(dateFilter).length ? dateFilter : undefined,
        OR: entryFilters,
      },
    },
    include: {
      account: true,
      entry: { select: { entryDate: true, sourceType: true, id: true, sourceId: true } },
    },
  });

  let totalRevenue = 0;
  let totalDiscounts = 0;
  let totalRefunds = 0;
  let totalTaxCollected = 0;
  let totalCOGS = 0;
  let totalExpense = 0;
  let totalCashIn = 0;
  let totalCashOut = 0;
  let totalOrderValue = 0;
  let orderCount = 0;
  const expenseBreakdownMap: Record<string, number> = {};
  const trendMap: Record<string, {
    revenue: number;
    discounts: number;
    refunds: number;
    cogs: number;
    expense: number;
    payrollExpense: number;
    cashIn: number;
    cashOut: number;
    taxCollected: number;
    orderValue: number;
    orderCount: number;
  }> = {};
  const orderSourceStats = new Map<string, { grossRevenue: number; discounts: number; entryDate: Date }>();
  for (const line of lines) {
    const account = line.account;
    const debit = Number(line.debit || 0);
    const credit = Number(line.credit || 0);
    const entryDate = line.entry.entryDate;
    const sourceType = line.entry.sourceType;
    const sourceKey = String(line.entry.sourceId || line.entry.id);
    const key = formatKey(groupBy, entryDate);
    if (!trendMap[key]) {
      trendMap[key] = {
        revenue: 0,
        discounts: 0,
        refunds: 0,
        cogs: 0,
        expense: 0,
        payrollExpense: 0,
        cashIn: 0,
        cashOut: 0,
        taxCollected: 0,
        orderValue: 0,
        orderCount: 0,
      };
    }

    if ((account.code === cashCode || account.code === bankCode) && sourceType === "PAYMENT") {
      totalCashIn += debit;
      totalCashOut += credit;
      trendMap[key].cashIn += debit;
      trendMap[key].cashOut += credit;
    }

    if ((sourceType === "ORDER" || sourceType === "PAYMENT") && account.code === salesCode) {
      const revenueAmount = Math.max(0, credit - debit);
      const refundAmount = Math.max(0, debit - credit);
      if (revenueAmount > 0) {
        totalRevenue += revenueAmount;
        trendMap[key].revenue += revenueAmount;
        if (sourceType === "ORDER") {
          const current = orderSourceStats.get(sourceKey) || {
            grossRevenue: 0,
            discounts: 0,
            entryDate,
          };
          current.grossRevenue += revenueAmount;
          if (entryDate < current.entryDate) current.entryDate = entryDate;
          orderSourceStats.set(sourceKey, current);
        }
      }
      if (refundAmount > 0) {
        totalRefunds += refundAmount;
        trendMap[key].refunds += refundAmount;
      }
      continue;
    }

    if ((sourceType === "ORDER" || sourceType === "PAYMENT") && account.code === salesDiscountsCode) {
      const discountAmount = debit - credit;
      totalDiscounts += discountAmount;
      trendMap[key].discounts += discountAmount;
      if (sourceType === "ORDER") {
        const current = orderSourceStats.get(sourceKey) || {
          grossRevenue: 0,
          discounts: 0,
          entryDate,
        };
        current.discounts += discountAmount;
        if (entryDate < current.entryDate) current.entryDate = entryDate;
        orderSourceStats.set(sourceKey, current);
      }
      continue;
    }

    if ((sourceType === "ORDER" || sourceType === "PAYMENT") && account.code === vatPayableCode) {
      const taxAmount = credit - debit;
      totalTaxCollected += taxAmount;
      trendMap[key].taxCollected += taxAmount;
      continue;
    }

    if (account.type === "INCOME") {
      continue;
    }

    if (account.type === "EXPENSE") {
      const amount = debit - credit;
      if (
        (sourceType === "ORDER" || sourceType === "PAYMENT") &&
        account.code === cogsCode
      ) {
        totalCOGS += amount;
        trendMap[key].cogs += amount;
      } else if (sourceType === "EXPENSE") {
        totalExpense += amount;
        trendMap[key].expense += amount;
        expenseBreakdownMap[account.name] =
          (expenseBreakdownMap[account.name] || 0) + amount;
        if (account.code === payrollCode) {
          trendMap[key].payrollExpense += amount;
        }
      }
    }
  }

  let discountedOrders = 0;
  for (const stats of orderSourceStats.values()) {
    if (stats.grossRevenue <= 0) continue;
    const orderValue = Math.max(0, stats.grossRevenue - Math.max(0, stats.discounts));
    totalOrderValue += orderValue;
    orderCount += 1;
    if (stats.discounts > 0.005) discountedOrders += 1;
    const periodKey = formatKey(groupBy, stats.entryDate);
    if (!trendMap[periodKey]) {
      trendMap[periodKey] = {
        revenue: 0,
        discounts: 0,
        refunds: 0,
        cogs: 0,
        expense: 0,
        payrollExpense: 0,
        cashIn: 0,
        cashOut: 0,
        taxCollected: 0,
        orderValue: 0,
        orderCount: 0,
      };
    }
    trendMap[periodKey].orderValue += orderValue;
    trendMap[periodKey].orderCount += 1;
  }

  const trend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, row]) => {
      const netRevenue = row.revenue - row.discounts - row.refunds;
      const profit = netRevenue - row.cogs - row.expense;
      const margin = netRevenue > 0 ? (profit / netRevenue) * 100 : 0;
      const averageOrderValue =
        row.orderCount > 0 ? row.orderValue / row.orderCount : 0;
      return {
        date: period,
        period,
        revenue: row.revenue,
        refunds: Math.max(0, row.refunds),
        netRevenue,
        cogs: row.cogs,
        expense: row.expense,
        payrollExpense: row.payrollExpense,
        cashIn: row.cashIn,
        cashOut: row.cashOut,
        netCash: row.cashIn - row.cashOut,
        orderCount: row.orderCount,
        averageOrderValue,
        profit,
        margin,
      };
    });

  const normalizedDiscounts = Math.max(0, totalDiscounts);
  const normalizedRefunds = Math.max(0, totalRefunds);
  const netRevenue = totalRevenue - normalizedDiscounts - normalizedRefunds;
  const profit = netRevenue - totalCOGS - totalExpense;
  const margin = netRevenue > 0 ? (profit / netRevenue) * 100 : 0;
  const averageOrderValue = orderCount > 0 ? totalOrderValue / orderCount : 0;
  const expenseBreakdown = Object.entries(expenseBreakdownMap)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return NextResponse.json({
    summary: {
      totalRevenue,
      totalDiscounts: normalizedDiscounts,
      discountedOrders,
      totalRefunds: normalizedRefunds,
      netRevenue,
      totalCOGS,
      totalExpense,
      totalCashIn,
      totalCashOut,
      netCash: totalCashIn - totalCashOut,
      orderCount,
      averageOrderValue,
      totalTaxCollected: Math.max(0, totalTaxCollected),
      profit,
      margin,
      expenseBreakdown,
    },
    trend,
  });
}
