import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import {
  parseISO,
  isValid,
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  subMonths,
} from "date-fns";
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

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const range = (searchParams.get("range") as "day" | "week" | "month" | "year" | "all" | null) || null;
    const orderDir = (searchParams.get("order") as "asc" | "desc") || "desc";
    const formatType = searchParams.get("format");
    const q = searchParams.get("q") || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(searchParams.get("pageSize") || "25", 10) || 25));
    const sortMetric = (searchParams.get("sort") as "profit" | "revenue" | "qty" | "margin" | null) || "profit";
    const lossOnly = searchParams.get("lossOnly") === "1";

    // Compute date range
    let gte: Date | undefined;
    let lte: Date | undefined;
    const now = new Date();
    if (!range) {
      if (start && isValid(parseISO(start))) gte = startOfDay(parseISO(start));
      if (end && isValid(parseISO(end))) lte = endOfDay(parseISO(end));
    }
    if (!gte && !lte && range && range !== "all") {
      if (range === "day") gte = startOfDay(now);
      if (range === "week") gte = startOfWeek(now, { weekStartsOn: 1 });
      if (range === "month") gte = startOfMonth(now);
      if (range === "year") gte = startOfDay(subMonths(now, 12));
      lte = endOfDay(now);
    }

    const where = {
      order: {
        status: { notIn: ["CANCELLED", "CANCELED"] },
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
        id: true,
        productId: true,
        quantity: true,
        price: true,
        costAtSale: true,
        product: { select: { name: true } },
      },
    });

    // Aggregate by product
    const map = new Map<string, Row>();
    const applyRowMetrics = (row: Row) => {
      row.weightedCost = row.qty > 0 ? row.costTotal / row.qty : 0;
      row.profit = row.revenue - row.costTotal;
      row.margin = row.revenue > 0 ? (row.profit / row.revenue) * 100 : 0;
    };
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
          weightedCost: 0,
          profit: 0,
          margin: 0,
        });
        applyRowMetrics(map.get(pid)!);
      } else {
        current.qty += qty;
        current.revenue += revenue;
        current.costTotal += cost;
        applyRowMetrics(current);
      }
    }
    const validItemIds = new Set(items.map((item) => item.id));

    const returnLogs = await prisma.auditLog.findMany({
      where: {
        action: "ORDER_ITEM_RETURN",
        ...(gte || lte ? { createdAt: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    const parsedReturnLogs = returnLogs.map((log) => {
      let meta: ReturnLogMeta | null = null;
      try {
        meta = log.meta ? (JSON.parse(String(log.meta)) as ReturnLogMeta) : null;
      } catch {
        meta = null;
      }
      const itemId = meta?.itemId || null;
      const quantity = Number(meta?.quantity || 0);
      const refundTotal = Number(meta?.refundAmount || 0) + Number(meta?.appliedToBalance || 0);
      const windowStart = new Date(log.createdAt.getTime() - 10 * 60 * 1000);
      const windowEnd = new Date(log.createdAt.getTime() + 10 * 60 * 1000);
      return { log, meta, itemId, quantity, refundTotal, windowStart, windowEnd };
    });

    const returnItemIds = Array.from(
      new Set(parsedReturnLogs.map((row) => row.itemId).filter((id): id is string => Boolean(id))),
    );
    const returnedItems = returnItemIds.length
      ? await prisma.orderItem.findMany({
          where: {
            id: { in: returnItemIds },
            ...(q
              ? {
                  product: {
                    name: { contains: q, mode: "insensitive" },
                  },
                }
              : {}),
          },
          select: {
            id: true,
            productId: true,
            price: true,
            costAtSale: true,
            product: { select: { name: true, cost: true } },
          },
        })
      : [];
    const returnedItemById = new Map(returnedItems.map((row) => [row.id, row]));

    const restockCandidates = parsedReturnLogs
      .map((row) => {
        const item = row.itemId ? returnedItemById.get(row.itemId) || null : null;
        return { ...row, item, productId: item?.productId || null };
      })
      .filter((row) => row.item && row.productId && row.quantity > 0 && validItemIds.has(row.itemId || ""));
    const uniqueRestockQueries = Array.from(
      new Map(
        restockCandidates.map((row) => [
          `${row.productId}|${row.quantity}|${row.windowStart.toISOString()}|${row.windowEnd.toISOString()}`,
          row,
        ]),
      ).values(),
    );
    const restockMovements = uniqueRestockQueries.length
      ? await prisma.inventoryMovement.findMany({
          where: {
            OR: uniqueRestockQueries.map((row) => ({
              productId: row.productId || undefined,
              reason: { in: ["RETURN_PARTIAL", "RETURN_FULL", "RETURN", "RETURN_RESTOCK", "RETURN_ITEM"] },
              delta: row.quantity,
              createdAt: { gte: row.windowStart, lte: row.windowEnd },
            })),
          },
          select: { productId: true, delta: true, createdAt: true },
        })
      : [];
    const matchedRestockKeys = new Set(
      uniqueRestockQueries
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

    for (const row of restockCandidates) {
      const item = row.item;
      if (!item) continue;
      const pid = item.productId;
      const current =
        map.get(pid) ||
        ({
          productId: pid,
          name: item.product?.name || "Unknown",
          qty: 0,
          revenue: 0,
          costTotal: 0,
          weightedCost: 0,
          profit: 0,
          margin: 0,
        } satisfies Row);
      current.qty -= row.quantity;
      if (row.refundTotal > 0) {
        current.revenue -= row.refundTotal;
      }
      const restockFlag = Boolean(
        row.meta?.restockToStock ||
        row.meta?.restock ||
        row.meta?.restocked ||
        String(row.meta?.disposition || "").toUpperCase() === "RESTOCK",
      );
      const matchedRestock = matchedRestockKeys.has(`${row.log.id}|${row.quantity}`);
      if (restockFlag || matchedRestock) {
        const unitCost = Number(item.costAtSale ?? item.product?.cost ?? 0);
        current.costTotal -= unitCost * row.quantity;
      }
      applyRowMetrics(current);
      map.set(pid, current);
    }

    // Sort all rows by selected metric descending (best first)
    const allRows = Array.from(map.values());
    const getSortValue = (r: Row) => {
      if (sortMetric === "qty") return r.qty;
      if (sortMetric === "revenue") return r.revenue;
      if (sortMetric === "margin") return r.margin;
      return r.profit;
    };
    allRows.sort((a, b) => getSortValue(b) - getSortValue(a));

    // Period-level totals computed from all products (before any filtering)
    let periodRevenue = 0;
    let periodCost = 0;
    let periodProfit = 0;
    let periodQty = 0;
    for (const r of allRows) {
      periodRevenue += r.revenue;
      periodCost += r.costTotal;
      periodProfit += r.profit;
      periodQty += r.qty;
    }
    const periodMargin = periodRevenue > 0 ? (periodProfit / periodRevenue) * 100 : 0;
    const periodTotals = {
      revenue: periodRevenue,
      cost: periodCost,
      profit: periodProfit,
      qty: periodQty,
      margin: periodMargin,
      productCount: allRows.length,
    };

    // Apply lossOnly filter
    const filteredRows = lossOnly ? allRows.filter((r) => r.profit < 0) : allRows;

    // Apply display order then assign rank based on displayed position
    const ordered = orderDir === "asc" ? [...filteredRows].reverse() : filteredRows;
    const finalRows = ordered.map((r, idx) => ({ ...r, rank: idx + 1 }));

    const total = finalRows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const startIdx = (currentPage - 1) * pageSize;
    const pageRows = finalRows.slice(startIdx, startIdx + pageSize);

    // Helper: quote a CSV field (escapes internal double-quotes)
    const csvField = (v: string | number): string => {
      const s = String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    if (formatType === "csv") {
      const headers = [
        "Rank",
        "Product",
        "Net Qty",
        "Weighted Cost (per item) GHS",
        "Weighted Sold Price (per item) GHS",
        "Total Weighted Cost GHS",
        "Revenue GHS",
        "Margin %",
        "Profit / Loss GHS",
      ];
      const lines = finalRows.map((r: Row & { rank: number }) => {
        const weightedSold = r.qty > 0 ? r.revenue / r.qty : 0;
        return [
          csvField(r.rank),
          csvField(r.name),
          csvField(r.qty),
          csvField(r.weightedCost.toFixed(2)),
          csvField(weightedSold.toFixed(2)),
          csvField(r.costTotal.toFixed(2)),
          csvField(r.revenue.toFixed(2)),
          csvField(r.margin.toFixed(1)),
          csvField(r.profit.toFixed(2)),
        ].join(",");
      });
      const csv = [headers.join(","), ...lines].join("\n");
      await recordAuditLog({
        actorId: user?.id || null,
        action: "PRODUCT_PL_EXPORT_CSV",
        entityType: "REPORT",
        entityId: "PRODUCT_PL",
        meta: {
          format: "CSV",
          fileName: `product_pl_${range || "custom"}.csv`,
          range: range || "custom",
          rowCount: finalRows.length,
          columnCount: headers.length,
          byteSize: Buffer.byteLength(csv, "utf8"),
          query: q || null,
          lossOnly,
        },
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="product_pl_${range || "custom"}.csv"`,
        },
      });
    }

    if (formatType === "pdf") {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      doc.on("data", (c) => chunks.push(c));
      const done = new Promise<void>((resolve) => doc.on("end", resolve));

      // Column layout (x position + width) for A4 landscape (usable ~762pt)
      const COL = {
        rank:      { x: 40,  w: 32  },
        product:   { x: 80,  w: 195 },
        qty:       { x: 283, w: 45  },
        wgtCost:   { x: 336, w: 72  },
        wgtPrice:  { x: 416, w: 72  },
        totalCost: { x: 496, w: 72  },
        revenue:   { x: 576, w: 72  },
        margin:    { x: 656, w: 48  },
        profit:    { x: 712, w: 72  },
      } as const;

      const drawRow = (
        rankVal: string,
        productVal: string,
        qtyVal: string,
        wgtCostVal: string,
        wgtPriceVal: string,
        totalCostVal: string,
        revenueVal: string,
        marginVal: string,
        profitVal: string,
        y: number,
      ) => {
        doc.text(rankVal,      COL.rank.x,      y, { width: COL.rank.w,      align: "right"  });
        doc.text(productVal,   COL.product.x,   y, { width: COL.product.w,   align: "left"   });
        doc.text(qtyVal,       COL.qty.x,       y, { width: COL.qty.w,       align: "right"  });
        doc.text(wgtCostVal,   COL.wgtCost.x,   y, { width: COL.wgtCost.w,   align: "right"  });
        doc.text(wgtPriceVal,  COL.wgtPrice.x,  y, { width: COL.wgtPrice.w,  align: "right"  });
        doc.text(totalCostVal, COL.totalCost.x, y, { width: COL.totalCost.w, align: "right"  });
        doc.text(revenueVal,   COL.revenue.x,   y, { width: COL.revenue.w,   align: "right"  });
        doc.text(marginVal,    COL.margin.x,    y, { width: COL.margin.w,    align: "right"  });
        doc.text(profitVal,    COL.profit.x,    y, { width: COL.profit.w,    align: "right"  });
      };

      doc.font("Helvetica-Bold").fontSize(14).text("Product Performance (P&L)", { align: "center" });
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10).text(
        `Range: ${range || "custom"}${lossOnly ? "  |  Loss-makers only" : ""}    Generated: ${new Date().toLocaleString("en-GH", { timeZone: "Africa/Accra" })}`,
        { align: "center" },
      );
      doc.moveDown(0.8);

      // Header row
      doc.font("Helvetica-Bold").fontSize(9);
      const headerY = doc.y;
      drawRow("Rank", "Product", "Net Qty", "Wgt Cost", "Wgt Price", "Total Cost", "Revenue (GHS)", "Margin%", "Profit (GHS)", headerY);
      doc.moveDown(0.5);
      doc.moveTo(40, doc.y).lineTo(800, doc.y).stroke();
      doc.moveDown(0.3);

      // Data rows
      doc.font("Helvetica").fontSize(9);
      for (const r of finalRows) {
        const weightedSold = r.qty > 0 ? r.revenue / r.qty : 0;
        const rowY = doc.y;
        drawRow(
          String(r.rank),
          r.name.length > 30 ? r.name.slice(0, 29) + "…" : r.name,
          String(r.qty),
          r.weightedCost.toFixed(2),
          weightedSold.toFixed(2),
          r.costTotal.toFixed(2),
          r.revenue.toFixed(2),
          `${r.margin.toFixed(1)}%`,
          r.profit.toFixed(2),
          rowY,
        );
        doc.moveDown(0.45);
        // Page break if near bottom margin
        if (doc.y > 540) {
          doc.addPage();
          doc.font("Helvetica-Bold").fontSize(9);
          const newHeaderY = doc.y;
          drawRow("Rank", "Product", "Net Qty", "Wgt Cost", "Wgt Price", "Total Cost", "Revenue (GHS)", "Margin%", "Profit (GHS)", newHeaderY);
          doc.moveDown(0.5);
          doc.moveTo(40, doc.y).lineTo(800, doc.y).stroke();
          doc.moveDown(0.3);
          doc.font("Helvetica").fontSize(9);
        }
      }

      doc.end();
      await done;
      const pdf = Buffer.concat(chunks);
      await recordAuditLog({
        actorId: user?.id || null,
        action: "PRODUCT_PL_EXPORT_PDF",
        entityType: "REPORT",
        entityId: "PRODUCT_PL",
        meta: {
          format: "PDF",
          fileName: `product_pl_${range || "custom"}.pdf`,
          range: range || "custom",
          rowCount: finalRows.length,
          byteSize: pdf.length,
          query: q || null,
          lossOnly,
        },
      });
      return new Response(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="product_pl_${range || "custom"}.pdf"`,
        },
      });
    }

    return NextResponse.json({
      range: range || (gte || lte ? "custom" : "all"),
      start: gte ? gte.toISOString() : null,
      end: lte ? lte.toISOString() : null,
      total,
      page: currentPage,
      pageSize,
      periodTotals,
      rows: pageRows,
    });
  } catch (error) {
    console.error("Error generating product P&L:", error);
    return NextResponse.json({ error: "Failed to generate product P&L" }, { status: 500 });
  }
}
