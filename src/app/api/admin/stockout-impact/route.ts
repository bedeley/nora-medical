import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { formatCurrency } from "@/lib/currency";
import PDFDocument from "pdfkit";
import { recordAuditLog } from "@/lib/audit-log";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const canView = hasPermission(role, "export.data");
  if (!session || !canView) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  const status = (searchParams.get("status") || "all").toLowerCase();
  const sort = (searchParams.get("sort") || "impact").toLowerCase();
  const format = (searchParams.get("format") || "").toLowerCase();

  const snapshots = await prisma.demandSnapshot.findMany({
    distinct: ["productId"],
    orderBy: { createdAt: "desc" },
    where: {
      product: {
        deletedAt: null,
        archived: false,
      },
    },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          stock: true,
          supplier: true,
          supplierRef: { select: { name: true } },
          lastStockoutAt: true,
          inventoryPlan: { select: { reorderPoint: true, leadTimeDays: true } },
        },
      },
    },
  });

  const rows = snapshots
    .map((snap) => {
      const price = Number(snap.product.price || 0);
      const stock = Number(snap.product.stock || 0);
      const reorderPoint = Number(snap.product.inventoryPlan?.reorderPoint || 0);
      const leadTimeDays =
        snap.product.inventoryPlan?.leadTimeDays != null
          ? Number(snap.product.inventoryPlan.leadTimeDays)
          : null;
      const supplierName = snap.product.supplierRef?.name || snap.product.supplier || "";
      const avgDaily = Number(snap.avgDailyDemand || 0);
      const lastStockoutAt = snap.product.lastStockoutAt
        ? new Date(snap.product.lastStockoutAt).getTime()
        : null;
      const daysOut =
        stock <= 0 && lastStockoutAt
          ? Math.max(1, Math.ceil((Date.now() - lastStockoutAt) / (1000 * 60 * 60 * 24)))
          : 0;
      const lostRevenueSinceStockout =
        stock <= 0 && daysOut > 0 ? avgDaily * daysOut * price : 0;
      const start = snap.periodStart.getTime();
      const end = snap.periodEnd.getTime();
      const periodDays = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
      const projectedUnits = avgDaily * periodDays;
      const atRiskUnits = Math.max(0, projectedUnits - stock);
      const impactValue = atRiskUnits * price;
      const state = stock <= 0 ? "out" : stock <= reorderPoint ? "low" : "ok";
      return {
        productId: snap.product.id,
        name: snap.product.name,
        sku: snap.product.sku || "",
        stock,
        reorderPoint,
        leadTimeDays,
        supplier: supplierName,
        daysOut,
        lostRevenueSinceStockout,
        avgDaily,
        periodDays,
        projectedUnits,
        atRiskUnits,
        impactValue,
        state,
      };
    })
    .filter((row) => {
      if (status !== "all" && row.state !== status) return false;
      if (q && !row.name.toLowerCase().includes(q) && !row.sku.toLowerCase().includes(q)) {
        return false;
      }
      return row.state !== "ok";
    })
    .sort((a, b) => {
      if (sort === "units") return b.atRiskUnits - a.atRiskUnits;
      if (sort === "stock") return a.stock - b.stock;
      return b.impactValue - a.impactValue;
    });

  if (format === "csv") {
    const header = [
      "Product",
      "SKU",
      "Stock",
      "Reorder Point",
      "Lead time (days)",
      "Supplier",
      "Days out of stock",
      "Lost revenue since last stockout",
      "Avg Daily Demand",
      "Period Days",
      "At-risk Units",
      "Estimated Impact",
      "Status",
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          JSON.stringify(row.name),
          JSON.stringify(row.sku),
          String(row.stock),
          String(row.reorderPoint),
          row.leadTimeDays != null ? String(row.leadTimeDays) : "",
          JSON.stringify(row.supplier || ""),
          String(row.daysOut || 0),
          formatCurrency(row.lostRevenueSinceStockout || 0),
          row.avgDaily.toFixed(2),
          String(row.periodDays),
          row.atRiskUnits.toFixed(2),
          formatCurrency(row.impactValue),
          row.state.toUpperCase(),
        ].join(","),
      );
    }
    const csv = lines.join("\n");
    await recordAuditLog({
      actorId: user?.id || null,
      action: "STOCKOUT_IMPACT_EXPORT_CSV",
      entityType: "REPORT",
      entityId: "STOCKOUT_IMPACT",
      meta: {
        format: "CSV",
        fileName: `stockout-impact-${Date.now()}.csv`,
        rowCount: rows.length,
        columnCount: header.length,
        byteSize: Buffer.byteLength(csv, "utf8"),
        statusFilter: status,
        sort,
        query: q || null,
        actorName: user?.name || null,
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
      },
    });
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="stockout-impact-${Date.now()}.csv"`,
      },
    });
  }

  if (format === "pdf") {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.on("data", (c) => chunks.push(c));
    const done = new Promise<void>((resolve) => doc.on("end", resolve));

    doc.font("Helvetica-Bold").fontSize(16).text("Stockout Impact", { align: "center" });
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(10)
      .text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(10);
    doc.text(
      "Product                     Stock  Reorder  DaysOut  LostRev   Impact   Status",
    );
    doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).stroke();
    doc.font("Helvetica").fontSize(9);

    rows.forEach((row) => {
      const name = row.name.length > 26 ? `${row.name.slice(0, 23)}...` : row.name;
      const line = `${name.padEnd(28)}  ${String(row.stock).padStart(5)}  ${String(
        row.reorderPoint,
      ).padStart(7)}  ${String(row.daysOut || 0).padStart(7)}  ${formatCurrency(
        row.lostRevenueSinceStockout || 0,
      ).padStart(8)}  ${formatCurrency(row.impactValue).padStart(8)}  ${row.state.toUpperCase()}`;
      doc.text(line);
    });
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    await recordAuditLog({
      actorId: user?.id || null,
      action: "STOCKOUT_IMPACT_EXPORT_PDF",
      entityType: "REPORT",
      entityId: "STOCKOUT_IMPACT",
      meta: {
        format: "PDF",
        fileName: `stockout-impact-${Date.now()}.pdf`,
        rowCount: rows.length,
        byteSize: pdf.length,
        statusFilter: status,
        sort,
        query: q || null,
        actorName: user?.name || null,
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
      },
    });
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="stockout-impact-${Date.now()}.pdf"`,
      },
    });
  }

  return NextResponse.json({
    rows,
    total: rows.length,
    generatedAt: new Date().toISOString(),
  });
}
