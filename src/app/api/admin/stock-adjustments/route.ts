import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { applyLotAdjustment } from "@/lib/inventory-lots";
import { hasPermission } from "@/lib/permissions";

const adjustmentSchema = z.object({
  productId: z.string().min(1),
  countedStock: z.number().int().min(0),
  reasonType: z.enum(["CYCLE_COUNT", "STOCK_ADJUSTMENT"]),
  reasonCode: z.enum(["COUNT_VARIANCE", "DAMAGE", "EXPIRED", "SHRINKAGE", "THEFT", "OTHER"]),
  note: z.string().min(1).max(200),
  lotCode: z.string().optional(),
  expiryDate: z.string().optional(),
});

const DEFAULT_ACCOUNT_CODES = {
  INVENTORY: "1200",
  COGS: "5000",
};

const DEFAULT_ACCOUNTS_BY_CODE: Record<
  string,
  { name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }
> = {
  "1200": { name: "Inventory", type: "ASSET" },
  "5000": { name: "Cost of Goods Sold", type: "EXPENSE" },
};

async function getAccountCodes() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  return {
    ...DEFAULT_ACCOUNT_CODES,
    ...(value as Record<string, string> | null),
  };
}

async function resolveAccounts(codes: string[]) {
  const rows = await prisma.ledgerAccount.findMany({
    where: { code: { in: codes } },
  });
  const map = new Map(rows.map((r) => [r.code, r.id]));
  if (map.size !== codes.length) {
    const missing = codes.filter((c) => !map.has(c));
    for (const code of missing) {
      const template = DEFAULT_ACCOUNTS_BY_CODE[code];
      if (!template) continue;
      await prisma.ledgerAccount.upsert({
        where: { code },
        update: { name: template.name, type: template.type, isActive: true },
        create: { code, name: template.name, type: template.type },
      });
    }
    const refreshed = await prisma.ledgerAccount.findMany({
      where: { code: { in: codes } },
    });
    return new Map(refreshed.map((r) => [r.code, r.id]));
  }
  return map;
}

function isAuthorized(user?: AuthenticatedUser | null) {
  return hasPermission(user?.role, "inventory.adjust");
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const productId = searchParams.get("productId");
    const type = searchParams.get("type");
    const rawPage = parseInt(searchParams.get("page") || "1", 10);
    const rawPageSize = parseInt(searchParams.get("pageSize") || "25", 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const pageSize = Number.isFinite(rawPageSize) ? Math.min(100, Math.max(10, rawPageSize)) : 25;

    const normalizedType = typeof type === "string" ? type.toUpperCase() : "";
    const reasonFilter =
      normalizedType === "CYCLE_COUNT" || normalizedType === "STOCK_ADJUSTMENT"
        ? normalizedType
        : null;
    const restrictToAdjustments = !normalizedType || normalizedType === "ADJUSTMENTS";

    const where: Prisma.InventoryMovementWhereInput = {
      ...(reasonFilter
        ? { reason: reasonFilter }
        : restrictToAdjustments
        ? { reason: { in: ["CYCLE_COUNT", "STOCK_ADJUSTMENT"] } }
        : {}),
    };
    if (productId) where.productId = productId;
    if (start || end) {
      where.createdAt = {};
      // Parse as UTC boundaries so behaviour is timezone-independent
      if (start) where.createdAt.gte = new Date(start + "T00:00:00.000Z");
      if (end) where.createdAt.lte = new Date(end + "T23:59:59.999Z");
    }

    const [total, rows] = await Promise.all([
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.findMany({
        where,
        include: {
          product: { select: { name: true, sku: true, cost: true } },
          lot: { select: { lotCode: true, expiryDate: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items = rows.map((row) => {
      // Use the unitCost stored at adjustment time when available;
      // fall back to current product cost for legacy records.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const storedUnitCost = (row as any).unitCost != null ? Number((row as any).unitCost) : null;
      const unitCost = storedUnitCost ?? Number(row.product?.cost || 0);
      const valueDelta = Number((Number(row.delta) * unitCost).toFixed(2));
      return {
        id: row.id,
        productId: row.productId,
        productName: row.product?.name || "",
        productSku: row.product?.sku || null,
        delta: row.delta,
        reason: row.reason,
        reasonCode: row.reasonCode ?? null,
        note: row.note || null,
        lotCode: row.lot?.lotCode || null,
        expiryDate: row.lot?.expiryDate || null,
        unitCost,
        valueDelta,
        createdAt: row.createdAt,
      };
    });

    return NextResponse.json({ items, total, page, pageSize });
  } catch (error) {
    console.error("Stock adjustments fetch error:", error);
    return NextResponse.json({ error: "Failed to load stock adjustments" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "admin-stock-adjust", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = adjustmentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const entryDate = new Date();
    const expiryDate = parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null;
    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date." }, { status: 400 });
    }
    const closedPeriod = await findClosedPeriod(entryDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }

    // Pre-read product for lot/expiry validation only — not for stock value.
    // The authoritative stock read happens inside the transaction to prevent race conditions.
    const productMeta = await prisma.product.findUnique({
      where: { id: parsed.data.productId },
      select: { id: true, name: true, sku: true, cost: true, requiresLotTracking: true, requiresExpiryDate: true },
    });
    if (!productMeta) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (productMeta.requiresLotTracking && !(parsed.data.lotCode && parsed.data.lotCode.trim())) {
      return NextResponse.json({ error: "Lot/Batch code is required for this product." }, { status: 400 });
    }
    if (productMeta.requiresExpiryDate && !parsed.data.expiryDate) {
      return NextResponse.json({ error: "Expiry date is required for this product." }, { status: 400 });
    }

    const countedStock = parsed.data.countedStock;
    const unitCost = Number(productMeta.cost || 0);

    const accountCodes = await getAccountCodes();
    const inventoryCode = accountCodes.INVENTORY;
    const cogsCode = accountCodes.COGS;
    const accountMap = await resolveAccounts([inventoryCode, cogsCode]);
    if (!accountMap.get(inventoryCode) || !accountMap.get(cogsCode)) {
      return NextResponse.json({ error: "Missing ledger accounts for inventory adjustment." }, { status: 400 });
    }

    const memo = `Inventory adjustment - ${productMeta.name}`;
    const lineDesc = `${productMeta.name}${productMeta.sku ? ` (${productMeta.sku})` : ""}`;

    // Run stock update inside the transaction so the live stock read and the
    // update are atomic — prevents two concurrent adjustments from each
    // computing delta against the same stale stock value.
    type TxResult = { noop: true } | { delta: number; valueDelta: number };
    const result = await prisma.$transaction(async (tx): Promise<TxResult> => {
      const liveProduct = await tx.product.findUnique({
        where: { id: productMeta.id },
        select: { stock: true },
      });
      if (!liveProduct) throw new Error("Product not found during adjustment.");
      const currentStock = Number(liveProduct.stock ?? 0);
      const delta = countedStock - currentStock;

      if (delta === 0) return { noop: true };

      const valueDelta = Number((delta * unitCost).toFixed(2));
      const amount = Math.abs(valueDelta);

      await tx.product.update({
        where: { id: productMeta.id },
        data: {
          stock: countedStock,
          ...(currentStock > 0 && countedStock <= 0 ? { lastStockoutAt: new Date() } : {}),
        },
      });

      await applyLotAdjustment(tx, {
        productId: productMeta.id,
        delta,
        reason: parsed.data.reasonType,
        reasonCode: parsed.data.reasonCode,
        note: parsed.data.note.trim() || null,
        lotCode: parsed.data.lotCode,
        expiryDate,
        unitCost,
      });

      if (amount > 0.01) {
        const lines =
          valueDelta > 0
            ? [
                { accountId: accountMap.get(inventoryCode) as string, debit: amount, credit: 0, description: lineDesc },
                { accountId: accountMap.get(cogsCode) as string, debit: 0, credit: amount, description: lineDesc },
              ]
            : [
                { accountId: accountMap.get(cogsCode) as string, debit: amount, credit: 0, description: lineDesc },
                { accountId: accountMap.get(inventoryCode) as string, debit: 0, credit: amount, description: lineDesc },
              ];

        await tx.journalEntry.create({
          data: {
            entryDate,
            memo,
            sourceType: "MANUAL",
            sourceId: null,
            status: "POSTED",
            approvedById: (session.user as AuthenticatedUser).id,
            approvedAt: new Date(),
            lines: { create: lines },
          },
        });
      }

      return { delta, valueDelta };
    });

    if ((result as { noop?: true }).noop) {
      return NextResponse.json({ ok: true, delta: 0, valueDelta: 0, message: "No stock change required." });
    }

    const { delta, valueDelta } = result as { delta: number; valueDelta: number };

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "STOCK_ADJUSTMENT",
        entityType: "PRODUCT",
        entityId: productMeta.id,
        request: req,
        meta: {
          sourcePage: "admin/stock-adjustments",
          section: "new-adjustment",
          operation: "save_stock_adjustment",
          productName: productMeta.name,
          productSku: productMeta.sku || null,
          previousStock: countedStock - delta,
          newStock: countedStock,
          countedStock,
          delta,
          unitCost,
          valueDelta,
          reason: parsed.data.reasonType,
          reasonCode: parsed.data.reasonCode,
          note: parsed.data.note.trim() || null,
          lotCode: parsed.data.lotCode?.trim() || null,
          expiryDate: parsed.data.expiryDate || null,
          journalPosted: Math.abs(valueDelta) > 0.01,
          resultSummary:
            delta === 0
              ? "No stock change required."
              : `Adjusted stock by ${delta > 0 ? `+${delta}` : delta} for ${productMeta.name}.`,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, delta, valueDelta });
  } catch (error) {
    console.error("Stock adjustment error:", error);
    return NextResponse.json({ error: "Failed to post stock adjustment" }, { status: 500 });
  }
}
