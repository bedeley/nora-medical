import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseISO, isValid, startOfDay, endOfDay, startOfWeek, startOfMonth, startOfYear } from "date-fns";
import PDFDocument from "pdfkit";

type Row = {
  productId: string;
  name: string;
  qty: number;
  revenue: number;
  costTotal: number;
  weightedCost: number; // per unit
  profit: number;
  margin: number;
};

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const range = (searchParams.get("range") as "day" | "week" | "month" | "year" | null) || null;
    const orderDir = (searchParams.get("order") as "asc" | "desc") || "desc";
    const formatType = searchParams.get("format");
    const q = searchParams.get("q") || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(searchParams.get("pageSize") || "25", 10) || 25));

    // Compute date range
    let gte: Date | undefined;
    let lte: Date | undefined;
    const now = new Date();
    if (start && isValid(parseISO(start))) gte = startOfDay(parseISO(start));
    if (end && isValid(parseISO(end))) lte = endOfDay(parseISO(end));
    if (!gte && !lte && range) {
      if (range === "day") gte = startOfDay(now);
      if (range === "week") gte = startOfWeek(now, { weekStartsOn: 1 });
      if (range === "month") gte = startOfMonth(now);
      if (range === "year") gte = startOfYear(now);
      lte = endOfDay(now);
    }

    const where = {
      order: {
        NOT: { status: "CANCELED" },
        ...(gte || lte ? { createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {}),
      },
      ...(q
        ? {
            product: {
              name: { contains: q, mode: "insensitive" },
            },
          }
        : {}),
    } satisfies NonNullable<Parameters<typeof prisma.orderItem.findMany>[0]>["where"];

    // Pull order items within the window with related product + order date
    const items = await prisma.orderItem.findMany({
      where,
      select: {
        productId: true,
        quantity: true,
        price: true,
        costAtSale: true,
        product: { select: { name: true } },
      },
    });

    // Aggregate by product
    const map = new Map<string, Row>();
    for (const it of items) {
      const pid = it.productId;
      const qty = Number(it.quantity || 0);
      const unitPrice = Number(it.price || 0);
      const unitCost = it.costAtSale != null ? Number(it.costAtSale) : 0;
      const revenue = unitPrice * qty;
      const cost = unitCost * qty;
      const current = map.get(pid);
      if (!current) {
        map.set(pid, {
          productId: pid,
          name: it.product?.name || "Unknown",
          qty,
          revenue,
          costTotal: cost,
          weightedCost: qty > 0 ? cost / qty : 0,
          profit: revenue - cost,
          margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
        });
      } else {
        current.qty += qty;
        current.revenue += revenue;
        current.costTotal += cost;
        current.weightedCost = current.qty > 0 ? current.costTotal / current.qty : 0;
        current.profit = current.revenue - current.costTotal;
        current.margin = current.revenue > 0 ? (current.profit / current.revenue) * 100 : 0;
      }
    }

    const rows = Array.from(map.values());

    // Rank by selected metric (default: profit)
    const sortMetric = (searchParams.get("sort") as "profit" | "revenue" | "qty" | "margin" | null) || "profit";
    rows.sort((a, b) => {
      const getValue = (r: Row) => {
        if (sortMetric === "qty") return r.qty;
        if (sortMetric === "revenue") return r.revenue;
        if (sortMetric === "margin") return r.margin;
        return r.profit;
      };
      return getValue(b) - getValue(a);
    });
    const withRank = rows.map((r, idx) => ({ ...r, rank: idx + 1 }));

    // Sort order for UI – best to worst (desc) or reverse
    const finalRows = orderDir === "asc" ? [...withRank].reverse() : withRank;
    const total = finalRows.length;
    const startIdx = (page - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageRows = finalRows.slice(startIdx, endIdx);

    if (formatType === "csv") {
      const headers = [
        "Rank",
        "Product",
        "Qty Sold",
        "Weighted Cost (per item)",
        "Weighted Sold Price (per item)",
        "Total Weighted Cost",
        "Revenue",
        "Margin %",
        "Profit / Loss",
      ];
      const lines = finalRows.map((r) => {
        const weightedSold = r.qty > 0 ? r.revenue / r.qty : 0;
        return [
          r.rank,
          r.name,
          r.qty,
          r.weightedCost.toFixed(2),
          weightedSold.toFixed(2),
          r.costTotal.toFixed(2),
          r.revenue.toFixed(2),
          r.margin.toFixed(1),
          r.profit.toFixed(2),
        ].join(",");
      });
      const csv = [headers.join(","), ...lines].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="product_pl_${range || "custom"}.csv"`,
        },
      });
    }

    if (formatType === "pdf") {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      doc.on("data", (c) => chunks.push(c));
      const done = new Promise<void>((resolve) => doc.on("end", resolve));

      doc.font("Helvetica-Bold").fontSize(16).text("Product Performance (P&L)", { align: "center" });
      doc.moveDown(0.4);
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`Range: ${range || "CUSTOM"}    Generated: ${new Date().toLocaleString()}`, { align: "center" });
      doc.moveDown(1);

      doc.font("Helvetica-Bold").fontSize(11);
      doc.text(
        "Rank  Product                              Qty   WgtCost  WgtPrice  TotalCost   Revenue   Margin   Profit",
      );
      doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).stroke();
      doc.font("Helvetica").fontSize(10);
      finalRows.forEach((r) => {
        const weightedSold = r.qty > 0 ? r.revenue / r.qty : 0;
        const marginStr = `${r.margin.toFixed(1)}%`;
        const line = `${String(r.rank).padStart(4)}  ${r.name.padEnd(34).slice(0, 34)}  ${String(r.qty).padStart(4)}  ${r.weightedCost
          .toFixed(2)
          .padStart(8)}  ${weightedSold.toFixed(2).padStart(8)}  ${r.costTotal
          .toFixed(2)
          .padStart(10)}  ${r.revenue.toFixed(2).padStart(9)}  ${marginStr
          .padStart(7)}  ${r.profit.toFixed(2).padStart(8)}`;
        doc.text(line);
      });
      doc.end();
      await done;
      const pdf = Buffer.concat(chunks);
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="product_pl_${range || "custom"}.pdf"`,
        },
      });
    }

    return NextResponse.json({
      range: range || (gte || lte ? "custom" : "month"),
      start: gte ? gte.toISOString() : null,
      end: lte ? lte.toISOString() : null,
      total,
      page,
      pageSize,
      rows: pageRows,
    });
  } catch (error) {
    console.error("Error generating product P&L:", error);
    return NextResponse.json({ error: "Failed to generate product P&L" }, { status: 500 });
  }
}
