
import { prisma } from "@/lib/prisma";

const LOT_CODE_PREFIX = "LOT";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;
type DbClient = TxClient | typeof prisma;

export const normalizeLotCode = (value?: string | null) =>
  (value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toUpperCase();

const defaultLotCode = (productId: string) =>
  `${LOT_CODE_PREFIX}-${productId.slice(0, 6).toUpperCase()}-${Date.now()}`;

export async function ensureInventoryLot(
  tx: DbClient,
  opts: {
    productId: string;
    purchaseId?: string | null;
    supplierId?: string | null;
    lotCode?: string | null;
    expiryDate?: Date | null;
    quantity: number;
    notes?: string | null;
  }
) {
  const lotCode = normalizeLotCode(opts.lotCode) || defaultLotCode(opts.productId);
  const expiryDate = opts.expiryDate ?? null;
  const quantity = Math.max(0, Math.floor(opts.quantity));

  const existing = await tx.inventoryLot.findUnique({
    where: { productId_lotCode: { productId: opts.productId, lotCode } },
  });

  if (existing) {
    return tx.inventoryLot.update({
      where: { id: existing.id },
      data: {
        quantityReceived: existing.quantityReceived + quantity,
        quantityRemaining: existing.quantityRemaining + quantity,
        expiryDate: existing.expiryDate ?? expiryDate,
        notes: opts.notes?.trim() || existing.notes,
        purchaseId: opts.purchaseId || existing.purchaseId,
        supplierId: opts.supplierId || existing.supplierId,
      },
    });
  }

  return tx.inventoryLot.create({
    data: {
      productId: opts.productId,
      purchaseId: opts.purchaseId ?? null,
      supplierId: opts.supplierId ?? null,
      lotCode,
      expiryDate,
      quantityReceived: quantity,
      quantityRemaining: quantity,
      notes: opts.notes?.trim() || null,
    },
  });
}

export async function allocateLotsForSale(
  tx: DbClient,
  opts: {
    productId: string;
    quantity: number;
    reason: string;
    note?: string | null;
  }
) {
  let remaining = Math.max(0, Math.floor(opts.quantity));
  if (remaining <= 0) return { assigned: 0, unassigned: 0 };

  const product = await tx.product.findUnique({
    where: { id: opts.productId },
    select: { requiresLotTracking: true, requiresExpiryDate: true },
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiringLots = await tx.inventoryLot.findMany({
    where: {
      productId: opts.productId,
      quantityRemaining: { gt: 0 },
      expiryDate: { gte: today },
    },
    select: {
      id: true,
      quantityRemaining: true,
      expiryDate: true,
      receivedAt: true,
    },
    orderBy: [
      { expiryDate: "asc" },
      { receivedAt: "asc" },
    ],
  });

  const nonExpiringLots = await tx.inventoryLot.findMany({
    where: {
      productId: opts.productId,
      quantityRemaining: { gt: 0 },
      expiryDate: null,
    },
    select: {
      id: true,
      quantityRemaining: true,
      expiryDate: true,
      receivedAt: true,
    },
    orderBy: [
      { receivedAt: "asc" },
    ],
  });

  const lots = [...expiringLots, ...nonExpiringLots];
  const availableUnexpired = lots.reduce(
    (sum, lot) => sum + Math.max(0, Number(lot.quantityRemaining || 0)),
    0,
  );

  let assigned = 0;
  const movements: Array<{
    productId: string;
    delta: number;
    reason: string;
    note: string | null;
    lotId?: string;
  }> = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const takeQty = Math.min(remaining, lot.quantityRemaining);
    if (takeQty <= 0) continue;
    remaining -= takeQty;
    assigned += takeQty;
    await tx.inventoryLot.update({
      where: { id: lot.id },
      data: { quantityRemaining: lot.quantityRemaining - takeQty },
    });
    movements.push({
      productId: opts.productId,
      delta: -takeQty,
      reason: opts.reason,
      note: opts.note || null,
      lotId: lot.id,
    });
  }

  if (remaining > 0) {
    if (product?.requiresLotTracking || product?.requiresExpiryDate) {
      const availableText = Number.isFinite(availableUnexpired)
        ? `Only ${availableUnexpired} in stock.`
        : "No stock available.";
      throw new Error(`Not enough stock. ${availableText}`);
    }
    movements.push({
      productId: opts.productId,
      delta: -remaining,
      reason: opts.reason,
      note: opts.note || null,
    });
  }

  if (movements.length > 0) {
    await tx.inventoryMovement.createMany({ data: movements });
  }

  return { assigned, unassigned: remaining };
}

export async function applyLotAdjustment(
  tx: DbClient,
  opts: {
    productId: string;
    delta: number;
    lotCode?: string | null;
    expiryDate?: Date | null;
    reason: string;
    reasonCode?: string | null;
    note?: string | null;
    unitCost?: number | null;
  }
) {
  const lotCode = normalizeLotCode(opts.lotCode);
  const unitCostData = opts.unitCost != null ? { unitCost: opts.unitCost } : {};
  const createInventoryMovement = tx.inventoryMovement.create as unknown as (args: {
    data: Record<string, unknown>;
  }) => Promise<unknown>;

  if (!lotCode) {
    await createInventoryMovement({
      data: {
        productId: opts.productId,
        delta: opts.delta,
        reason: opts.reason,
        reasonCode: opts.reasonCode || null,
        note: opts.note || null,
        ...unitCostData,
      },
    });
    return { lotId: null };
  }

  const existing = await tx.inventoryLot.findUnique({
    where: { productId_lotCode: { productId: opts.productId, lotCode } },
  });

  if (!existing) {
    if (opts.delta < 0) {
      throw new Error("Lot not found for adjustment.");
    }
    const created = await tx.inventoryLot.create({
      data: {
        productId: opts.productId,
        lotCode,
        expiryDate: opts.expiryDate ?? null,
        quantityReceived: Math.abs(opts.delta),
        quantityRemaining: Math.abs(opts.delta),
        notes: opts.note?.trim() || null,
      },
    });
    await createInventoryMovement({
      data: {
        productId: opts.productId,
        delta: opts.delta,
        reason: opts.reason,
        reasonCode: opts.reasonCode || null,
        note: opts.note || null,
        lotId: created.id,
        ...unitCostData,
      },
    });
    return { lotId: created.id };
  }

  const nextRemaining = existing.quantityRemaining + opts.delta;
  if (nextRemaining < 0) {
    throw new Error("Adjustment exceeds lot remaining quantity.");
  }

  await tx.inventoryLot.update({
    where: { id: existing.id },
    data: {
      quantityRemaining: nextRemaining,
      expiryDate: existing.expiryDate ?? opts.expiryDate ?? null,
      notes: opts.note?.trim() || existing.notes,
    },
  });

  await createInventoryMovement({
    data: {
      productId: opts.productId,
      delta: opts.delta,
      reason: opts.reason,
      reasonCode: opts.reasonCode || null,
      note: opts.note || null,
      lotId: existing.id,
      ...unitCostData,
    },
  });

  return { lotId: existing.id };
}
