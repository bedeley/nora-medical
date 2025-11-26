import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfDay, endOfDay, parseISO, isValid, format, startOfWeek } from "date-fns";
import PDFDocument from "pdfkit";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { role?: string } | undefined;

  if (!session || user?.role !== "ADMIN") {
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
        NOT: { status: "CANCELED" },
        ...(customer
          ? { user: { name: { contains: customer, mode: "insensitive" } } }
          : {}),
      },
      select: {
        createdAt: true,
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

    // Totals
    let totalRevenue = 0;
    let totalCOGS = 0;
    for (const o of orders) {
      for (const it of o.items) {
        const qty = Number(it.quantity || 0);
        totalRevenue += Number(it.price || 0) * qty;
        const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
        totalCOGS += unitCost * qty;
      }
    }
    const totalExpense = expenses.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount || 0),
      0
    );
    const profit = totalRevenue - totalCOGS - totalExpense;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

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

    const trendMap: Record<string, { revenue: number; cogs: number; expense: number }> = {};
    for (const o of orders) {
      const key = formatKey(o.createdAt);
      if (!trendMap[key]) trendMap[key] = { revenue: 0, cogs: 0, expense: 0 };
      for (const it of o.items) {
        const qty = Number(it.quantity || 0);
        trendMap[key].revenue += Number(it.price || 0) * qty;
        const unitCost = it.costAtSale != null ? Number(it.costAtSale) : Number(it.product?.cost ?? 0);
        trendMap[key].cogs += unitCost * qty;
      }
    }
    for (const e of expenses) {
      const key = formatKey(e.createdAt);
      if (!trendMap[key]) trendMap[key] = { revenue: 0, cogs: 0, expense: 0 };
      trendMap[key].expense += Number(e.amount);
    }

    const trend = Object.entries(trendMap)
      .map(([date, v]) => ({
        date,
        revenue: v.revenue,
        cogs: v.cogs,
        expense: v.expense,
        profit: v.revenue - v.cogs - v.expense,
        margin: v.revenue > 0 ? ((v.revenue - v.cogs - v.expense) / v.revenue) * 100 : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (formatType === "csv") {
      const headers = ["Period", "Revenue", "COGS", "Expenses", "Net Profit", "Margin (%)"];
      const rows = trend.map((t) => [
        t.date,
        t.revenue.toFixed(2),
        (t.cogs ?? 0).toFixed(2),
        t.expense.toFixed(2),
        t.profit.toFixed(2),
        t.margin.toFixed(2),
      ]);
      const csvString = [
        headers.join(","),
        ...rows.map((r) => r.join(",")),
        "",
        `Total Revenue,,${totalRevenue.toFixed(2)}`,
        `Total COGS,,${totalCOGS.toFixed(2)}`,
        `Total Expenses,,${totalExpense.toFixed(2)}`,
        `Net Profit,,${profit.toFixed(2)}`,
        `Margin,,${margin.toFixed(2)}%`,
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
      doc.text(`Total COGS: ${totalCOGS.toFixed(2)}`);
      doc.text(`Operating Expenses: ${totalExpense.toFixed(2)}`);
      doc.text(`Net Profit: ${profit.toFixed(2)}`);
      doc.text(`Margin: ${margin.toFixed(2)}%`);
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(12).text("Trend");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10);
      doc.text("Period                Revenue      COGS     Expenses    NetProfit   Margin% ");
      doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).stroke();
      trend.forEach((t) => {
        const line = `${t.date.padEnd(20)} ${t.revenue.toFixed(2).padStart(9)}  ${(t.cogs ?? 0).toFixed(2).padStart(9)}  ${t.expense.toFixed(2).padStart(9)}  ${t.profit.toFixed(2).padStart(9)}  ${t.margin.toFixed(2).padStart(7)}`;
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
        totalCOGS,
        totalExpense,
        profit,
        margin: Number(margin.toFixed(2)),
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
