import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfDay, endOfDay, parseISO, isValid, format, startOfWeek } from "date-fns";
import PDFDocument from "pdfkit";

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
        createdAt: true,
        total: true,
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

    const payments = await prisma.payment.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
        ...(customer
          ? { user: { name: { contains: customer, mode: "insensitive" } } }
          : {}),
      },
      select: { amount: true, status: true, createdAt: true },
    });

    // Totals
    let totalRevenue = 0;
    let totalCOGS = 0;
    let orderCount = 0;
    let totalOrderValue = 0;
    let deliveredCount = 0;
    let partiallyDeliveredCount = 0;
    let returnedCount = 0;
    let pendingCount = 0;
    for (const o of orders) {
      orderCount += 1;
      totalOrderValue += Number(o.total || 0);
      const deliveryStatus = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
      if (deliveryStatus === "DELIVERED") deliveredCount += 1;
      else if (deliveryStatus === "PARTIALLY_DELIVERED") partiallyDeliveredCount += 1;
      else if (deliveryStatus === "RETURNED") returnedCount += 1;
      else pendingCount += 1;
      for (const it of o.items) {
        const qty = Number(it.quantity || 0);
        totalRevenue += Number(it.price || 0) * qty;
        const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
        totalCOGS += unitCost * qty;
      }
    }
    let totalRefunds = 0;
    let totalCashIn = 0;
    let totalCashOut = 0;
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      if (status === "REFUND") {
        const refundAmount = Math.abs(amount);
        totalRefunds += refundAmount;
        totalCashOut += refundAmount;
        continue;
      }
      if (status === "VOID") continue;
      if (amount > 0) totalCashIn += amount;
      if (amount < 0) totalCashOut += Math.abs(amount);
    }
    const totalExpense = expenses.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount || 0),
      0
    );
    const profit = totalRevenue - totalCOGS - totalExpense;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;
    const netRevenue = totalRevenue - totalRefunds;
    const netCash = totalCashIn - totalCashOut;
    const averageOrderValue = orderCount > 0 ? totalOrderValue / orderCount : 0;

    const expenseBreakdownMap: Record<string, number> = {};
    for (const e of expenses) {
      const key = e.category || "Uncategorized";
      expenseBreakdownMap[key] = (expenseBreakdownMap[key] || 0) + Number(e.amount || 0);
    }
    const expenseBreakdown = Object.entries(expenseBreakdownMap)
      .map(([cat, amount]) => ({ category: cat, amount }))
      .sort((a, b) => b.amount - a.amount);

    // Grouping key
    const formatKey = (d: Date) => {
      if (groupBy === "year") return format(d, "yyyy");
      if (groupBy === "month") return format(d, "yyyy-MM");
      if (groupBy === "week") {
        const wk = startOfWeek(d, { weekStartsOn: 1 });
        return format(wk, "yyyy-ww");
      }
      return format(d, "yyyy-MM-dd");
    };

    const trendMap: Record<string, {
      revenue: number;
      cogs: number;
      expense: number;
      refunds: number;
      cashIn: number;
      cashOut: number;
      orderCount: number;
      orderValue: number;
      delivered: number;
      partial: number;
      returned: number;
      pending: number;
    }> = {};
    for (const o of orders) {
      const key = formatKey(o.createdAt);
      if (!trendMap[key]) {
        trendMap[key] = {
          revenue: 0,
          cogs: 0,
          expense: 0,
          refunds: 0,
          cashIn: 0,
          cashOut: 0,
          orderCount: 0,
          orderValue: 0,
          delivered: 0,
          partial: 0,
          returned: 0,
          pending: 0,
        };
      }
      trendMap[key].orderCount += 1;
      trendMap[key].orderValue += Number(o.total || 0);
      const deliveryStatus = String(o.deliveryStatus || "NOT_DELIVERED").toUpperCase();
      if (deliveryStatus === "DELIVERED") trendMap[key].delivered += 1;
      else if (deliveryStatus === "PARTIALLY_DELIVERED") trendMap[key].partial += 1;
      else if (deliveryStatus === "RETURNED") trendMap[key].returned += 1;
      else trendMap[key].pending += 1;
      for (const it of o.items) {
        const qty = Number(it.quantity || 0);
        trendMap[key].revenue += Number(it.price || 0) * qty;
        const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
        trendMap[key].cogs += unitCost * qty;
      }
    }
    for (const e of expenses) {
      const key = formatKey(e.createdAt);
      if (!trendMap[key]) {
        trendMap[key] = {
          revenue: 0,
          cogs: 0,
          expense: 0,
          refunds: 0,
          cashIn: 0,
          cashOut: 0,
          orderCount: 0,
          orderValue: 0,
          delivered: 0,
          partial: 0,
          returned: 0,
          pending: 0,
        };
      }
      trendMap[key].expense += Number(e.amount);
    }
    for (const p of payments) {
      const key = formatKey(p.createdAt);
      if (!trendMap[key]) {
        trendMap[key] = {
          revenue: 0,
          cogs: 0,
          expense: 0,
          refunds: 0,
          cashIn: 0,
          cashOut: 0,
          orderCount: 0,
          orderValue: 0,
          delivered: 0,
          partial: 0,
          returned: 0,
          pending: 0,
        };
      }
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      if (status === "REFUND") {
        const refundAmount = Math.abs(amount);
        trendMap[key].refunds += refundAmount;
        trendMap[key].cashOut += refundAmount;
        continue;
      }
      if (status === "VOID") continue;
      if (amount > 0) trendMap[key].cashIn += amount;
      if (amount < 0) trendMap[key].cashOut += Math.abs(amount);
    }

    const trend = Object.entries(trendMap)
      .map(([date, v]) => ({
        date,
        revenue: v.revenue,
        cogs: v.cogs,
        expense: v.expense,
        refunds: v.refunds,
        netRevenue: v.revenue - v.refunds,
        cashIn: v.cashIn,
        cashOut: v.cashOut,
        netCash: v.cashIn - v.cashOut,
        orderCount: v.orderCount,
        orderValue: v.orderValue,
        averageOrderValue: v.orderCount > 0 ? v.orderValue / v.orderCount : 0,
        deliveredCount: v.delivered,
        partiallyDeliveredCount: v.partial,
        returnedCount: v.returned,
        pendingCount: v.pending,
        profit: v.revenue - v.cogs - v.expense,
        margin: v.revenue > 0 ? ((v.revenue - v.cogs - v.expense) / v.revenue) * 100 : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (formatType === "csv") {
      const headers = [
        "Period",
        "Revenue",
        "Refunds",
        "Net Revenue",
        "COGS",
        "Expenses",
        "Net Profit",
        "Margin (%)",
        "Orders",
        "AOV",
        "Cash In",
        "Cash Out",
        "Net Cash",
      ];
      const rows = trend.map((t) => [
        t.date,
        t.revenue.toFixed(2),
        (t.refunds ?? 0).toFixed(2),
        (t.netRevenue ?? 0).toFixed(2),
        (t.cogs ?? 0).toFixed(2),
        t.expense.toFixed(2),
        t.profit.toFixed(2),
        t.margin.toFixed(2),
        String(t.orderCount ?? 0),
        (t.averageOrderValue ?? 0).toFixed(2),
        (t.cashIn ?? 0).toFixed(2),
        (t.cashOut ?? 0).toFixed(2),
        (t.netCash ?? 0).toFixed(2),
      ]);
      const csvString = [
        headers.join(","),
        ...rows.map((r) => r.join(",")),
        "",
        `Total Revenue,,${totalRevenue.toFixed(2)}`,
        `Total Refunds,,${totalRefunds.toFixed(2)}`,
        `Net Revenue,,${netRevenue.toFixed(2)}`,
        `Total COGS,,${totalCOGS.toFixed(2)}`,
        `Total Expenses,,${totalExpense.toFixed(2)}`,
        `Net Profit,,${profit.toFixed(2)}`,
        `Margin,,${margin.toFixed(2)}%`,
        `Orders,,${orderCount}`,
        `AOV,,${averageOrderValue.toFixed(2)}`,
        `Cash In,,${totalCashIn.toFixed(2)}`,
        `Cash Out,,${totalCashOut.toFixed(2)}`,
        `Net Cash,,${netCash.toFixed(2)}`,
      ].join("\n");
      return new Response(csvString, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="nora_${groupBy}_summary.csv"`,
        },
      });
    }

    if (formatType === "pdf") {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      doc.on("data", (c) => chunks.push(c));
      const done = new Promise<void>((resolve) => doc.on("end", resolve));

      doc.font("Helvetica-Bold").fontSize(16).text("Revenue, Expense, Margin Summary", { align: "center" });
      doc.moveDown(0.4);
      doc.fontSize(11).text(`Grouping: ${groupBy.toUpperCase()}    Generated: ${new Date().toLocaleString()}`, { align: "center" });
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(12).text("Totals");
      doc.font("Helvetica").fontSize(11);
      doc.text(`Total Revenue: ${totalRevenue.toFixed(2)}`);
      doc.text(`Refunds: ${totalRefunds.toFixed(2)}`);
      doc.text(`Net Revenue: ${netRevenue.toFixed(2)}`);
      doc.text(`Total COGS: ${totalCOGS.toFixed(2)}`);
      doc.text(`Operating Expenses: ${totalExpense.toFixed(2)}`);
      doc.text(`Net Profit: ${profit.toFixed(2)}`);
      doc.text(`Margin: ${margin.toFixed(2)}%`);
      doc.text(`Orders: ${orderCount}`);
      doc.text(`AOV: ${averageOrderValue.toFixed(2)}`);
      doc.text(`Cash In: ${totalCashIn.toFixed(2)}`);
      doc.text(`Cash Out: ${totalCashOut.toFixed(2)}`);
      doc.text(`Net Cash: ${netCash.toFixed(2)}`);
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(12).text("Trend");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10);
      doc.text("Period                Revenue   Refunds   NetRev    COGS     Expenses  NetProfit  Margin% ");
      doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).stroke();
      trend.forEach((t) => {
        const line = `${t.date.padEnd(20)} ${t.revenue.toFixed(2).padStart(8)}  ${(t.refunds ?? 0).toFixed(2).padStart(7)}  ${(t.netRevenue ?? 0).toFixed(2).padStart(7)}  ${(t.cogs ?? 0).toFixed(2).padStart(7)}  ${t.expense.toFixed(2).padStart(7)}  ${t.profit.toFixed(2).padStart(8)}  ${t.margin.toFixed(2).padStart(7)}`;
        doc.text(line);
      });
      doc.end();
      await done;
      const pdf = Buffer.concat(chunks);
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="nora_${groupBy}_summary.pdf"`,
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
    return NextResponse.json({ error: "Failed to generate summary" }, { status: 500 });
  }
}
