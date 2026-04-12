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
const DEFAULT_SORT_BY = "expiryDate";

const TRACKED_MOVEMENT_REASONS = [
  "PURCHASE",
  "SALE",
  "RETURN_PARTIAL",
  "RETURN_FULL",
  "CYCLE_COUNT",
  "STOCK_ADJUSTMENT",
];

type LotSortField =
  | "expiryDate"
  | "receivedAt"
  | "quantityReceived"
  | "quantityRemaining"
  | "productName"
  | "lotCode"
  | "supplierName";
type LotSortDir = "asc" | "desc";

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

function mapLotRow(
  row: Awaited<ReturnType<typeof prisma.inventoryLot.findMany>>[number],
) {
  return {
    id: row.id,
    productId: row.productId,
    productName: (row as { product?: { name?: string } | null }).product?.name || "",
    productSku: (row as { product?: { sku?: string | null } | null }).product?.sku || null,
    supplierId: row.supplierId || null,
    supplierName: (row as { supplier?: { name?: string } | null }).supplier?.name || null,
    lotCode: row.lotCode,
    expiryDate: row.expiryDate,
    receivedAt: row.receivedAt,
    quantityReceived: row.quantityReceived,
    quantityRemaining: row.quantityRemaining,
    notes: row.notes || null,
  };
}

function isSortField(value: string | null): value is LotSortField {
  return (
    value === "expiryDate" ||
    value === "receivedAt" ||
    value === "quantityReceived" ||
    value === "quantityRemaining" ||
    value === "productName" ||
    value === "lotCode" ||
    value === "supplierName"
  );
}

function parseSortDir(value: string | null): LotSortDir {
  return value === "desc" ? "desc" : "asc";
}

function buildLotOrderBy(
  sortBy: LotSortField,
  sortDir: LotSortDir,
): Prisma.InventoryLotOrderByWithRelationInput[] {
  switch (sortBy) {
    case "productName":
      return [{ product: { name: sortDir } }, { lotCode: "asc" }, { id: "asc" }];
    case "lotCode":
      return [{ lotCode: sortDir }, { id: "asc" }];
    case "receivedAt":
      return [{ receivedAt: sortDir }, { id: "asc" }];
    case "quantityReceived":
      return [{ quantityReceived: sortDir }, { expiryDate: "asc" }, { id: "asc" }];
    case "quantityRemaining":
      return [{ quantityRemaining: sortDir }, { expiryDate: "asc" }, { id: "asc" }];
    case "supplierName":
      return [{ supplier: { name: sortDir } }, { product: { name: "asc" } }, { id: "asc" }];
    case "expiryDate":
    default:
      return [{ expiryDate: sortDir }, { receivedAt: "asc" }, { id: "asc" }];
  }
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
    const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
    const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") || "50") || 50));
    const sortBy = isSortField(searchParams.get("sortBy"))
      ? (searchParams.get("sortBy") as LotSortField)
      : DEFAULT_SORT_BY;
    const sortDir = parseSortDir(searchParams.get("sortDir"));

    const now = new Date();

    // --- Product search autocomplete ---
    if (format === "product_search") {
      const pq = searchParams.get("q") || "";
      const regulatedWhere: Prisma.ProductWhereInput = {
        deletedAt: null,
        OR: [{ requiresLotTracking: true }, { requiresExpiryDate: true }],
      };
      const products = await prisma.product.findMany({
        where: pq.trim()
          ? {
              ...regulatedWhere,
              AND: [
                {
                  OR: [
                    { name: { contains: pq.trim(), mode: "insensitive" } },
                    { sku: { contains: pq.trim(), mode: "insensitive" } },
                  ],
                },
              ],
            }
          : regulatedWhere,
        select: { id: true, name: true, sku: true },
        take: 20,
        orderBy: { name: "asc" },
      });
      return NextResponse.json({ products });
    }

    // --- FEFO thresholds ---
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

    // --- Base where clause (expiry date filters, lot code search, product filter) ---
    const baseWhere: Prisma.InventoryLotWhereInput = {
      product: {
        is: {
          deletedAt: null,
          OR: [{ requiresLotTracking: true }, { requiresExpiryDate: true }],
        },
      },
    };
    if (productId) baseWhere.productId = productId;
    if (q.trim()) baseWhere.lotCode = { contains: q.trim(), mode: "insensitive" };

    // Expiry date filter. expiringWithin and expStart/expEnd coexist; take the more restrictive end bound.
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
      const existingLte = expiryDateFilter?.lte instanceof Date ? expiryDateFilter.lte : null;
      const effectiveLte = existingLte && existingLte < cutoff ? existingLte : cutoff;
      expiryDateFilter = { ...(expiryDateFilter ?? {}), lte: effectiveLte };
    }
    if (expiryDateFilter) baseWhere.expiryDate = expiryDateFilter;

    // Status filter applied at the DB level (not in JS) for correctness and scalability
    const statusClause: Prisma.InventoryLotWhereInput =
      status === "EXPIRED"
        ? { expiryDate: { not: null, lte: now } }
        : status === "ACTIVE"
        ? { OR: [{ expiryDate: null }, { expiryDate: { gt: now } }] }
        : {};

    const finalWhere: Prisma.InventoryLotWhereInput =
      status === "EXPIRED" || status === "ACTIVE"
        ? { AND: [baseWhere, statusClause] }
        : baseWhere;

    const lotInclude = {
      product: { select: { name: true, sku: true } },
      supplier: { select: { id: true, name: true } },
    } as const;

    const lotOrderBy = buildLotOrderBy(sortBy, sortDir);

    // --- CSV exports: need all matching rows, not just the current page ---
    if (format === "csv" || format === "compliance_csv") {
      const allRows = format === "csv"
        ? await prisma.inventoryLot.findMany({
            where: finalWhere,
            include: lotInclude,
            orderBy: lotOrderBy,
          })
        : [];

      if (format === "csv") {
        const allItems = allRows.map(mapLotRow);
        const header = [
          "Product", "SKU", "Lot", "Supplier", "Expiry",
          "Received", "Qty Received", "Qty Remaining", "Notes",
        ];
        const lines = [header.join(",")];
        for (const row of allItems) {
          lines.push(
            [
              JSON.stringify(row.productName),
              JSON.stringify(row.productSku || ""),
              JSON.stringify(row.lotCode || ""),
              JSON.stringify(row.supplierName || ""),
              row.expiryDate ? new Date(String(row.expiryDate)).toISOString().slice(0, 10) : "",
              new Date(String(row.receivedAt)).toISOString().slice(0, 10),
              String(row.quantityReceived || 0),
              String(row.quantityRemaining || 0),
              JSON.stringify(row.notes || ""),
            ].join(","),
          );
        }
        const csv = lines.join("\n");
        await recordAuditLog({
          actorId: user?.id || null,
          action: "INVENTORY_LOTS_EXPORT_CSV",
          entityType: "INVENTORY_LOT",
          entityId: "LIST",
          request: req,
          outcome: "SUCCESS",
          meta: {
            sourcePage: "admin/inventory-lots",
            section: "lots",
            operation: "export_csv",
            resultSummary: `Exported ${Math.max(0, lines.length - 1)} inventory lot row(s) to CSV.`,
            format: "CSV",
            fileName: `inventory_lots_${Date.now()}.csv`,
            rowCount: Math.max(0, lines.length - 1),
            columnCount: header.length,
            byteSize: Buffer.byteLength(csv, "utf8"),
            scopeSnapshot: `Filters q=${q || "-"} productId=${productId || "-"} status=${status || "-"} expiringWithin=${expiringWithin || "-"}`,
            matchingCount: allItems.length,
            totalCount: allItems.length,
            sortKey: sortBy,
            sortDir,
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

      // compliance_csv — compliance data follows below after regulatedProducts queries
    }

    // --- Parallel DB queries for summary + paginated items ---
    const highCutoff = new Date(now.getTime() + highDays * 24 * 60 * 60 * 1000);
    const mediumCutoff = new Date(now.getTime() + mediumDays * 24 * 60 * 60 * 1000);

    const [
      totalItems,
      totalRemainingAgg,
      expiredLotsCount,
      expiringHighCount,
      expiringMediumCount,
      rows,
    ] = await Promise.all([
      prisma.inventoryLot.count({ where: finalWhere }),
      prisma.inventoryLot.aggregate({ _sum: { quantityRemaining: true }, where: finalWhere }),
      // expired: expiryDate IS NOT NULL AND <= now
      prisma.inventoryLot.count({
        where: { AND: [finalWhere, { expiryDate: { not: null, lte: now } }] },
      }),
      // expiring high: expires soon but NOT yet expired
      prisma.inventoryLot.count({
        where: { AND: [finalWhere, { expiryDate: { gt: now, lte: highCutoff } }] },
      }),
      // expiring medium: expires after highCutoff but within mediumCutoff
      prisma.inventoryLot.count({
        where: { AND: [finalWhere, { expiryDate: { gt: highCutoff, lte: mediumCutoff } }] },
      }),
      prisma.inventoryLot.findMany({
        where: finalWhere,
        include: lotInclude,
        orderBy: lotOrderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items = rows.map(mapLotRow);

    const summary = {
      totalLots: totalItems,
      totalRemaining: Number(totalRemainingAgg._sum.quantityRemaining || 0),
      expiredLots: expiredLotsCount,
      expiringHigh: expiringHighCount,
      expiringMedium: expiringMediumCount,
    };

    // --- Compliance ---
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

    const missingExpiryBaseWhere = {
      productId: { in: expiryRequiredIds },
      expiryDate: null,
      ...(receivedAtRange ? { receivedAt: receivedAtRange } : {}),
    } satisfies Prisma.InventoryLotWhereInput;

    const [missingExpiryCount, missingExpiryLots] = expiryRequiredIds.length
      ? await Promise.all([
          prisma.inventoryLot.count({ where: missingExpiryBaseWhere }),
          prisma.inventoryLot.findMany({
            where: missingExpiryBaseWhere,
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
          }),
        ])
      : ([0, []] as const);

    const missingMovementsBaseWhere = {
      productId: { in: regulatedIds },
      lotId: null,
      reason: { in: TRACKED_MOVEMENT_REASONS },
      ...(receivedAtRange ? { createdAt: receivedAtRange } : {}),
    } satisfies Prisma.InventoryMovementWhereInput;

    const [missingMovementsCount, missingLotMovements] = regulatedIds.length
      ? await Promise.all([
          prisma.inventoryMovement.count({ where: missingMovementsBaseWhere }),
          prisma.inventoryMovement.findMany({
            where: missingMovementsBaseWhere,
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
          }),
        ])
      : ([0, []] as const);

    const allMissingCoverage = regulatedProducts
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
      .filter(Boolean) as Array<{
      productId: string;
      productName: string;
      productSku: string | null;
      stock: number;
      trackedRemaining: number;
      missingUnits: number;
    }>;

    const compliance = {
      regulatedCount: regulatedProducts.length,
      missingExpiryLots: missingExpiryCount,
      missingLotMovements: missingMovementsCount,
      missingLotCoverage: allMissingCoverage.length,
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
      missingCoverageSamples: allMissingCoverage.slice(0, 20),
    };

    // compliance_csv needs compliance data, which is built above
    if (format === "compliance_csv") {
      const header = [
        "Issue", "Product", "SKU", "Lot", "Qty Remaining",
        "Stock", "Tracked Remaining", "Missing Units", "Reason", "Delta", "Date",
      ];
      const lines = [header.join(",")];
      lines.push(["SUMMARY", "", "", "", "", "", "", "", "", "", ""].join(","));
      lines.push(["Regulated SKUs", String(compliance.regulatedCount), ...Array(9).fill("")].join(","));
      lines.push(["Missing expiry lots", String(compliance.missingExpiryLots), ...Array(9).fill("")].join(","));
      lines.push(["Untracked movements", String(compliance.missingLotMovements), ...Array(9).fill("")].join(","));
      lines.push(["Stock without lot coverage", String(compliance.missingLotCoverage), ...Array(9).fill("")].join(","));

      for (const row of compliance.missingExpirySamples) {
        lines.push([
          "MISSING_EXPIRY",
          JSON.stringify(row.productName),
          JSON.stringify(row.productSku || ""),
          JSON.stringify(row.lotCode || ""),
          String(row.quantityRemaining || 0),
          "", "", "", "", "",
          new Date(row.receivedAt).toISOString().slice(0, 10),
        ].join(","));
      }
      for (const row of compliance.missingCoverageSamples) {
        lines.push([
          "MISSING_LOT_COVERAGE",
          JSON.stringify(row.productName),
          JSON.stringify(row.productSku || ""),
          "", "",
          String(row.stock || 0),
          String(row.trackedRemaining || 0),
          String(row.missingUnits || 0),
          "", "", "",
        ].join(","));
      }
      for (const row of compliance.missingMovementSamples) {
        lines.push([
          "MISSING_LOT_MOVEMENT",
          JSON.stringify(row.productName),
          JSON.stringify(row.productSku || ""),
          "", "", "", "", "",
          JSON.stringify(row.reason || ""),
          String(row.delta || 0),
          new Date(row.createdAt).toISOString().slice(0, 10),
        ].join(","));
      }

      const csv = lines.join("\n");
      await recordAuditLog({
        actorId: user?.id || null,
        action: "INVENTORY_LOTS_COMPLIANCE_EXPORT_CSV",
        entityType: "INVENTORY_LOT",
        entityId: "COMPLIANCE",
        request: req,
        outcome: "SUCCESS",
        meta: {
          sourcePage: "admin/inventory-lots",
          section: "compliance",
          operation: "export_csv",
          resultSummary: `Exported ${Math.max(0, lines.length - 1)} inventory lot compliance row(s) to CSV.`,
          format: "CSV",
          fileName: `inventory_lot_compliance_${Date.now()}.csv`,
          rowCount: Math.max(0, lines.length - 1),
          columnCount: 11,
          byteSize: Buffer.byteLength(csv, "utf8"),
          scopeSnapshot: "Inventory lots compliance report",
          matchingCount: Math.max(0, lines.length - 1),
          totalCount: Math.max(0, lines.length - 1),
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

    return NextResponse.json({
      items,
      totalItems,
      page,
      pageSize,
      sortBy,
      sortDir,
      summary: {
        ...summary,
        expiring30: summary.expiringHigh,
        expiring60: summary.expiringMedium,
      },
      fefoThresholds: { highDays, mediumDays },
      compliance,
    });
  } catch (error) {
    console.error("Inventory lots fetch error:", error);
    return NextResponse.json({ error: "Failed to load lots" }, { status: 500 });
  }
}
