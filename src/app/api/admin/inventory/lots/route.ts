import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { recordAuditLog } from "@/lib/audit-log";

const FEFO_HIGH_DAYS_KEY = "inventory.lots.fefo.thresholdDays.high";
const FEFO_MEDIUM_DAYS_KEY = "inventory.lots.fefo.thresholdDays.medium";
const DEFAULT_FEFO_HIGH_DAYS = 30;
const DEFAULT_FEFO_MEDIUM_DAYS = 60;

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

function parseThreshold(value: unknown, fallback: number) {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  const rounded = Math.floor(raw);
  return rounded > 0 ? rounded : fallback;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const productId = searchParams.get("productId") || "";
    const q = searchParams.get("q") || "";
    const status = (searchParams.get("status") || "").toUpperCase();
    const expStart = searchParams.get("expStart");
    const expEnd = searchParams.get("expEnd");
    const expiringWithin = Number(searchParams.get("expiringWithin") || "");
    const format = searchParams.get("format");

    const now = new Date();
    const where: Prisma.InventoryLotWhereInput = {
      product: {
        is: {
          deletedAt: null,
          OR: [{ requiresLotTracking: true }, { requiresExpiryDate: true }],
        },
      },
    };
    if (productId) where.productId = productId;
    if (q.trim()) where.lotCode = { contains: q.trim(), mode: "insensitive" };

    let expiryDateFilter: Prisma.DateTimeNullableFilter | undefined;
    if (expStart || expEnd) {
      expiryDateFilter = {};
      if (expStart) expiryDateFilter.gte = new Date(expStart);
      if (expEnd) {
        const dt = new Date(expEnd);
        dt.setHours(23, 59, 59, 999);
        expiryDateFilter.lte = dt;
      }
    }

    if (Number.isFinite(expiringWithin) && expiringWithin > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + expiringWithin);
      expiryDateFilter = {
        ...(expiryDateFilter || {}),
        lte: cutoff,
      };
    }
    if (expiryDateFilter) where.expiryDate = expiryDateFilter;

    const thresholdSettings = await prisma.appSetting.findMany({
      where: { key: { in: [FEFO_HIGH_DAYS_KEY, FEFO_MEDIUM_DAYS_KEY] } },
      select: { key: true, value: true },
    });
    const thresholdMap = new Map(thresholdSettings.map((row) => [row.key, row.value]));
    const highDays = parseThreshold(thresholdMap.get(FEFO_HIGH_DAYS_KEY), DEFAULT_FEFO_HIGH_DAYS);
    const mediumDaysRaw = parseThreshold(
      thresholdMap.get(FEFO_MEDIUM_DAYS_KEY),
      DEFAULT_FEFO_MEDIUM_DAYS,
    );
    const mediumDays = mediumDaysRaw <= highDays ? highDays + 30 : mediumDaysRaw;

    const rows = await prisma.inventoryLot.findMany({
      where,
      include: {
        product: { select: { name: true, sku: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
    });

    const items = rows
      .filter((row) => {
        if (status === "EXPIRED") {
          return row.expiryDate != null && row.expiryDate <= now;
        }
        if (status === "ACTIVE") {
          return row.expiryDate == null || row.expiryDate > now;
        }
        return true;
      })
      .map((row) => ({
        id: row.id,
        productId: row.productId,
        productName: row.product?.name || "",
        productSku: row.product?.sku || null,
        supplierId: row.supplierId || null,
        supplierName: row.supplier?.name || null,
        lotCode: row.lotCode,
        expiryDate: row.expiryDate,
        receivedAt: row.receivedAt,
        quantityReceived: row.quantityReceived,
        quantityRemaining: row.quantityRemaining,
        notes: row.notes || null,
      }));

    const summary = items.reduce(
      (acc, row) => {
        acc.totalLots += 1;
        acc.totalRemaining += Number(row.quantityRemaining || 0);
        if (row.expiryDate) {
          if (row.expiryDate <= now) acc.expiredLots += 1;
          else {
            const days = Math.ceil((row.expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            if (days <= highDays) acc.expiringHigh += 1;
            if (days <= mediumDays) acc.expiringMedium += 1;
          }
        }
        return acc;
      },
      {
        totalLots: 0,
        totalRemaining: 0,
        expiredLots: 0,
        expiringHigh: 0,
        expiringMedium: 0,
      },
    );

    const regulatedProducts = await prisma.product.findMany({
      where: {
        OR: [{ requiresLotTracking: true }, { requiresExpiryDate: true }],
        ...(productId ? { id: productId } : {}),
      },
      select: {
        id: true,
        name: true,
        sku: true,
        stock: true,
        requiresLotTracking: true,
        requiresExpiryDate: true,
      },
    });
    let regulatedIds = regulatedProducts.map((p) => p.id);

    if (Number.isFinite(expiringWithin) && expiringWithin > 0 && regulatedIds.length) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + expiringWithin);
      const expiringLots = await prisma.inventoryLot.findMany({
        where: {
          productId: { in: regulatedIds },
          expiryDate: { lte: cutoff },
          quantityRemaining: { gt: 0 },
        },
        select: { productId: true },
      });
      const expiringIds = new Set(expiringLots.map((lot) => lot.productId));
      const missingExpiryIds = new Set(
        regulatedProducts.filter((p) => p.requiresExpiryDate).map((p) => p.id),
      );
      regulatedIds = regulatedIds.filter((id) => expiringIds.has(id) || missingExpiryIds.has(id));
    }

    const lotAgg = regulatedIds.length
      ? await prisma.inventoryLot.groupBy({
          by: ["productId"],
          _sum: { quantityRemaining: true },
          _count: { _all: true },
          where: { productId: { in: regulatedIds } },
        })
      : [];
    const lotAggMap = new Map(
      lotAgg.map((row) => [
        row.productId,
        {
          remaining: Number(row._sum.quantityRemaining || 0),
          count: Number(row._count?._all || 0),
        },
      ]),
    );

    const expiryRequiredIds = regulatedProducts
      .filter((p) => p.requiresExpiryDate)
      .map((p) => p.id)
      .filter((id) => regulatedIds.includes(id));
    const receivedAtRange: { gte?: Date; lte?: Date } | undefined =
      expStart || expEnd
        ? {
            ...(expStart ? { gte: new Date(expStart) } : {}),
            ...(expEnd
              ? (() => {
                  const dt = new Date(expEnd);
                  dt.setHours(23, 59, 59, 999);
                  return { lte: dt };
                })()
              : {}),
          }
        : undefined;
    const missingExpiryLots = expiryRequiredIds.length
      ? await prisma.inventoryLot.findMany({
          where: {
            productId: { in: expiryRequiredIds },
            expiryDate: null,
            ...(receivedAtRange ? { receivedAt: receivedAtRange } : {}),
          },
          select: {
            id: true,
            productId: true,
            lotCode: true,
            receivedAt: true,
            quantityRemaining: true,
            product: { select: { name: true, sku: true } },
          },
          orderBy: { receivedAt: "desc" },
          take: 20,
        })
      : [];

    const missingLotMovements = regulatedIds.length
      ? await prisma.inventoryMovement.findMany({
          where: {
            productId: { in: regulatedIds },
            lotId: null,
            reason: {
              in: ["PURCHASE", "SALE", "RETURN_PARTIAL", "RETURN_FULL", "CYCLE_COUNT", "STOCK_ADJUSTMENT"],
            },
            ...(receivedAtRange ? { createdAt: receivedAtRange } : {}),
          },
          select: {
            id: true,
            productId: true,
            reason: true,
            delta: true,
            createdAt: true,
            product: { select: { name: true, sku: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        })
      : [];

    const missingLotCoverage = regulatedProducts
      .filter((p) => p.requiresLotTracking)
      .map((p) => {
        const agg = lotAggMap.get(p.id);
        const remaining = agg?.remaining ?? 0;
        const stock = Number(p.stock || 0);
        if (stock <= remaining) return null;
        return {
          productId: p.id,
          productName: p.name,
          productSku: p.sku,
          stock,
          trackedRemaining: remaining,
          missingUnits: Math.max(0, stock - remaining),
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    const compliance = {
      regulatedCount: regulatedProducts.length,
      missingExpiryLots: missingExpiryLots.length,
      missingLotMovements: missingLotMovements.length,
      missingLotCoverage: missingLotCoverage.length,
      missingExpirySamples: missingExpiryLots.map((lot) => ({
        id: lot.id,
        productId: lot.productId,
        productName: lot.product?.name || "",
        productSku: lot.product?.sku || null,
        lotCode: lot.lotCode,
        receivedAt: lot.receivedAt,
        quantityRemaining: lot.quantityRemaining,
      })),
      missingMovementSamples: missingLotMovements.map((move) => ({
        id: move.id,
        productId: move.productId,
        productName: move.product?.name || "",
        productSku: move.product?.sku || null,
        reason: move.reason,
        delta: move.delta,
        createdAt: move.createdAt,
      })),
      missingCoverageSamples: missingLotCoverage as Array<{
        productId: string;
        productName: string;
        productSku: string | null;
        stock: number;
        trackedRemaining: number;
        missingUnits: number;
      }>,
    };

    if (format === "compliance_csv") {
      const header = [
        "Issue",
        "Product",
        "SKU",
        "Lot",
        "Qty Remaining",
        "Stock",
        "Tracked Remaining",
        "Missing Units",
        "Reason",
        "Delta",
        "Date",
      ];
      const lines = [header.join(",")];
      lines.push(["SUMMARY", "", "", "", "", "", "", "", "", "", ""].join(","));
      lines.push(
        [
          "Regulated SKUs",
          String(compliance.regulatedCount),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ].join(","),
      );
      lines.push(
        [
          "Missing expiry lots",
          String(compliance.missingExpiryLots),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ].join(","),
      );
      lines.push(
        [
          "Untracked movements",
          String(compliance.missingLotMovements),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ].join(","),
      );
      lines.push(
        [
          "Stock without lot coverage",
          String(compliance.missingLotCoverage),
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ].join(","),
      );

      for (const row of compliance.missingExpirySamples) {
        lines.push(
          [
            "MISSING_EXPIRY",
            JSON.stringify(row.productName),
            JSON.stringify(row.productSku || ""),
            JSON.stringify(row.lotCode || ""),
            String(row.quantityRemaining || 0),
            "",
            "",
            "",
            "",
            "",
            new Date(row.receivedAt).toISOString().slice(0, 10),
          ].join(","),
        );
      }
      for (const row of compliance.missingCoverageSamples) {
        lines.push(
          [
            "MISSING_LOT_COVERAGE",
            JSON.stringify(row.productName),
            JSON.stringify(row.productSku || ""),
            "",
            "",
            String(row.stock || 0),
            String(row.trackedRemaining || 0),
            String(row.missingUnits || 0),
            "",
            "",
            "",
          ].join(","),
        );
      }
      for (const row of compliance.missingMovementSamples) {
        lines.push(
          [
            "MISSING_LOT_MOVEMENT",
            JSON.stringify(row.productName),
            JSON.stringify(row.productSku || ""),
            "",
            "",
            "",
            "",
            "",
            JSON.stringify(row.reason || ""),
            String(row.delta || 0),
            new Date(row.createdAt).toISOString().slice(0, 10),
          ].join(","),
        );
      }

      const csv = lines.join("\n");
      await recordAuditLog({
        actorId: user?.id || null,
        action: "INVENTORY_LOTS_COMPLIANCE_EXPORT_CSV",
        entityType: "INVENTORY_LOT",
        entityId: "COMPLIANCE",
        meta: {
          format: "CSV",
          fileName: `inventory_lot_compliance_${Date.now()}.csv`,
          rowCount: Math.max(0, lines.length - 1),
          columnCount: 11,
          byteSize: Buffer.byteLength(csv, "utf8"),
          actorName: user?.name || null,
          actorEmail: user?.email || null,
          actorRole: user?.role || null,
        },
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=inventory_lot_compliance_${Date.now()}.csv`,
        },
      });
    }

    if (format === "csv") {
      const header = [
        "Product",
        "SKU",
        "Lot",
        "Supplier",
        "Expiry",
        "Received",
        "Qty Received",
        "Qty Remaining",
        "Notes",
      ];
      const lines = [header.join(",")];
      for (const row of items) {
        lines.push([
          JSON.stringify(row.productName),
          JSON.stringify(row.productSku || ""),
          JSON.stringify(row.lotCode || ""),
          JSON.stringify(row.supplierName || ""),
          row.expiryDate ? new Date(row.expiryDate).toISOString().slice(0, 10) : "",
          new Date(row.receivedAt).toISOString().slice(0, 10),
          String(row.quantityReceived || 0),
          String(row.quantityRemaining || 0),
          JSON.stringify(row.notes || ""),
        ].join(","));
      }
      const csv = lines.join("\n");
      await recordAuditLog({
        actorId: user?.id || null,
        action: "INVENTORY_LOTS_EXPORT_CSV",
        entityType: "INVENTORY_LOT",
        entityId: "LIST",
        meta: {
          format: "CSV",
          fileName: `inventory_lots_${Date.now()}.csv`,
          rowCount: Math.max(0, lines.length - 1),
          columnCount: header.length,
          byteSize: Buffer.byteLength(csv, "utf8"),
          actorName: user?.name || null,
          actorEmail: user?.email || null,
          actorRole: user?.role || null,
        },
      });
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=inventory_lots_${Date.now()}.csv`,
        },
      });
    }

    return NextResponse.json({
      items,
      summary: {
        ...summary,
        expiring30: summary.expiringHigh,
        expiring60: summary.expiringMedium,
      },
      fefoThresholds: {
        highDays,
        mediumDays,
      },
      compliance,
    });
  } catch (error) {
    console.error("Inventory lots fetch error:", error);
    return NextResponse.json({ error: "Failed to load lots" }, { status: 500 });
  }
}
