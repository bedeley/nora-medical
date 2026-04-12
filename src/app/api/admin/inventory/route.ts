import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

type InventorySortKey =
  | "price"
  | "stock"
  | "totalValue"
  | "salesValue"
  | "costValue";

type InventoryRow = {
  id: string;
  sku?: string | null;
  name: string;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
  price: number;
  cost?: number;
  stock: number;
  totalValue: number;
  avgPurchaseCost?: number | null;
  lastPurchaseCost?: number | null;
  lastPurchaseDate?: string | null;
  lastPurchaseSupplier?: string | null;
  lastPurchaseNote?: string | null;
  soldLast30?: number | null;
  avgDailySales?: number | null;
  daysOfStock?: number | null;
  weeksCover?: number | null;
  reorderPoint?: number | null;
  suggestedReorder?: number | null;
};

type InventoryFilters = {
  includeArchived: boolean;
  productId: string | null;
  q: string;
  minStock: number | null;
  maxStock: number | null;
  minPrice: number | null;
  maxPrice: number | null;
};

function roundUpToStep(value: number, step: number) {
  if (step <= 1) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

function parseOptionalNumber(value: string | null) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function andSql(conditions: Prisma.Sql[]) {
  if (conditions.length === 0) return Prisma.sql`TRUE`;
  return conditions.slice(1).reduce(
    (acc, condition) => Prisma.sql`${acc} AND ${condition}`,
    conditions[0],
  );
}

function getInventoryFilterSql(filters: InventoryFilters) {
  const conditions: Prisma.Sql[] = [Prisma.sql`p."deletedAt" IS NULL`];
  if (!filters.includeArchived) {
    conditions.push(Prisma.sql`p."archived" = false`);
  }
  if (filters.productId) {
    conditions.push(Prisma.sql`p."id" = ${filters.productId}`);
  }
  if (filters.q) {
    const query = `%${filters.q}%`;
    conditions.push(
      Prisma.sql`(p."name" ILIKE ${query} OR COALESCE(p."sku", '') ILIKE ${query})`,
    );
  }
  if (filters.minStock != null) {
    conditions.push(Prisma.sql`p."stock" >= ${filters.minStock}`);
  }
  if (filters.maxStock != null) {
    conditions.push(Prisma.sql`p."stock" <= ${filters.maxStock}`);
  }
  if (filters.minPrice != null) {
    conditions.push(Prisma.sql`p."price" >= ${filters.minPrice}`);
  }
  if (filters.maxPrice != null) {
    conditions.push(Prisma.sql`p."price" <= ${filters.maxPrice}`);
  }
  return andSql(conditions);
}

function getInventoryBaseWhere(filters: InventoryFilters): Prisma.ProductWhereInput {
  return {
    deletedAt: null,
    ...(filters.includeArchived ? {} : { archived: false }),
    ...(filters.productId ? { id: filters.productId } : {}),
  };
}

function getInventoryFilteredWhere(
  filters: InventoryFilters,
): Prisma.ProductWhereInput {
  return {
    ...getInventoryBaseWhere(filters),
    ...(filters.q
      ? {
          OR: [
            { name: { contains: filters.q, mode: "insensitive" } },
            { sku: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(filters.minStock != null || filters.maxStock != null
      ? {
          stock: {
            ...(filters.minStock != null ? { gte: filters.minStock } : {}),
            ...(filters.maxStock != null ? { lte: filters.maxStock } : {}),
          },
        }
      : {}),
    ...(filters.minPrice != null || filters.maxPrice != null
      ? {
          price: {
            ...(filters.minPrice != null ? { gte: filters.minPrice } : {}),
            ...(filters.maxPrice != null ? { lte: filters.maxPrice } : {}),
          },
        }
      : {}),
  };
}

function getInventoryOrderSql(
  sortKey: InventorySortKey | null,
  sortDir: "asc" | "desc",
) {
  const direction = sortDir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  if (sortKey === "price") {
    return Prisma.sql`"price" ${direction}, LOWER("name") ASC, "id" ASC`;
  }
  if (sortKey === "stock") {
    return Prisma.sql`"stock" ${direction}, LOWER("name") ASC, "id" ASC`;
  }
  if (sortKey === "totalValue" || sortKey === "salesValue") {
    return Prisma.sql`"sales_value" ${direction}, LOWER("name") ASC, "id" ASC`;
  }
  if (sortKey === "costValue") {
    return Prisma.sql`"cost_value" ${direction}, LOWER("name") ASC, "id" ASC`;
  }
  return Prisma.sql`"updatedAt" DESC, LOWER("name") ASC, "id" ASC`;
}

async function getDefaultReorderPoint() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "inventoryPlanning.defaultReorderPoint" },
    select: { value: true },
  });
  const raw =
    typeof setting?.value === "number" ? setting.value : Number(setting?.value);
  return Number.isFinite(raw) && raw >= 0 ? Number(raw) : 10;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return new Response("Forbidden", { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "1";
  const productId = searchParams.get("productId")?.trim() || null;
  const q = searchParams.get("q")?.trim().toLowerCase() ?? "";
  const minStock = parseOptionalNumber(searchParams.get("minStock"));
  const maxStock = parseOptionalNumber(searchParams.get("maxStock"));
  const minPrice = parseOptionalNumber(searchParams.get("minPrice"));
  const maxPrice = parseOptionalNumber(searchParams.get("maxPrice"));
  const sortKey = searchParams.get("sortKey") as InventorySortKey | null;
  const sortDir = searchParams.get("sortDir") === "asc" ? "asc" : "desc";
  const requestedPageSize = clamp(
    Number(searchParams.get("pageSize") ?? 50) || 50,
    1,
    200,
  );
  const requestedPage = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const includeAll = searchParams.get("all") === "1";
  const filters: InventoryFilters = {
    includeArchived,
    productId,
    q,
    minStock,
    maxStock,
    minPrice,
    maxPrice,
  };
  const baseWhere = getInventoryBaseWhere(filters);
  const filteredWhere = getInventoryFilteredWhere(filters);
  const filterSql = getInventoryFilterSql(filters);
  const orderSql = getInventoryOrderSql(sortKey, sortDir);
  const lookbackDays = 30;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  since.setUTCHours(0, 0, 0, 0);
  const [totalCount, matchingCount, defaultReorderPoint] = await Promise.all([
    prisma.product.count({ where: baseWhere }),
    prisma.product.count({ where: filteredWhere }),
    getDefaultReorderPoint(),
  ]);
  const totalPages = includeAll
    ? 1
    : Math.max(1, Math.ceil(matchingCount / requestedPageSize));
  const page = includeAll ? 1 : Math.min(requestedPage, totalPages);
  const offset = includeAll ? 0 : (page - 1) * requestedPageSize;
  const limitSql = includeAll
    ? Prisma.empty
    : Prisma.sql`LIMIT ${requestedPageSize} OFFSET ${offset}`;

  let filteredTotals = { priceValue: 0, costValue: 0 };
  let pageProductIds: string[] = [];

  if (matchingCount > 0) {
    const purchaseCostCte = Prisma.sql`
      WITH "purchase_costs" AS (
        SELECT
          "productId",
          SUM(("quantity" * "unitCost"))::numeric / NULLIF(SUM("quantity"), 0)::numeric AS "avgCost"
        FROM "Purchase"
        WHERE "status" = 'RECEIVED'
          AND "deletedAt" IS NULL
          AND "quantity" > 0
          AND "unitCost" > 0
        GROUP BY "productId"
      ),
      "latest_purchase" AS (
        SELECT DISTINCT ON ("productId")
          "productId",
          "unitCost"::numeric AS "unitCost"
        FROM "Purchase"
        WHERE "status" = 'RECEIVED'
          AND "deletedAt" IS NULL
          AND "quantity" > 0
          AND "unitCost" > 0
        ORDER BY "productId", "createdAt" DESC, "id" DESC
      )
    `;

    const [aggregateRows, pageIdRows] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          salesTotal: Prisma.Decimal | number | string | null;
          costTotal: Prisma.Decimal | number | string | null;
        }>
      >(Prisma.sql`
        ${purchaseCostCte}
        SELECT
          COALESCE(SUM((p."price" * p."stock")::numeric), 0)::numeric AS "salesTotal",
          COALESCE(
            SUM((COALESCE(pc."avgCost", lp."unitCost", p."cost") * p."stock")::numeric),
            0
          )::numeric AS "costTotal"
        FROM "Product" p
        LEFT JOIN "purchase_costs" pc ON pc."productId" = p."id"
        LEFT JOIN "latest_purchase" lp ON lp."productId" = p."id"
        WHERE ${filterSql}
      `),
      prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        ${purchaseCostCte}
        , "filtered_products" AS (
          SELECT
            p."id",
            p."name",
            p."updatedAt",
            p."price",
            p."stock",
            (p."price" * p."stock")::numeric AS "sales_value",
            (COALESCE(pc."avgCost", lp."unitCost", p."cost") * p."stock")::numeric AS "cost_value"
          FROM "Product" p
          LEFT JOIN "purchase_costs" pc ON pc."productId" = p."id"
          LEFT JOIN "latest_purchase" lp ON lp."productId" = p."id"
          WHERE ${filterSql}
        )
        SELECT "id"
        FROM "filtered_products"
        ORDER BY ${orderSql}
        ${limitSql}
      `),
    ]);

    const aggregateRow = aggregateRows[0];
    filteredTotals = {
      priceValue: Number(aggregateRow?.salesTotal ?? 0),
      costValue: Number(aggregateRow?.costTotal ?? 0),
    };
    pageProductIds = pageIdRows.map((row) => row.id);
  }

  if (pageProductIds.length === 0) {
    return Response.json({
      rows: [],
      totalCount,
      matchingCount,
      page,
      pageSize: includeAll ? matchingCount || requestedPageSize : requestedPageSize,
      totalPages,
      filteredTotals,
    });
  }

  const products = await prisma.product.findMany({
    where: { id: { in: pageProductIds } },
    include: {
      inventoryPlan: true,
      supplierRef: {
        select: {
          name: true,
          leadTimeDays: true,
          leadTimeMinDays: true,
          leadTimeMaxDays: true,
          defaultMinOrderQty: true,
          defaultPackSize: true,
        },
      },
      supplierLinks: {
        select: {
          supplierId: true,
          isPrimary: true,
          leadTimeDays: true,
          minOrderQty: true,
          packSize: true,
        },
      },
    },
  });
  const productIds = products.map((p) => p.id);
  const supplierNames = Array.from(
    new Set(
      products
        .map((product) => product.supplier?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const [
    orderItemSums,
    suppliers,
    purchaseCostRows,
    latestPurchaseRows,
    snapshots,
    suggestions,
    openPurchases,
    openOrderItems,
  ] = await Promise.all([
    prisma.orderItem.groupBy({
      by: ["productId"],
      where: {
        productId: { in: productIds },
        createdAt: { gte: since },
        order: { status: { not: "CANCELLED" } },
      },
      _sum: { quantity: true },
    }),
    prisma.supplier.findMany({
      where: supplierNames.length > 0 ? { name: { in: supplierNames } } : undefined,
      select: { name: true, leadTimeDays: true },
    }),
    prisma.$queryRaw<
      Array<{
        productId: string;
        weightedCostTotal: Prisma.Decimal | number | string | null;
        totalQty: bigint | number | string | null;
      }>
    >(Prisma.sql`
      SELECT
        "productId",
        SUM(("quantity" * "unitCost"))::numeric AS "weightedCostTotal",
        SUM("quantity")::bigint AS "totalQty"
      FROM "Purchase"
      WHERE "status" = 'RECEIVED'
        AND "deletedAt" IS NULL
        AND "productId" IN (${Prisma.join(productIds)})
        AND "quantity" > 0
        AND "unitCost" > 0
      GROUP BY "productId"
    `),
    prisma.$queryRaw<
      Array<{
        productId: string;
        unitCost: Prisma.Decimal | number | string | null;
        createdAt: Date;
        supplier: string | null;
        note: string | null;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON ("productId")
        "productId",
        "unitCost",
        "createdAt",
        "supplier",
        "note"
      FROM "Purchase"
      WHERE "status" = 'RECEIVED'
        AND "deletedAt" IS NULL
        AND "productId" IN (${Prisma.join(productIds)})
        AND "quantity" > 0
        AND "unitCost" > 0
      ORDER BY "productId", "createdAt" DESC, "id" DESC
    `),
    prisma.demandSnapshot.findMany({
      where: { productId: { in: productIds } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.restockSuggestion.findMany({
      where: { status: "open", productId: { in: productIds } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.purchase.findMany({
      where: {
        productId: { in: productIds },
        deletedAt: null,
        status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
      },
      select: {
        productId: true,
        quantity: true,
        orderedQuantity: true,
        receivedQuantity: true,
      },
    }),
    prisma.orderItem.findMany({
      where: {
        productId: { in: productIds },
        order: { status: { not: "CANCELLED" }, deletedAt: null },
      },
      select: {
        productId: true,
        quantity: true,
        deliveredQuantity: true,
        returnedQuantity: true,
      },
    }),
  ]);

  const salesByProduct = new Map<string, number>();
  for (const row of orderItemSums) {
    if (!row.productId) continue;
    salesByProduct.set(row.productId, Number(row._sum.quantity ?? 0));
  }
  const supplierLeadTimeByName = new Map(
    suppliers.map((supplier) => [supplier.name.toLowerCase(), supplier.leadTimeDays]),
  );
  const avgPurchaseCostByProduct = new Map<string, number | null>();
  for (const row of purchaseCostRows) {
    const totalQty = Number(row.totalQty ?? 0);
    const weightedCostTotal = Number(row.weightedCostTotal ?? 0);
    avgPurchaseCostByProduct.set(
      row.productId,
      totalQty > 0 && Number.isFinite(weightedCostTotal)
        ? weightedCostTotal / totalQty
        : null,
    );
  }
  const latestPurchaseByProduct = new Map(
    latestPurchaseRows.map((row) => [
      row.productId,
      {
        unitCost: row.unitCost == null ? null : Number(row.unitCost),
        createdAt: row.createdAt,
        supplier: row.supplier ?? null,
        note: row.note ?? null,
      },
    ]),
  );
  const latestSnapshot = new Map<string, (typeof snapshots)[number]>();
  for (const snap of snapshots) {
    if (!latestSnapshot.has(snap.productId)) {
      latestSnapshot.set(snap.productId, snap);
    }
  }
  const suggestionMap = new Map<string, (typeof suggestions)[number]>();
  for (const suggestion of suggestions) {
    if (!suggestionMap.has(suggestion.productId)) {
      suggestionMap.set(suggestion.productId, suggestion);
    }
  }
  const onOrderMap = new Map<string, number>();
  for (const purchase of openPurchases) {
    const ordered = Number(purchase.orderedQuantity ?? purchase.quantity);
    const received = Number(purchase.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    onOrderMap.set(
      purchase.productId,
      (onOrderMap.get(purchase.productId) ?? 0) + remaining,
    );
  }
  const reservedMap = new Map<string, number>();
  for (const item of openOrderItems) {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    const reserved = Math.max(0, item.quantity - delivered - returned);
    if (reserved <= 0) continue;
    reservedMap.set(
      item.productId,
      (reservedMap.get(item.productId) ?? 0) + reserved,
    );
  }
  const productById = new Map(products.map((product) => [product.id, product]));
  const rows: InventoryRow[] = pageProductIds.flatMap((id) => {
    const p = productById.get(id);
    if (!p) return [];
    const avgPurchaseCost = avgPurchaseCostByProduct.get(p.id) ?? null;
    const last = latestPurchaseByProduct.get(p.id) ?? null;
    const baseCost = Number(p.cost ?? 0);

    let lastPurchaseCost: number | null = null;
    let lastPurchaseDate: string | null = null;
    let lastPurchaseSupplier: string | null = null;
    let lastPurchaseNote: string | null = null;

    if (last) {
      lastPurchaseCost = last.unitCost != null ? Number(last.unitCost) : null;
      lastPurchaseDate = last.createdAt.toISOString();
      lastPurchaseSupplier = last.supplier ?? null;
      lastPurchaseNote = last.note ?? null;
    } else if (baseCost > 0) {
      // Fallback: if there are no valid purchases yet but the product
      // has a positive cost set, surface that as the last unit cost
      lastPurchaseCost = baseCost;
    }

    const soldLast30 = salesByProduct.get(p.id) ?? 0;
    const avgDailySales = soldLast30 > 0 ? soldLast30 / lookbackDays : 0;
    const daysOfStock =
      avgDailySales > 0 ? Number(p.stock || 0) / avgDailySales : null;
    const weeksCover = daysOfStock !== null ? daysOfStock / 7 : null;
    const snapshot = latestSnapshot.get(p.id);
    const avgDailyDemand = snapshot ? Number(snapshot.avgDailyDemand) : 0;
    const primaryLink =
      p.supplierLinks.find((link) => link.isPrimary) ||
      p.supplierLinks.find((link) => link.supplierId === p.supplierId) ||
      p.supplierLinks[0];
    const nameLeadTime =
      p.supplier && supplierLeadTimeByName.get(p.supplier.toLowerCase());
    const supplierLeadTime =
      primaryLink?.leadTimeDays ?? p.supplierRef?.leadTimeDays ?? nameLeadTime;
    const leadTimeMinDaysRaw = p.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDaysRaw = p.supplierRef?.leadTimeMaxDays ?? null;
    const autoLeadTime = Number(supplierLeadTime ?? 14);
    const leadTimeMinDays =
      leadTimeMinDaysRaw == null ? null : Number(leadTimeMinDaysRaw);
    const leadTimeMaxDays =
      leadTimeMaxDaysRaw == null ? null : Number(leadTimeMaxDaysRaw);
    const variabilityDays =
      leadTimeMinDays != null && leadTimeMaxDays != null
        ? Math.max(0, (leadTimeMaxDays - leadTimeMinDays) / 2)
        : 0;
    const fallbackReorderPoint = defaultReorderPoint;
    const autoSafetyStock =
      avgDailyDemand > 0
        ? Math.ceil(
            avgDailyDemand * autoLeadTime * 0.5 +
              avgDailyDemand * variabilityDays,
          )
        : 0;
    const autoReorderPoint =
      avgDailyDemand > 0
        ? Math.ceil(avgDailyDemand * autoLeadTime) + autoSafetyStock
        : fallbackReorderPoint;
    const autoPackSize =
      primaryLink?.packSize ?? p.supplierRef?.defaultPackSize ?? 1;
    const onOrder = onOrderMap.get(p.id) ?? 0;
    const reserved = reservedMap.get(p.id) ?? 0;
    const available = p.stock - reserved + onOrder;
    const effectiveReorderPoint =
      avgDailyDemand <= 0 && p.inventoryPlan?.fallbackReorderPoint != null
        ? p.inventoryPlan.fallbackReorderPoint
        : (p.inventoryPlan?.reorderPoint ?? autoReorderPoint);
    const suggestion = suggestionMap.get(p.id);
    const suggestedQty =
      suggestion?.suggestedQty != null
        ? Number(suggestion.suggestedQty)
        : roundUpToStep(
            Math.max(0, effectiveReorderPoint - available),
            Math.max(1, autoPackSize),
          );

    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      requiresLotTracking: Boolean(p.requiresLotTracking),
      requiresExpiryDate: Boolean(p.requiresExpiryDate),
      price: Number(p.price),
      cost: baseCost,
      stock: p.stock,
      totalValue: Number(p.price) * p.stock,
      lastPurchaseCost,
      lastPurchaseDate,
      lastPurchaseSupplier,
      lastPurchaseNote,
      avgPurchaseCost,
      soldLast30,
      avgDailySales,
      daysOfStock,
      weeksCover,
      reorderPoint: effectiveReorderPoint,
      suggestedReorder: suggestedQty > 0 ? suggestedQty : null,
    };
  });

  return Response.json({
    rows,
    totalCount,
    matchingCount,
    page,
    pageSize: includeAll ? matchingCount || requestedPageSize : requestedPageSize,
    totalPages,
    filteredTotals,
  });
}
