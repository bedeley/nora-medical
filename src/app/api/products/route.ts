import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";
import { formatSku, normalizeSkuPrefix, parseSkuNumber } from "@/lib/sku";
import { PRODUCT_CATEGORIES } from "@/lib/product-categories";
import { postPurchaseEntry, postSupplierPaymentEntry } from "@/lib/accounting-posting";
import { ensureInventoryLot } from "@/lib/inventory-lots";
import { getMarginGuardError } from "@/lib/margin-guard";

const PURCHASE_APPROVAL_QTY_THRESHOLD = Number(process.env.PURCHASE_APPROVAL_QTY_THRESHOLD || 0);
const SUPPLIER_PAYMENT_APPROVAL_THRESHOLD = Number(
  process.env.SUPPLIER_PAYMENT_APPROVAL_THRESHOLD || 0,
);

/**
 * ✅ Zod schema for new product creation
 */
// Accept absolute URLs (https://...) or a site-relative path that starts with '/'
const urlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return typeof val === "string" && val.startsWith("/");
      }
    },
    {
      message:
        "Provide a full URL like https://example.com/image.jpg or a site path starting with /images/...",
    }
  );

const categorySchema = z.preprocess(
  (val) => (val == null ? "" : String(val)),
  z
    .string()
    .min(1, { message: "You must select a category." })
    .refine(
      (value) => PRODUCT_CATEGORIES.includes(value as (typeof PRODUCT_CATEGORIES)[number]),
      { message: "Please select a valid category." }
    )
);

export const productSchema = z.object({
  name: z.string().min(2, { message: "Name is required" }),
  description: z.string().min(5, { message: "Description is too short" }),
  imageUrl: urlOrPath,
  category: categorySchema,
  brand: z.string().min(2, { message: "Brand is required" }),
  supplier: z.string().min(2, { message: "Supplier is required" }).optional(),
  supplierId: z.string().optional().nullable(),
  marginOverrideReason: z.string().min(5).optional(),
  minMarginPct: z
    .preprocess(
      (val) => {
        if (val == null || val === "") return null;
        const num = Number(val);
        return Number.isFinite(num) ? num : val;
      },
      z.number().min(0).max(100).nullable().optional()
    )
    .optional(),
  price: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => !isNaN(v), { message: "Price must be a number" })
    .refine((v) => v >= 0, { message: "Price cannot be negative" }),
  // Initial cost at creation, used as starting average cost (required and must be > 0)
  cost: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => !isNaN(v), { message: "Cost must be a number" })
    .refine((v) => v > 0, { message: "Cost must be greater than 0" }),
  stock: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v), { message: "Stock must be an integer" })
    .refine((v) => v >= 0, { message: "Stock cannot be negative" }),
  receiveNow: z.boolean().optional(),
  paidOnReceipt: z.boolean().optional(),
  paymentMethod: z.enum(["cash", "transfer", "bank", "credit"]).optional(),
  lotCode: z.string().optional(),
  expiryDate: z.string().optional(),
  requiresLotTracking: z.boolean().optional(),
  requiresExpiryDate: z.boolean().optional(),
})
  .refine(
    (data) => Boolean(data.supplierId) || Boolean(data.supplier && data.supplier.trim()),
    { message: "Supplier is required", path: ["supplier"] }
  )
  .refine(
    (data) => !data.requiresExpiryDate || data.requiresLotTracking,
    { message: "Expiry date tracking requires lot tracking.", path: ["requiresExpiryDate"] }
  );

type ProductRow = Awaited<ReturnType<typeof prisma.product.findFirst>> & {
  createdAt: Date;
  updatedAt: Date;
  _count?: { orderItems?: number };
  brand?: string | null;
  supplier?: string | null;
  inventoryPlan?: { approvalThresholdQty?: number | null } | null;
  requiresLotTracking?: boolean | null;
  requiresExpiryDate?: boolean | null;
};

type ProductsOverviewStats = {
  filteredTotal: number;
  outOfStockCount: number;
  lowStockCount: number;
  archivedCount: number;
  supplierCount: number;
  marginRiskCount: number | null;
};

async function computeSellableStockByProductIds(productIds: string[]) {
  if (!productIds.length) return new Map<string, number>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rows = await prisma.inventoryLot.findMany({
    where: {
      productId: { in: productIds },
      quantityRemaining: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: today } }],
    },
    select: { productId: true, quantityRemaining: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(
      row.productId,
      Number(map.get(row.productId) || 0) + Number(row.quantityRemaining || 0),
    );
  }
  return map;
}

function serializeProduct(
  p: ProductRow,
  includePrivate: boolean,
  sellableStockById?: Map<string, number>,
) {
  const base = {
    id: p.id,
    sku: p.sku ?? null,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    category: p.category ?? null,
    brand: p.brand ?? null,
    supplier: (p as { supplier?: string | null }).supplier ?? null,
    supplierId: (p as { supplierId?: string | null }).supplierId ?? null,
    requiresLotTracking: Boolean((p as { requiresLotTracking?: boolean | null }).requiresLotTracking),
    requiresExpiryDate: Boolean((p as { requiresExpiryDate?: boolean | null }).requiresExpiryDate),
    approvalThresholdQty: p.inventoryPlan?.approvalThresholdQty ?? null,
    price: Number(p.price),
    stock: p.stock,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
  if (!includePrivate) return base;
  return {
    ...base,
    cost: Number(p.cost),
    minMarginPct: p.minMarginPct != null ? Number(p.minMarginPct) : null,
    stock: p.stock,
    sellableStock:
      sellableStockById && (p.requiresLotTracking || p.requiresExpiryDate)
        ? Math.min(
            Math.max(0, Math.floor(Number(p.stock || 0))),
            Math.max(0, Math.floor(Number(sellableStockById.get(p.id) || 0))),
          )
        : null,
    archived: p.archived,
    orderCount: p._count?.orderItems ?? 0,
  };
}

/**
 * ✅ GET /api/products
 * Supports ?q=searchTerm, ?page, ?pageSize
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const includePrivate = ["ADMIN", "STAFF", "ACCOUNTANT"].includes(String(role || ""));

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") || "";
  const page = Number(searchParams.get("page") || 1);
  const pageSizeRaw = Number(searchParams.get("pageSize") || 12);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(Math.floor(pageSizeRaw), 1), 100)
    : 12;
  const ALLOWED_SORT_FIELDS = ["createdAt", "updatedAt", "price", "stock", "name"] as const;
  type SortField = typeof ALLOWED_SORT_FIELDS[number];
  const sortRaw = searchParams.get("sort") || "updatedAt";
  const sort: SortField = (ALLOWED_SORT_FIELDS as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortField)
    : "updatedAt";
  const sortDirRaw = (searchParams.get("sortDir") || "desc").toLowerCase();
  const sortDir = sortDirRaw === "asc" ? "asc" : "desc";
  const rawCategory = (searchParams.get("category") || "").toLowerCase();
  const category = PRODUCT_CATEGORIES.includes(rawCategory as (typeof PRODUCT_CATEGORIES)[number])
    ? rawCategory
    : "";
  const supplierIdParam = String(searchParams.get("supplierId") || "").trim();
  const supplierParam = String(searchParams.get("supplier") || "").trim();
  const includeSellableStock = searchParams.get("includeSellableStock") === "1";
  const includeStats = searchParams.get("includeStats") === "1";
  const includeDeleted = searchParams.get("includeDeleted") === "1";

  try {
    const idsParam = searchParams.get("ids");
    if (idsParam) {
      const ids = idsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ids.length) {
        return NextResponse.json({
          items: [],
          total: 0,
          page: 1,
          pageSize: 0,
        });
      }
      const items = await prisma.product.findMany({
        where: {
          id: { in: ids },
          ...(includeDeleted ? {} : { deletedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        include: includePrivate
          ? {
              _count: { select: { orderItems: true } },
              inventoryPlan: { select: { approvalThresholdQty: true } },
            }
          : undefined,
      });
      const sellableStockById =
        includePrivate && includeSellableStock
          ? await computeSellableStockByProductIds(items.map((p) => p.id))
          : undefined;
      const safeItems = items.map((p: typeof items[number]) =>
        serializeProduct(p, includePrivate, sellableStockById)
      );
      return NextResponse.json({
        items: safeItems,
        total: safeItems.length,
        page: 1,
        pageSize: safeItems.length,
      });
    }

  const includeArchived = searchParams.get("includeArchived") === "1";
  const startsWith = searchParams.get("startsWith") === "1";
  const stockFilter = (searchParams.get("stockFilter") || "").toLowerCase();
    const nameFilter =
      q && startsWith
        ? { name: { startsWith: q, mode: "insensitive" as const } }
        : q
        ? { name: { contains: q, mode: "insensitive" as const } }
        : null;
    const skuFilter =
      q && startsWith
        ? { sku: { startsWith: q, mode: "insensitive" as const } }
        : q
        ? { sku: { contains: q, mode: "insensitive" as const } }
        : null;

    const where = {
      AND: [
        nameFilter
          ? {
              OR: [
                nameFilter,
                ...(skuFilter ? [skuFilter] : []),
                ...(startsWith
                  ? []
                  : [{ description: { contains: q, mode: "insensitive" as const } }]),
              ],
            }
          : {},
        includeArchived ? {} : { archived: false },
        includeDeleted ? {} : { deletedAt: null },
        stockFilter === "out"
          ? { stock: { lte: 0 } }
          : stockFilter === "low"
          ? { stock: { lte: 5, gt: 0 } }
          : {},
        supplierIdParam
          ? { supplierId: supplierIdParam }
          : supplierParam
          ? { supplier: { contains: supplierParam, mode: "insensitive" as const } }
          : {},
        category ? { category } : {},
      ],
    } satisfies NonNullable<Parameters<typeof prisma.product.findMany>[0]>["where"];

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        // Allow sorting by updatedAt (for admin) or createdAt (default)
        orderBy: { [sort]: sortDir },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: includePrivate
          ? {
              _count: { select: { orderItems: true } },
              inventoryPlan: { select: { approvalThresholdQty: true } },
            }
          : undefined,
      }),
      prisma.product.count({ where }),
    ]);
    const stats = includeStats
      ? await computeProductsOverviewStats({ where, includePrivate, filteredTotal: total })
      : null;
    const sellableStockById =
      includePrivate && includeSellableStock
        ? await computeSellableStockByProductIds(items.map((p) => p.id))
        : undefined;

    // ✅ Normalize Prisma Decimal/Date
    const safeItems = items.map((p: typeof items[number]) =>
      serializeProduct(p, includePrivate, sellableStockById)
    );

    return NextResponse.json({
      items: safeItems,
      total,
      page,
      pageSize,
      stats,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}

async function computeProductsOverviewStats({
  where,
  includePrivate,
  filteredTotal,
}: {
  where: Prisma.ProductWhereInput;
  includePrivate: boolean;
  filteredTotal: number;
}): Promise<ProductsOverviewStats> {
  const [outOfStockCount, lowStockCount, archivedCount, supplierRows, marginRows] =
    await Promise.all([
      prisma.product.count({
        where: {
          AND: [where, { stock: { lte: 0 } }],
        },
      }),
      prisma.product.count({
        where: {
          AND: [where, { stock: { gt: 0, lte: 5 } }],
        },
      }),
      prisma.product.count({
        where: {
          AND: [where, { archived: true }],
        },
      }),
      prisma.product.findMany({
        where,
        select: { supplier: true },
        distinct: ["supplier"],
      }),
      includePrivate
        ? prisma.product.findMany({
            where,
            select: { price: true, cost: true, minMarginPct: true },
          })
        : Promise.resolve([]),
    ]);

  const supplierCount = supplierRows.filter((row) => String(row.supplier || "").trim()).length;
  const marginRiskCount = includePrivate
    ? marginRows.filter((row) => {
        const price = Number(row.price || 0);
        const cost = Number(row.cost || 0);
        const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
        const minMargin = row.minMarginPct != null ? Number(row.minMarginPct) : null;
        return price > 0 && (price < cost || (minMargin != null && marginPct < minMargin));
      }).length
    : null;

  return {
    filteredTotal,
    outOfStockCount,
    lowStockCount,
    archivedCount,
    supplierCount,
    marginRiskCount,
  };
}

/**
 * ✅ POST /api/products
 * Create a new product (admin only)
 */
export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(request, "admin-product-create", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = productSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const marginError = getMarginGuardError({
      price: Number(parsed.data.price),
      cost: Number(parsed.data.cost),
      minMarginPct: parsed.data.minMarginPct,
    });
    if (marginError) {
      const reason = parsed.data.marginOverrideReason?.trim();
      if (!reason || reason.length < 5) {
        return NextResponse.json({ error: marginError }, { status: 400 });
      }
    }

    let supplierName = parsed.data.supplier?.trim() || "";
    let supplierId: string | null = parsed.data.supplierId || null;
    let supplierDefaults: { leadTimeDays: number | null; defaultMinOrderQty: number | null; defaultPackSize: number | null } | null = null;
    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({
        where: { id: supplierId },
        select: { name: true, leadTimeDays: true, defaultMinOrderQty: true, defaultPackSize: true },
      });
      if (supplier?.name) {
        supplierName = supplier.name;
        supplierDefaults = {
          leadTimeDays: supplier.leadTimeDays ?? null,
          defaultMinOrderQty: supplier.defaultMinOrderQty ?? null,
          defaultPackSize: supplier.defaultPackSize ?? null,
        };
      } else {
        supplierId = null;
      }
    }
    if (!supplierId && supplierName) {
      const supplier = await prisma.supplier.upsert({
        where: { name: supplierName },
        create: { name: supplierName },
        update: {},
        select: { id: true, leadTimeDays: true, defaultMinOrderQty: true, defaultPackSize: true },
      });
      supplierId = supplier.id;
      supplierDefaults = {
        leadTimeDays: supplier.leadTimeDays ?? null,
        defaultMinOrderQty: supplier.defaultMinOrderQty ?? null,
        defaultPackSize: supplier.defaultPackSize ?? null,
      };
    }
    if (supplierName.trim().toLowerCase() === "unknown") {
      return NextResponse.json({ error: "Please enter a real supplier." }, { status: 400 });
    }

    const receiveNow = parsed.data.receiveNow !== false;
    const paidOnReceipt = receiveNow ? parsed.data.paidOnReceipt !== false : false;
    const rawPaymentMethod = String(parsed.data.paymentMethod || "").toLowerCase();
    const paymentMethod =
      rawPaymentMethod && ["cash", "transfer", "bank", "credit"].includes(rawPaymentMethod)
        ? rawPaymentMethod
        : "";
    if (paidOnReceipt && !["cash", "transfer", "bank"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Select payment mode when paying now." }, { status: 400 });
    }
    const explicitCreditMode = paymentMethod === "credit";
    const initialQty = Number(parsed.data.stock || 0);
    const requiresPurchaseApproval =
      Number.isFinite(PURCHASE_APPROVAL_QTY_THRESHOLD) &&
      PURCHASE_APPROVAL_QTY_THRESHOLD > 0 &&
      initialQty >= PURCHASE_APPROVAL_QTY_THRESHOLD;
    const effectiveReceiveNow = receiveNow && !requiresPurchaseApproval;
    const highValueCreditOnly =
      Number.isFinite(SUPPLIER_PAYMENT_APPROVAL_THRESHOLD) &&
      SUPPLIER_PAYMENT_APPROVAL_THRESHOLD > 0 &&
      Number(parsed.data.cost || 0) * initialQty >= SUPPLIER_PAYMENT_APPROVAL_THRESHOLD;
    const effectivePaidOnReceipt =
      effectiveReceiveNow && paidOnReceipt && !highValueCreditOnly && !explicitCreditMode;
    const lotCode = parsed.data.lotCode?.trim() || null;
    const expiryDate = parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null;
    const requiresExpiryDate = Boolean(parsed.data.requiresExpiryDate);
    const requiresLotTracking = Boolean(parsed.data.requiresLotTracking) || requiresExpiryDate;
    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 });
    }
    if (effectiveReceiveNow && initialQty > 0) {
      if (requiresLotTracking && !lotCode) {
        return NextResponse.json({ error: "Lot/Batch code is required for regulated products." }, { status: 400 });
      }
      if (requiresExpiryDate && !expiryDate) {
        return NextResponse.json({ error: "Expiry date is required for regulated products." }, { status: 400 });
      }
    }
    let purchaseSupplierName = supplierName;
    let purchaseSupplierId = supplierId;
    if (!purchaseSupplierId && !purchaseSupplierName) {
      const systemName = effectiveReceiveNow ? "Initial Stock" : "Initial Order";
      const systemSupplier = await prisma.supplier.upsert({
        where: { name: systemName },
        update: {},
        create: { name: systemName, status: "ACTIVE" },
        select: { id: true, name: true },
      });
      purchaseSupplierName = systemSupplier.name;
      purchaseSupplierId = systemSupplier.id;
    }

    const initialStock = effectiveReceiveNow ? Number(parsed.data.stock || 0) : 0;
    const product = await prisma.product.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        imageUrl: parsed.data.imageUrl,
        category: parsed.data.category,
        brand: parsed.data.brand,
        supplier: supplierName,
        supplierId,
        requiresLotTracking,
        requiresExpiryDate,
        minMarginPct: parsed.data.minMarginPct ?? null,
        price: parsed.data.price,
        cost: parsed.data.cost,
        stock: initialStock,
        lastStockoutAt: initialStock <= 0 ? new Date() : null,
      },
    });

    const prefix = normalizeSkuPrefix(product.name, 3);
    const existingSkus = await prisma.product.findMany({
      where: { sku: { startsWith: `${prefix}-`, mode: "insensitive" } },
      select: { sku: true },
    });
    const maxSuffix = existingSkus.reduce((max, row) => {
      const parsed = parseSkuNumber(prefix, row.sku);
      if (parsed == null) return max;
      return Math.max(max, parsed);
    }, 0);

    let productWithSku = product;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nextSku = formatSku(prefix, maxSuffix + 1 + attempt, 3);
      try {
        productWithSku = await prisma.product.update({
          where: { id: product.id },
          data: { sku: nextSku },
        });
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
      }
    }

    // Create primary supplier link for planning defaults.
    if (supplierId) {
      try {
        await prisma.productSupplier.upsert({
          where: { productId_supplierId: { productId: product.id, supplierId } },
          create: {
            productId: product.id,
            supplierId,
            isPrimary: true,
            leadTimeDays: supplierDefaults?.leadTimeDays ?? undefined,
            minOrderQty: supplierDefaults?.defaultMinOrderQty ?? undefined,
            packSize: supplierDefaults?.defaultPackSize ?? undefined,
          },
          update: { isPrimary: true },
        });
      } catch (e) {
        console.warn("Failed to link product supplier", product.id, e);
      }
    }

    let initialPurchaseSummary:
      | { id: string; status: "PENDING_APPROVAL" | "ORDERED" | "RECEIVED"; quantity: number }
      | null = null;
    let initialPurchaseJournalEntryId: string | null = null;
    let initialSupplierPaymentJournalEntryId: string | null = null;
    const initialStockBefore = 0;
    const initialStockAfter = effectiveReceiveNow ? Number(initialQty || 0) : 0;

    // If an initial stock and cost are provided, record a baseline purchase and inventory movement
    try {
      const unitCost = Number(parsed.data.cost || 0);
      if (initialQty > 0 && unitCost >= 0) {
        if (effectiveReceiveNow) {
          const purchase = await prisma.purchase.create({
            data: {
              productId: product.id,
              quantity: initialQty,
              orderedQuantity: initialQty,
              receivedQuantity: initialQty,
              status: "RECEIVED",
              unitCost: unitCost,
              supplier: purchaseSupplierName || "Initial Stock",
              supplierId: purchaseSupplierId,
              note: "Auto-created with product",
            },
          });
          initialPurchaseSummary = {
            id: purchase.id,
            status: "RECEIVED",
            quantity: Number(initialQty),
          };
          const lot = await ensureInventoryLot(prisma, {
            productId: product.id,
            purchaseId: purchase.id,
            supplierId: purchaseSupplierId,
            lotCode,
            expiryDate,
            quantity: initialQty,
            notes: "Initial stock",
          });
          await prisma.inventoryMovement.create({
            data: {
              productId: product.id,
              delta: initialQty,
              reason: "PURCHASE",
              purchaseId: purchase.id,
              lotId: lot.id,
              note: "Initial stock",
            },
          });
          try {
            const purchaseEntry = await postPurchaseEntry({
              purchaseId: purchase.id,
              amount: Number(purchase.unitCost) * Number(purchase.quantity || 0),
              createdAt: purchase.createdAt,
              memo: purchaseSupplierName || "Inventory purchase",
            });
            initialPurchaseJournalEntryId = purchaseEntry?.id ?? null;
          } catch (e) {
            console.warn("Accounting purchase posting skipped:", e);
          }
          if (effectivePaidOnReceipt) {
            const paymentAmount = Number(purchase.unitCost) * Number(purchase.quantity || 0);
            const supplierPayment = await prisma.supplierPayment.create({
              data: {
                supplierId: purchaseSupplierId,
                purchaseId: purchase.id,
                amount: paymentAmount,
                method: paymentMethod,
                reference: "PRODUCT_CREATE",
                note: "Paid on receipt",
                status: "NORMAL",
                paidAt: new Date(),
              },
            });
            try {
              if (supplierPayment.status === "NORMAL") {
                const paymentEntry = await postSupplierPaymentEntry({
                  supplierPaymentId: supplierPayment.id,
                });
                initialSupplierPaymentJournalEntryId = paymentEntry?.id ?? null;
              }
            } catch (e) {
              console.warn("Accounting supplier payment posting skipped:", e);
            }
          }
        } else {
          const purchase = await prisma.purchase.create({
            data: {
              productId: product.id,
              quantity: initialQty,
              orderedQuantity: initialQty,
              receivedQuantity: 0,
              status: requiresPurchaseApproval ? "PENDING_APPROVAL" : "ORDERED",
              unitCost: unitCost,
              supplier: purchaseSupplierName || "Initial Order",
              supplierId: purchaseSupplierId,
              note: requiresPurchaseApproval
                ? "Auto-created with product (pending approval)"
                : "Auto-created with product (ordered)",
            },
          });
          initialPurchaseSummary = {
            id: purchase.id,
            status: requiresPurchaseApproval ? "PENDING_APPROVAL" : "ORDERED",
            quantity: Number(initialQty),
          };
        }
      }
    } catch (e) {
      // Non-blocking; product already created
      console.warn("Failed to create initial purchase for product", product.id, e);
    }

    const safeProduct = {
      ...productWithSku,
      price: Number(productWithSku.price),
      createdAt: productWithSku.createdAt.toISOString(),
      updatedAt: productWithSku.updatedAt.toISOString(),
    };

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "PRODUCT_CREATE",
        entityType: "PRODUCT",
        entityId: product.id,
        request,
        meta: {
          name: product.name,
          sku: productWithSku.sku,
          category: parsed.data.category,
          brand: parsed.data.brand,
          supplier: supplierName,
          supplierId,
          price: Number(product.price),
          cost: Number(product.cost),
          stock: product.stock,
          requestedInitialQty: initialQty,
          receiveNow,
          effectiveReceiveNow,
          paidOnReceipt,
          effectivePaidOnReceipt,
          paymentMethod: paymentMethod || null,
          highValueCreditOnly,
          requiresPurchaseApproval,
          approvalThresholdQty: PURCHASE_APPROVAL_QTY_THRESHOLD > 0 ? PURCHASE_APPROVAL_QTY_THRESHOLD : null,
          initialPurchase: initialPurchaseSummary,
          stockBefore: initialStockBefore,
          stockAfter: initialStockAfter,
          purchaseJournalEntryId: initialPurchaseJournalEntryId,
          paymentJournalEntryId: initialSupplierPaymentJournalEntryId,
        },
      });
      if (initialPurchaseSummary) {
        await recordAuditLog({
          actorId: user?.id,
          action: "PURCHASE_CREATE",
          entityType: "PURCHASE",
          entityId: initialPurchaseSummary.id,
          request,
          meta: {
            name: product.name,
            productId: product.id,
            quantity: initialPurchaseSummary.quantity,
            unitCost: Number(parsed.data.cost || 0),
            amount: Number(parsed.data.cost || 0) * Number(initialPurchaseSummary.quantity || 0),
            stockBefore: initialStockBefore,
            stockAfter: initialStockAfter,
            status: initialPurchaseSummary.status,
            supplier: purchaseSupplierName || null,
            supplierId: purchaseSupplierId || null,
            reason: "PRODUCT_CREATE",
            note:
              initialPurchaseSummary.status === "PENDING_APPROVAL"
                ? "Auto-created with product (pending approval)"
                : initialPurchaseSummary.status === "ORDERED"
                ? "Auto-created with product (ordered)"
                : "Auto-created with product",
            receiveNow,
            effectiveReceiveNow,
            paidOnReceipt,
            effectivePaidOnReceipt,
            paymentMethod: paymentMethod || null,
            highValueCreditOnly,
            requiresApproval: requiresPurchaseApproval,
            approvalThresholdQty: PURCHASE_APPROVAL_QTY_THRESHOLD > 0 ? PURCHASE_APPROVAL_QTY_THRESHOLD : null,
            source: "PRODUCT_CREATE",
            purchaseJournalEntryId: initialPurchaseJournalEntryId,
            paymentJournalEntryId: initialSupplierPaymentJournalEntryId,
          },
        });
      }
      const reason = parsed.data.marginOverrideReason?.trim();
      if (marginError && reason) {
        await recordAuditLog({
          actorId: user?.id,
          action: "PRICE_MARGIN_OVERRIDE",
          entityType: "PRODUCT",
          entityId: product.id,
          request,
          meta: {
            name: product.name,
            sku: productWithSku.sku,
            reason,
            price: Number(product.price),
            cost: Number(product.cost),
            minMarginPct: parsed.data.minMarginPct ?? null,
          },
        });
      }
    } catch {
      // best-effort
    }

    return NextResponse.json({
      ...safeProduct,
      initialPurchase: initialPurchaseSummary,
    });
  } catch (error) {
    console.error("Error creating product:", error);
    return NextResponse.json(
      { error: "Failed to create product" },
      { status: 500 }
    );
  }
}
