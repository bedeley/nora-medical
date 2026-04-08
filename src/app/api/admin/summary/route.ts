import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfDay, endOfDay, parseISO, isValid, format, startOfWeek } from "date-fns";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { recordAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";

function humanizeGroupBy(value: "day" | "week" | "month" | "year") {
  if (value === "day") return "daily";
  if (value === "week") return "weekly";
  if (value === "month") return "monthly";
  return "yearly";
}

type PaymentNoteMeta = {
  reference?: string;
  location?: string;
  restockToStock?: boolean;
  restock?: boolean;
  restocked?: boolean;
  item?: { id?: string; quantity?: number };
};

type ReturnLogMeta = {
  itemId?: string;
  quantity?: number;
  refundAmount?: number;
  appliedToBalance?: number;
  disposition?: string;
  restockToStock?: boolean;
  restock?: boolean;
  restocked?: boolean;
};

type TrendBucket = {
  revenue: number;
  cogs: number;
  expense: number;
  payrollExpense: number;
  refunds: number;
  cashIn: number;
  cashOut: number;
  outstanding: number;
  orderCount: number;
  orderValue: number;
  delivered: number;
  partial: number;
  returned: number;
  pending: number;
};

function createTrendBucket(): TrendBucket {
  return {
    revenue: 0,
    cogs: 0,
    expense: 0,
    payrollExpense: 0,
    refunds: 0,
    cashIn: 0,
    cashOut: 0,
    outstanding: 0,
    orderCount: 0,
    orderValue: 0,
    delivered: 0,
    partial: 0,
    returned: 0,
    pending: 0,
  };
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { role?: string } | undefined;

  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const customer = searchParams.get("customer");
    const category = searchParams.get("category");
    const groupBy = (searchParams.get("groupBy") as "day" | "week" | "month" | "year") || "day";
    const formatType = searchParams.get("format");

    // Optional date filter
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
    if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));

    // Sales (Orders and Items) for accrual revenue + COGS
    const orders = await prisma.order.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
        NOT: { status: { in: ["CANCELLED", "CANCELED"] } },
        ...(customer
          ? { user: { name: { contains: customer, mode: "insensitive" } } }
          : {}),
      },
      select: {
        id: true,
        createdAt: true,
        total: true,
        subtotal: true,
        taxAmount: true,
        amountPaid: true,
        balance: true,
        deliveryStatus: true,
        items: {
          select: {
            quantity: true,
            price: true,
            costAtSale: true,
            product: { select: { cost: true } },
          },
        },
      },
    });

    // Expenses
    const expenses = await prisma.expense.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
        ...(category
          ? {
              category: { contains: category, mode: "insensitive" },
            }
          : {}),
      },
      select: { amount: true, createdAt: true, category: true },
    });
    const manualExpenseLines = await prisma.journalLine.findMany({
      where: {
        entry: {
          status: "POSTED",
          sourceType: "EXPENSE",
          sourceId: null,
          entryDate: Object.keys(dateFilter).length ? dateFilter : undefined,
        },
      },
      include: {
        account: { select: { name: true, type: true } },
        entry: { select: { entryDate: true } },
      },
    });

    const payments = await prisma.payment.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
        ...(customer
          ? { user: { name: { contains: customer, mode: "insensitive" } } }
          : {}),
      },
      select: { amount: true, status: true, createdAt: true, refundDisposition: true, note: true, orderId: true },
    });

    const orderIdsForReturns = Array.from(
      new Set(orders.map((o) => o.id).filter((id): id is string => Boolean(id))),
    );
    const returnLogs = await prisma.auditLog.findMany({
      where: {
        action: "ORDER_ITEM_RETURN",
        createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
        ...(orderIdsForReturns.length ? { entityId: { in: orderIdsForReturns } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    // Grouping key
    const formatKey = (d: Date) => {
      if (groupBy === "year") return format(d, "yyyy");
      if (groupBy === "month") return format(d, "yyyy-MM");
      if (groupBy === "week") {
        const wk = startOfWeek(d, { weekStartsOn: 1 });
        return format(wk, "RRRR-'W'II");
      }
      return format(d, "yyyy-MM-dd");
    };

    // Totals
    let totalRevenue = 0;
    let totalDiscounts = 0;
    let discountedOrders = 0;
    let totalBilled = 0;
    let totalTaxCollected = 0;
    let totalCollectedOnPeriodSales = 0;
    let totalCOGS = 0;
    let totalOutstanding = 0;
    let orderCount = 0;
    let totalOrderValue = 0;
    let deliveredCount = 0;
    let partiallyDeliveredCount = 0;
    let returnedCount = 0;
    let pendingCount = 0;
      for (const o of orders) {
        orderCount += 1;
        const computedOutstanding = Math.max(
          0,
          Number(o.total || 0) - Number(o.amountPaid || 0),
        );
        totalOutstanding += computedOutstanding;
        const deliveryStatus = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
      if (deliveryStatus === "DELIVERED") deliveredCount += 1;
      else if (deliveryStatus === "PARTIALLY_DELIVERED") partiallyDeliveredCount += 1;
      else if (deliveryStatus === "RETURNED") returnedCount += 1;
      else pendingCount += 1;
      let orderRevenue = Number(o.subtotal ?? 0);
      if (!(orderRevenue > 0)) {
        orderRevenue = 0;
        for (const it of o.items) {
          const qty = Number(it.quantity || 0);
          orderRevenue += Number(it.price || 0) * qty;
        }
        if (orderRevenue <= 0) {
          orderRevenue = Number(o.total ?? 0);
        }
      }
      const orderTotal = Math.max(0, Number(o.total || 0));
      let orderTax = Number(o.taxAmount ?? NaN);
      const subtotalRaw = Number(o.subtotal ?? NaN);
      if (!(Number.isFinite(orderTax) && orderTax >= 0)) {
        if (Number.isFinite(subtotalRaw) && subtotalRaw >= 0) {
          orderTax = Math.max(0, orderTotal - subtotalRaw);
        } else {
          orderTax = Math.max(0, orderTotal - orderRevenue);
        }
      }
      // Keep revenue on a pre-tax basis even for older rows with sparse subtotal fields.
      if (!(Number(o.subtotal ?? NaN) > 0) && orderRevenue >= orderTotal && orderTax > 0) {
        orderRevenue = Math.max(0, orderTotal - orderTax);
      }
      const grossBeforeDiscount =
        Number.isFinite(subtotalRaw) && subtotalRaw >= 0
          ? subtotalRaw + orderTax
          : orderTotal;
      const orderDiscount = Math.max(0, grossBeforeDiscount - orderTotal);
      if (orderDiscount > 0.005) {
        discountedOrders += 1;
        totalDiscounts += orderDiscount;
      }
      for (const it of o.items) {
        const qty = Number(it.quantity || 0);
        const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
        totalCOGS += unitCost * qty;
      }
      totalRevenue += orderRevenue;
      totalOrderValue += orderRevenue;
      const paidRaw = Number(o.amountPaid || 0);
      const paidClamped = Math.max(0, Math.min(orderTotal, paidRaw));
      totalBilled += orderTotal;
      totalTaxCollected += orderTax;
      totalCollectedOnPeriodSales += paidClamped;
    }
    const trendMap: Record<string, TrendBucket> = {};
    const getTrendBucket = (key: string) => {
      if (!trendMap[key]) {
        trendMap[key] = createTrendBucket();
      }
      return trendMap[key];
    };
    let totalRefunds = 0;
    let totalCashIn = 0;
    let totalCashOut = 0;
    const returnPayments: Array<{ orderId: string | null; amount: number; createdAt: Date }> = [];
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      const note = typeof p.note === "string" ? p.note : "";
      let meta: PaymentNoteMeta | null = null;
      if (note.startsWith("{")) {
        try {
          meta = JSON.parse(note) as PaymentNoteMeta;
        } catch {}
      }
      const reference =
        meta?.reference || (note.includes("\"reference\":\"ITEM_RETURN\"") ? "ITEM_RETURN" : "");
      const isAutoApply =
        reference === "AUTO_APPLY" || note.includes("\"reference\":\"AUTO_APPLY\"");
      const isReturn = reference === "ITEM_RETURN";
      const isPendingMomo =
        String((meta as { method?: string } | null)?.method || "").toLowerCase() === "momo" &&
        String((meta as { status?: string } | null)?.status || "")
          .toUpperCase()
          .startsWith("PENDING");
      const isRevenueRefund =
        reference === "SALES_REFUND" || note.includes("\"reference\":\"SALES_REFUND\"");
      const isCreditPayout =
        meta?.location === "admin/customers:credit-payout" ||
        note.includes("\"location\":\"admin/customers:credit-payout\"");
      const refundDisposition = String(p.refundDisposition || "").toUpperCase();
      const isStoreCreditReturn = isReturn && refundDisposition === "CREDIT";
      if (isReturn) {
        returnPayments.push({
          orderId: p.orderId ?? null,
          amount: Math.abs(amount),
          createdAt: p.createdAt,
        });
      }

      if (isReturn) {
        // Return/refund revenue adjustments come from audit logs to avoid double counting.
        // Only update summary totals here; trend cashOut is built in the second payments loop below.
        if (!isStoreCreditReturn && status === "REFUND") {
          const refundAmount = Math.abs(amount);
          totalCashOut += refundAmount;
        }
        continue;
      }
      if (status === "REFUND") {
        const refundAmount = Math.abs(amount);
        totalCashOut += refundAmount;
        if (!isCreditPayout && (isRevenueRefund || isReturn)) {
          totalRefunds += refundAmount;
        }
        continue;
      }
      if (status === "VOID") continue;
      if (isAutoApply) continue;
      if (isPendingMomo) continue;
      if (amount > 0) totalCashIn += amount;
      if (amount < 0) totalCashOut += Math.abs(amount);
    }

    if (returnLogs.length > 0) {
      const parsedReturnLogs = returnLogs.map((log) => {
        let meta: ReturnLogMeta | null = null;
        try {
          meta = log.meta ? (JSON.parse(String(log.meta)) as ReturnLogMeta) : null;
        } catch {
          meta = null;
        }
        const itemId = meta?.itemId || null;
        const quantity = Number(meta?.quantity || 0);
        const refundAmount = Number(meta?.refundAmount || 0);
        const appliedToBalance = Number(meta?.appliedToBalance || 0);
        const refundTotal = refundAmount + appliedToBalance;
        const windowStart = new Date(log.createdAt.getTime() - 10 * 60 * 1000);
        const windowEnd = new Date(log.createdAt.getTime() + 10 * 60 * 1000);
        // Key uses refundAmount (cash paid out), not refundTotal, because payment records
        // only capture the cash portion. appliedToBalance has no payment record counterpart,
        // so matching on refundTotal would leave the payment unmatched and double-count it.
        const paymentMatchKey = `${log.entityId || ""}|${refundAmount.toFixed(2)}|${windowStart.toISOString()}|${windowEnd.toISOString()}`;
        return {
          log,
          meta,
          itemId,
          quantity,
          refundTotal,
          paymentMatchKey,
          windowStart,
          windowEnd,
        };
      });

      const returnLogKeys = new Set(
        parsedReturnLogs
          .filter((row) => row.refundTotal > 0)
          .map((row) => row.paymentMatchKey),
      );

      const logItemIds = Array.from(
        new Set(parsedReturnLogs.map((row) => row.itemId).filter((id): id is string => Boolean(id))),
      );

      const itemCostRows = logItemIds.length
        ? await prisma.orderItem.findMany({
            where: { id: { in: logItemIds } },
            select: {
              id: true,
              productId: true,
              costAtSale: true,
              product: { select: { cost: true } },
            },
          })
        : [];
      const costByItemId = new Map(
        itemCostRows.map((row) => [row.id, Number(row.costAtSale ?? row.product?.cost ?? 0)]),
      );
      const productIdByItemId = new Map(itemCostRows.map((row) => [row.id, row.productId]));
      const restockCandidates = parsedReturnLogs
        .map((row) => {
          const productId = row.itemId ? productIdByItemId.get(row.itemId) || null : null;
          return { ...row, productId };
        })
        .filter((row) => row.productId && row.quantity > 0);
      const restockQueries = Array.from(
        new Map(
          restockCandidates.map((row) => [
            `${row.productId}|${row.quantity}|${row.windowStart.toISOString()}|${row.windowEnd.toISOString()}`,
            row,
          ]),
        ).values(),
      );
      const restockMovements = restockQueries.length
        ? await prisma.inventoryMovement.findMany({
            where: {
              OR: restockQueries.map((row) => ({
                productId: row.productId || undefined,
                reason: { in: ["RETURN_PARTIAL", "RETURN_FULL", "RETURN", "RETURN_RESTOCK", "RETURN_ITEM"] },
                delta: row.quantity,
                createdAt: { gte: row.windowStart, lte: row.windowEnd },
              })),
            },
            select: { productId: true, delta: true, createdAt: true },
          })
        : [];
      const restockQueryKeySet = new Set(
        restockQueries
          .filter((row) =>
            restockMovements.some(
              (movement) =>
                movement.productId === row.productId &&
                movement.delta === row.quantity &&
                movement.createdAt >= row.windowStart &&
                movement.createdAt <= row.windowEnd,
            ),
          )
          .map((row) => `${row.log.id}|${row.quantity}`),
      );

      for (const row of parsedReturnLogs) {
        const key = formatKey(row.log.createdAt);
        const bucket = getTrendBucket(key);
        if (row.refundTotal > 0) {
          totalRefunds += row.refundTotal;
          bucket.refunds += row.refundTotal;
        }
      }

      for (const row of restockCandidates) {
        const bucket = getTrendBucket(formatKey(row.log.createdAt));
        const restockFlag = Boolean(
          row.meta?.restockToStock ||
          row.meta?.restock ||
          row.meta?.restocked ||
          String(row.meta?.disposition || "").toUpperCase() === "RESTOCK",
        );
        const matchedRestock = restockQueryKeySet.has(`${row.log.id}|${row.quantity}`);
        if (restockFlag || matchedRestock) {
          const unitCost = row.itemId ? costByItemId.get(row.itemId) || 0 : 0;
          const cogs = unitCost * row.quantity;
          totalCOGS -= cogs;
          bucket.cogs -= cogs;
        }
      }

      if (returnPayments.length > 0) {
        for (const payment of returnPayments) {
          const windowStart = new Date(payment.createdAt.getTime() - 10 * 60 * 1000);
          const windowEnd = new Date(payment.createdAt.getTime() + 10 * 60 * 1000);
          const key = `${payment.orderId || ""}|${payment.amount.toFixed(2)}|${windowStart.toISOString()}|${windowEnd.toISOString()}`;
          if (returnLogKeys.has(key)) continue;
          totalRefunds += payment.amount;
          const periodKey = formatKey(payment.createdAt);
          getTrendBucket(periodKey).refunds += payment.amount;
        }
      }
    }
    let totalExpense = expenses.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount || 0),
      0
    );
    const totalPayrollExpense = expenses.reduce(
      (sum: number, e) => sum + (/payroll/i.test(e.category || "") ? Number(e.amount || 0) : 0),
      0
    );
    const totalOutstandingOnPeriodSales = Math.max(0, totalBilled - totalCollectedOnPeriodSales);
    const netRevenue = totalRevenue - totalRefunds;
    const netCash = totalCashIn - totalCashOut;
    const averageOrderValue = orderCount > 0 ? totalOrderValue / orderCount : 0;

    const expenseBreakdownMap: Record<string, number> = {};
    for (const e of expenses) {
      const key = e.category || "Uncategorized";
      expenseBreakdownMap[key] = (expenseBreakdownMap[key] || 0) + Number(e.amount || 0);
    }
    for (const line of manualExpenseLines) {
      if (line.account.type !== "EXPENSE") continue;
      const amount = Number(line.debit || 0) - Number(line.credit || 0);
      if (amount <= 0) continue;
      // When a category filter is active, skip manual journal lines whose account
      // name doesn't contain the filter — keeps behaviour consistent with the
      // Expense table query which filters by category field.
      if (category && !line.account.name.toLowerCase().includes(category.toLowerCase())) continue;
      totalExpense += amount;
      const key = `Manual: ${line.account.name}`;
      expenseBreakdownMap[key] = (expenseBreakdownMap[key] || 0) + amount;
      getTrendBucket(formatKey(line.entry.entryDate)).expense += amount;
    }

    const profit = netRevenue - totalCOGS - totalExpense;
    const margin = netRevenue > 0 ? (profit / netRevenue) * 100 : 0;
    const expenseBreakdown = Object.entries(expenseBreakdownMap)
      .map(([cat, amount]) => ({ category: cat, amount }))
      .sort((a, b) => b.amount - a.amount);

      for (const o of orders) {
        const key = formatKey(o.createdAt);
        const bucket = getTrendBucket(key);
        bucket.orderCount += 1;
        let orderRevenue = Number(o.subtotal ?? 0);
        if (!(orderRevenue > 0)) {
          orderRevenue = 0;
          for (const it of o.items) {
            const qty = Number(it.quantity || 0);
            orderRevenue += Number(it.price || 0) * qty;
          }
          if (orderRevenue <= 0) {
            orderRevenue = Number(o.total ?? 0);
          }
        }
        bucket.orderValue += orderRevenue;
        bucket.outstanding += Math.max(0, Number(o.total || 0) - Number(o.amountPaid || 0));
        const deliveryStatus = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
        if (deliveryStatus === "DELIVERED") bucket.delivered += 1;
        else if (deliveryStatus === "PARTIALLY_DELIVERED") bucket.partial += 1;
        else if (deliveryStatus === "RETURNED") bucket.returned += 1;
        else bucket.pending += 1;
        for (const it of o.items) {
          const qty = Number(it.quantity || 0);
          const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
          bucket.cogs += unitCost * qty;
        }
        bucket.revenue += orderRevenue;
    }
    for (const e of expenses) {
      const bucket = getTrendBucket(formatKey(e.createdAt));
      const amount = Number(e.amount);
      bucket.expense += amount;
      if (/payroll/i.test(e.category || "")) {
        bucket.payrollExpense += amount;
      }
    }
    for (const p of payments) {
      const key = formatKey(p.createdAt);
      const bucket = getTrendBucket(key);
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      const note = typeof p.note === "string" ? p.note : "";
      let meta: { location?: string; method?: string; status?: string; reference?: string } | null = null;
      if (note.startsWith("{")) {
        try {
          meta = JSON.parse(note);
        } catch {
          meta = null;
        }
      }
      const isPendingMomo =
        String(meta?.method || "").toLowerCase() === "momo" &&
        String(meta?.status || "").toUpperCase().startsWith("PENDING");
      const isAutoApply =
        String(meta?.reference || "").toUpperCase() === "AUTO_APPLY" ||
        note.includes("\"reference\":\"AUTO_APPLY\"");
      const isReturn =
        String(meta?.reference || "").toUpperCase() === "ITEM_RETURN" ||
        note.includes("\"reference\":\"ITEM_RETURN\"");
      const isRevenueRefund =
        String(meta?.reference || "").toUpperCase() === "SALES_REFUND" ||
        note.includes("\"reference\":\"SALES_REFUND\"");
      if (status === "REFUND") {
        const refundAmount = Math.abs(amount);
        bucket.cashOut += refundAmount;
        const isCreditPayout =
          meta?.location === "admin/customers:credit-payout" ||
          note.includes("\"location\":\"admin/customers:credit-payout\"");
        // Return revenue adjustments are reconciled from ORDER_ITEM_RETURN logs
        // (with fallback matching), so skip them here to avoid double counting.
        if (isReturn) continue;
        if (!isCreditPayout && isRevenueRefund) {
          bucket.refunds += refundAmount;
        }
        continue;
      }
      if (status === "VOID") continue;
      if (isAutoApply) continue;
      if (isPendingMomo) continue;
      if (amount > 0) bucket.cashIn += amount;
      if (amount < 0) bucket.cashOut += Math.abs(amount);
    }

    const trend = Object.entries(trendMap)
      .map(([date, v]) => ({
        date,
        revenue: v.revenue,
        cogs: v.cogs,
        expense: v.expense,
        payrollExpense: v.payrollExpense,
        refunds: v.refunds,
        netRevenue: v.revenue - v.refunds,
        cashIn: v.cashIn,
        cashOut: v.cashOut,
        netCash: v.cashIn - v.cashOut,
        outstanding: v.outstanding,
        orderCount: v.orderCount,
        orderValue: v.orderValue,
        averageOrderValue: v.orderCount > 0 ? v.orderValue / v.orderCount : 0,
        deliveredCount: v.delivered,
        partiallyDeliveredCount: v.partial,
        returnedCount: v.returned,
        pendingCount: v.pending,
        profit: v.revenue - v.refunds - v.cogs - v.expense,
        margin:
          v.revenue - v.refunds > 0
            ? ((v.revenue - v.refunds - v.cogs - v.expense) / (v.revenue - v.refunds)) * 100
            : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const formatPlainEnglishDate = (value: string | null) => {
      const text = String(value || "").trim();
      if (!text) return "";
      const parsed = parseISO(text);
      if (!isValid(parsed)) return text;
      return parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    };

    const scopeSnapshot = [
      start && end
        ? `${formatPlainEnglishDate(start)} to ${formatPlainEnglishDate(end)}`
        : start
          ? `From ${formatPlainEnglishDate(start)}`
          : end
            ? `Through ${formatPlainEnglishDate(end)}`
            : "All dates",
      `Grouped by ${humanizeGroupBy(groupBy)}`,
      customer ? `Customer filter: ${customer}` : null,
      category ? `Category filter: ${category}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    if (formatType === "csv") {
      const headers = [
        "Period",
        "Revenue",
        "Refunds",
        "Net Revenue",
        "COGS",
        "Expenses",
        "Payroll Expenses",
        "Net Profit",
        "Margin (%)",
        "Orders",
        "AOV",
        "Cash In",
        "Cash Out",
        "Net Cash",
        "Outstanding",
      ];
      const rows = trend.map((t) => [
        t.date,
        t.revenue.toFixed(2),
        (t.refunds ?? 0).toFixed(2),
        (t.netRevenue ?? 0).toFixed(2),
        (t.cogs ?? 0).toFixed(2),
        t.expense.toFixed(2),
        (t.payrollExpense ?? 0).toFixed(2),
        t.profit.toFixed(2),
        t.margin.toFixed(2),
        String(t.orderCount ?? 0),
        (t.averageOrderValue ?? 0).toFixed(2),
        (t.cashIn ?? 0).toFixed(2),
        (t.cashOut ?? 0).toFixed(2),
        (t.netCash ?? 0).toFixed(2),
        (t.outstanding ?? 0).toFixed(2),
      ]);
      const csvString = [
        headers.join(","),
        ...rows.map((r) => r.join(",")),
        "",
        "Basis Notes,,",
        "Order-date metrics: Revenue/Tax/Outstanding are based on orders created in the selected period.,,",
        "Payment-date metrics: Cash In/Cash Out/Net Cash are based on payments recorded in the selected period.,,",
        "",
        `Total Revenue,,${totalRevenue.toFixed(2)}`,
        `Total Refunds,,${totalRefunds.toFixed(2)}`,
        `Net Revenue,,${netRevenue.toFixed(2)}`,
        `Total COGS,,${totalCOGS.toFixed(2)}`,
        `Total Expenses,,${totalExpense.toFixed(2)}`,
        `Total Payroll Expenses,,${totalPayrollExpense.toFixed(2)}`,
        `Net Profit,,${profit.toFixed(2)}`,
        `Margin,,${margin.toFixed(2)}%`,
        `Orders,,${orderCount}`,
        `AOV,,${averageOrderValue.toFixed(2)}`,
        `Cash In,,${totalCashIn.toFixed(2)}`,
        `Cash Out,,${totalCashOut.toFixed(2)}`,
        `Net Cash,,${netCash.toFixed(2)}`,
        `Outstanding,,${totalOutstanding.toFixed(2)}`,
        `Period Billed (Order Totals),,${totalBilled.toFixed(2)}`,
        `Tax Collected,,${totalTaxCollected.toFixed(2)}`,
        `Discounts,,${totalDiscounts.toFixed(2)}`,
        `Discounted Orders,,${discountedOrders}`,
        `Collected on Period Sales,,${totalCollectedOnPeriodSales.toFixed(2)}`,
        `Outstanding on Period Sales (estimated),,${totalOutstandingOnPeriodSales.toFixed(2)}`,
      ].join("\n");
      await recordAuditLog({
        actorId: (session.user as { id?: string } | undefined)?.id || null,
        action: "PL_EXPORT_CSV",
        entityType: "REPORT",
        entityId: "SUMMARY",
        meta: {
          exportLabel: "Profit & Loss CSV export",
          reportLabel: "Profit & Loss report",
          format: "CSV",
          fileName: `nora_pl_${groupBy}.csv`,
          displayFileName: `Profit & Loss report (${humanizeGroupBy(groupBy)}).csv`,
          groupBy,
          rowCount: rows.length,
          columnCount: headers.length,
          byteSize: Buffer.byteLength(csvString, "utf8"),
          scopeSnapshot,
          resultSummary: `Exported ${rows.length} summary row${rows.length === 1 ? "" : "s"} to CSV.`,
          actorName: (session.user as { name?: string } | undefined)?.name || null,
          actorEmail: (session.user as { email?: string } | undefined)?.email || null,
          actorRole: role || null,
        },
      });
      return new Response(csvString, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="nora_pl_${groupBy}.csv"`,
        },
      });
    }

    if (formatType === "pdf") {
      const pdfDoc = await PDFDocument.create();
      const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const pageSize: [number, number] = [595.28, 841.89]; // A4
      const margin = 40;
      const lineHeight = 14;
      let page = pdfDoc.addPage(pageSize);
      let y = page.getSize().height - margin;

      const ensureSpace = (required = lineHeight) => {
        if (y - required < margin) {
          page = pdfDoc.addPage(pageSize);
          y = page.getSize().height - margin;
        }
      };

      const drawLine = (text: string, opts?: { isBold?: boolean; size?: number; x?: number }) => {
        const size = opts?.size ?? 10;
        const x = opts?.x ?? margin;
        ensureSpace(size + 4);
        page.drawText(text, {
          x,
          y,
          size,
          font: opts?.isBold ? bold : regular,
        });
        y -= size + 4;
      };

      drawLine("Profit & Loss Report", { isBold: true, size: 16 });
      drawLine(`Grouping: ${groupBy.toUpperCase()}    Generated: ${new Date().toLocaleString()}`, { size: 10 });
      y -= 4;

      drawLine("Basis Notes", { isBold: true, size: 12 });
      drawLine("- Order-date metrics: Revenue/Tax/Outstanding use orders created in the selected period.");
      drawLine("- Payment-date metrics: Cash In/Cash Out/Net Cash use payments recorded in the selected period.");
      y -= 4;

      drawLine("Totals", { isBold: true, size: 12 });
      const totalLines = [
        `Total Revenue: ${totalRevenue.toFixed(2)}`,
        `Tax Collected: ${totalTaxCollected.toFixed(2)}`,
        `Discounts: ${totalDiscounts.toFixed(2)} (${discountedOrders} orders)`,
        `Refunds: ${totalRefunds.toFixed(2)}`,
        `Net Revenue: ${netRevenue.toFixed(2)}`,
        `Total COGS: ${totalCOGS.toFixed(2)}`,
        `Operating Expenses: ${totalExpense.toFixed(2)}`,
        `Payroll Expenses: ${totalPayrollExpense.toFixed(2)}`,
        `Net Profit: ${profit.toFixed(2)}`,
        `Margin: ${margin.toFixed(2)}%`,
        `Orders: ${orderCount}`,
        `AOV: ${averageOrderValue.toFixed(2)}`,
        `Cash In: ${totalCashIn.toFixed(2)}`,
        `Cash Out: ${totalCashOut.toFixed(2)}`,
        `Net Cash: ${netCash.toFixed(2)}`,
        `Outstanding: ${totalOutstanding.toFixed(2)}`,
      ];
      for (const line of totalLines) drawLine(line);
      y -= 6;

      drawLine("Trend", { isBold: true, size: 12 });
      drawLine("Period | Revenue | Refunds | NetRev | COGS | Expenses | Payroll | NetProfit | Margin%", {
        isBold: true,
      });
      for (const t of trend) {
        drawLine(
          `${t.date} | ${t.revenue.toFixed(2)} | ${(t.refunds ?? 0).toFixed(2)} | ${(t.netRevenue ?? 0).toFixed(2)} | ${(t.cogs ?? 0).toFixed(2)} | ${t.expense.toFixed(2)} | ${(t.payrollExpense ?? 0).toFixed(2)} | ${t.profit.toFixed(2)} | ${t.margin.toFixed(2)}%`,
        );
      }

      const pdf = await pdfDoc.save();
      await recordAuditLog({
        actorId: (session.user as { id?: string } | undefined)?.id || null,
        action: "PL_EXPORT_PDF",
        entityType: "REPORT",
        entityId: "SUMMARY",
        meta: {
          exportLabel: "Profit & Loss PDF export",
          reportLabel: "Profit & Loss report",
          format: "PDF",
          fileName: `nora_pl_${groupBy}.pdf`,
          displayFileName: `Profit & Loss report (${humanizeGroupBy(groupBy)}).pdf`,
          groupBy,
          rowCount: trend.length,
          byteSize: pdf.length,
          scopeSnapshot,
          resultSummary: `Exported ${trend.length} summary row${trend.length === 1 ? "" : "s"} to PDF.`,
          actorName: (session.user as { name?: string } | undefined)?.name || null,
          actorEmail: (session.user as { email?: string } | undefined)?.email || null,
          actorRole: role || null,
        },
      });
      return new Response(Buffer.from(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="nora_pl_${groupBy}.pdf"`,
        },
      });
    }

    return NextResponse.json({
      summary: {
        totalRevenue,
        totalRefunds,
        netRevenue,
        totalCOGS,
        totalExpense,
        profit,
        margin: Number(margin.toFixed(2)),
        orderCount,
        averageOrderValue,
        totalCashIn,
        totalCashOut,
        netCash,
        totalOutstanding,
        totalBilled,
        totalTaxCollected,
        totalDiscounts,
        discountedOrders,
        totalCollectedOnPeriodSales,
        totalOutstandingOnPeriodSales,
        deliveredCount,
        partiallyDeliveredCount,
        returnedCount,
        pendingCount,
        expenseBreakdown,
      },
      trend,
      groupBy,
    });
  } catch (error) {
    console.error("Error generating admin summary:", error);
    return NextResponse.json(
      { error: "Failed to generate summary", detail: String(error) },
      { status: 500 }
    );
  }
}
