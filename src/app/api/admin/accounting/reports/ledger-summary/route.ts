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
    return format(wk, "yyyy-ww");
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
  const cogsCode = accountCodes.COGS;
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
      entry: { select: { entryDate: true, sourceType: true, id: true } },
    },
  });

  let totalRevenue = 0;
  let totalCOGS = 0;
  let totalExpense = 0;
  let totalCashIn = 0;
  let totalCashOut = 0;
  let totalOrderValue = 0;
  let orderCount = 0;
  const expenseBreakdownMap: Record<string, number> = {};
  const trendMap: Record<string, {
    revenue: number;
    cogs: number;
    expense: number;
    payrollExpense: number;
    cashIn: number;
    cashOut: number;
    orderValue: number;
    orderCount: number;
  }> = {};
  const orderRevenueByEntry = new Map<string, number>();
  const entryDateById = new Map<string, Date>();

  const useSalesCode = Boolean(salesCode);
  for (const line of lines) {
    const account = line.account;
    const debit = Number(line.debit || 0);
    const credit = Number(line.credit || 0);
    const entryDate = line.entry.entryDate;
    const key = formatKey(groupBy, entryDate);
    if (!trendMap[key]) {
      trendMap[key] = {
        revenue: 0,
        cogs: 0,
        expense: 0,
        payrollExpense: 0,
        cashIn: 0,
        cashOut: 0,
        orderValue: 0,
        orderCount: 0,
      };
    }

    if (!entryDateById.has(line.entry.id)) {
      entryDateById.set(line.entry.id, line.entry.entryDate);
    }

    if ((account.code === cashCode || account.code === bankCode) && line.entry.sourceType === "PAYMENT") {
      totalCashIn += debit;
      totalCashOut += credit;
      trendMap[key].cashIn += debit;
      trendMap[key].cashOut += credit;
    }

    if (account.type === "INCOME") {
      const amount = credit - debit;
      if (
        (line.entry.sourceType === "ORDER" || line.entry.sourceType === "PAYMENT") &&
        (!useSalesCode || account.code === salesCode)
      ) {
        totalRevenue += amount;
        trendMap[key].revenue += amount;
        if (line.entry.sourceType === "ORDER") {
          const existing = orderRevenueByEntry.get(line.entry.id) || 0;
          orderRevenueByEntry.set(line.entry.id, existing + amount);
        }
      }
      continue;
    }

    if (account.type === "EXPENSE") {
      const amount = debit - credit;
      if (
        (line.entry.sourceType === "ORDER" || line.entry.sourceType === "PAYMENT") &&
        account.code === cogsCode
      ) {
        totalCOGS += amount;
        trendMap[key].cogs += amount;
      } else if (line.entry.sourceType === "EXPENSE") {
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

  for (const [entryId, value] of orderRevenueByEntry.entries()) {
    totalOrderValue += value;
    orderCount += 1;
    const entryDate = entryDateById.get(entryId);
    if (entryDate) {
      const periodKey = formatKey(groupBy, entryDate);
      if (!trendMap[periodKey]) {
        trendMap[periodKey] = {
          revenue: 0,
          cogs: 0,
          expense: 0,
          payrollExpense: 0,
          cashIn: 0,
          cashOut: 0,
          orderValue: 0,
          orderCount: 0,
        };
      }
      trendMap[periodKey].orderValue += value;
      trendMap[periodKey].orderCount += 1;
    }
  }

  const trend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, row]) => {
      const profit = row.revenue - row.cogs - row.expense;
      const margin = row.revenue > 0 ? (profit / row.revenue) * 100 : 0;
      const averageOrderValue =
        row.orderCount > 0 ? row.orderValue / row.orderCount : 0;
      return {
        date: period,
        period,
        revenue: row.revenue,
        netRevenue: row.revenue,
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

  const profit = totalRevenue - totalCOGS - totalExpense;
  const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;
  const averageOrderValue = orderCount > 0 ? totalOrderValue / orderCount : 0;
  const expenseBreakdown = Object.entries(expenseBreakdownMap)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return NextResponse.json({
    summary: {
      totalRevenue,
      totalCOGS,
      totalExpense,
      totalCashIn,
      totalCashOut,
      netCash: totalCashIn - totalCashOut,
      orderCount,
      averageOrderValue,
      profit,
      margin,
      expenseBreakdown,
    },
    trend,
  });
}
