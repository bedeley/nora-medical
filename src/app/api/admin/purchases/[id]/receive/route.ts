import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyBackInStock } from "@/lib/stock-alerts";
import { postPurchaseReceiptEntry } from "@/lib/accounting-posting";
import { ensureInventoryLot, normalizeLotCode } from "@/lib/inventory-lots";
import { hasPermission } from "@/lib/permissions";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!session || !canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-receive", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;
  try {
    const body = await req.json();
    const receiveQty = Number(body.quantity);
    const lotCode = typeof body.lotCode === "string" ? body.lotCode : null;
    const expiryDate = body.expiryDate ? new Date(body.expiryDate) : null;
    const lotNotes = typeof body.lotNotes === "string" ? body.lotNotes : null;
    if (!Number.isFinite(receiveQty) || receiveQty <= 0 || !Number.isInteger(receiveQty)) {
      return NextResponse.json({ error: "Invalid receive quantity" }, { status: 400 });
    }
    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const purchase = await tx.purchase.findUnique({
        where: { id },
        select: {
          id: true,
          productId: true,
          quantity: true,
          orderedQuantity: true,
          receivedQuantity: true,
          unitCost: true,
          status: true,
          supplier: true,
          supplierId: true,
          createdAt: true,
          product: { select: { stock: true, cost: true, name: true, requiresLotTracking: true, requiresExpiryDate: true } },
        },
      });
      if (!purchase) throw new Error("Purchase not found");
      if (purchase.status === "CANCELLED") throw new Error("Purchase is cancelled");
      if (purchase.status === "RECEIVED") throw new Error("Purchase already fully received");
      if (purchase.status === "PENDING_APPROVAL") {
        throw new Error("Purchase must be approved before receiving");
      }

      const lotHistory = await tx.inventoryLot.findFirst({
        where: { productId: purchase.productId },
        select: { id: true },
      });
      const expiryHistory = await tx.inventoryLot.findFirst({
        where: { productId: purchase.productId, expiryDate: { not: null } },
        select: { id: true },
      });
      const requiresLotTracking =
        Boolean(purchase.product?.requiresLotTracking) ||
        Boolean(purchase.product?.requiresExpiryDate) ||
        Boolean(lotHistory);
      const requiresExpiryDate = Boolean(purchase.product?.requiresExpiryDate);
      const requiresExpiryByHistory = Boolean(expiryHistory);

      const ordered = Number(purchase.orderedQuantity ?? purchase.quantity);
      const received = Number(purchase.receivedQuantity ?? 0);
      const nextReceived = Math.min(ordered, received + receiveQty);
      const delta = nextReceived - received;
      if (delta <= 0) throw new Error("Nothing to receive");

      if (requiresLotTracking && !(lotCode && lotCode.trim())) {
        throw new Error("Lot/Batch code is required for this product.");
      }
      if ((requiresExpiryDate || requiresExpiryByHistory) && !expiryDate) {
        throw new Error("Expiry date is required for this product.");
      }

      const oldStock = Number(purchase.product?.stock ?? 0);
      const oldCost = Number(purchase.product?.cost ?? 0);
      const previousPurchase = purchase.supplierId
        ? await tx.purchase.findFirst({
            where: {
              productId: purchase.productId,
              supplierId: purchase.supplierId,
              status: { in: ["RECEIVED", "PARTIALLY_RECEIVED"] },
              receivedQuantity: { gt: 0 },
              id: { not: purchase.id },
            },
            orderBy: { createdAt: "desc" },
            select: { unitCost: true, createdAt: true },
          })
        : null;
      const effectiveOldStock = Math.max(0, oldStock);
      const denom = effectiveOldStock + delta;
      const newCost = denom > 0
        ? ((oldCost * effectiveOldStock + Number(purchase.unitCost) * delta) / denom)
        : oldCost;
      const newStock = oldStock + delta;

      const nextStatus = nextReceived >= ordered ? "RECEIVED" : "PARTIALLY_RECEIVED";

      const updatedPurchase = await tx.purchase.update({
        where: { id },
        data: {
          receivedQuantity: nextReceived,
          status: nextStatus,
        },
      });

      await tx.product.update({
        where: { id: purchase.productId },
        data: { stock: newStock, cost: Number(newCost) },
      });

      const lot = await ensureInventoryLot(tx, {
        productId: purchase.productId,
        purchaseId: purchase.id,
        supplierId: purchase.supplierId ?? null,
        lotCode,
        expiryDate,
        quantity: delta,
        notes: lotNotes,
      });

      await tx.inventoryMovement.create({
        data: {
          productId: purchase.productId,
          delta,
          reason: "PURCHASE",
          purchaseId: purchase.id,
          lotId: lot.id,
          note: lotNotes?.trim() || null,
        },
      });

      return {
        purchase: updatedPurchase,
        previousStatus: purchase.status,
        productName: purchase.product?.name || "",
        oldStock,
        newStock,
        newCost: Number(newCost),
        delta,
        ordered,
        previousReceivedQuantity: received,
        nextStatus,
        supplier: purchase.supplier || "",
        lotCode: lot.lotCode,
        supplierId: purchase.supplierId,
        receivedAt: new Date(),
        previousUnitCost: previousPurchase ? Number(previousPurchase.unitCost) : null,
      };
    });

    const correlationId = randomUUID();

    try {
      await recordAuditLog({
        actorId: (user as AuthenticatedUser).id,
        action: "PURCHASE_RECEIVE",
        entityType: "PURCHASE",
        entityId: result.purchase.id,
        meta: {
          correlationId,
          purchaseId: result.purchase.id,
          productId: result.purchase.productId,
          productName: result.productName,
          delta: result.delta,
          orderedQuantity: result.ordered,
          previousReceivedQuantity: Number(result.previousReceivedQuantity || 0),
          receivedQuantity: Number(result.purchase.receivedQuantity || 0),
          remainingQuantity: Math.max(0, Number(result.ordered || 0) - Number(result.purchase.receivedQuantity || 0)),
          unitCost: Number(result.purchase.unitCost || 0),
          amount: Number(result.purchase.unitCost || 0) * Number(result.delta || 0),
          previousStatus: result.previousStatus,
          status: result.nextStatus,
          supplier: result.supplier || null,
          supplierId: result.supplierId || null,
          from: result.oldStock,
          to: result.newStock,
          expiryDate: expiryDate ? expiryDate.toISOString() : null,
          lotCode: normalizeLotCode(result.lotCode) || null,
        },
      });
    } catch {
      // best-effort
    }
    try {
      if (
        typeof result.previousUnitCost === "number" &&
        Number.isFinite(result.previousUnitCost) &&
        Number(result.previousUnitCost) !== Number(result.purchase.unitCost) &&
        result.supplierId
      ) {
        const oldUnitCost = Number(result.previousUnitCost);
        const newUnitCost = Number(result.purchase.unitCost);
        const delta = newUnitCost - oldUnitCost;
        const deltaPct = oldUnitCost > 0 ? (delta / oldUnitCost) * 100 : null;
        const productForAudit = await prisma.product.findUnique({
          where: { id: result.purchase.productId },
          select: { sku: true },
        });
        await recordAuditLog({
          actorId: (user as AuthenticatedUser).id,
          action: "SUPPLIER_PRICE_CHANGE",
          entityType: "SUPPLIER",
          entityId: result.supplierId,
          meta: {
            correlationId,
            supplierId: result.supplierId,
            supplierName: result.supplier || null,
            productId: result.purchase.productId,
            productName: result.productName,
            productSku: productForAudit?.sku || null,
            oldUnitCost,
            newUnitCost,
            delta,
            deltaAmount: delta,
            deltaPct,
            currency: "GHS",
            changeReason: "PURCHASE_RECEIVE",
            effectiveAt: result.receivedAt.toISOString(),
            source: "PURCHASE_RECEIVE",
            purchaseId: result.purchase.id,
          },
        });
      }
    } catch {
      // best-effort
    }

    try {
      if (Number(result.oldStock || 0) <= 0 && Number(result.newStock || 0) > 0) {
        await notifyBackInStock(result.purchase.productId);
      }
    } catch (e) {
      console.warn("Back-in-stock notification error:", e);
    }

    try {
      const receiptKey = String(result.purchase.receivedQuantity || 0);
      await postPurchaseReceiptEntry({
        purchaseId: result.purchase.id,
        receiptKey,
        amount: Number(result.purchase.unitCost) * Number(result.delta || 0),
        createdAt: result.receivedAt,
        memo: result.supplier || "Inventory purchase",
      });
    } catch (e) {
      console.warn("Accounting purchase posting skipped:", e);
      try {
        await recordAuditLog({
          actorId: (user as AuthenticatedUser).id,
          action: "ACCOUNTING_POST_FAILED",
          entityType: "PURCHASE",
          entityId: result.purchase.id,
          meta: {
            reason: "purchase_receive_post_failed",
            message: e instanceof Error ? e.message : String(e),
          },
        });
      } catch {
        // best-effort
      }
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to receive purchase";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
