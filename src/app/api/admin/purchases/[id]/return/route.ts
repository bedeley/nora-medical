import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { allocateLotsForSale, applyLotAdjustment } from "@/lib/inventory-lots";
import { postSupplierReturnEntry } from "@/lib/accounting-posting";
import { hasPermission } from "@/lib/permissions";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!session || !canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-return", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;

  try {
    const body = await req.json().catch(() => ({}));
    const qty = Math.floor(Number(body.quantity));
    const lotCode = typeof body.lotCode === "string" ? body.lotCode.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "Invalid return quantity." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const purchase = await tx.purchase.findUnique({
        where: { id },
        select: {
          id: true,
          productId: true,
          unitCost: true,
          status: true,
          quantity: true,
          orderedQuantity: true,
          receivedQuantity: true,
          supplierId: true,
          supplier: true,
          product: {
            select: {
              name: true,
              sku: true,
              stock: true,
              requiresLotTracking: true,
              requiresExpiryDate: true,
            },
          },
        },
      });
      if (!purchase) {
        throw new Error("Purchase not found.");
      }

      const receivedQty = Number(purchase.receivedQuantity ?? 0);
      if (receivedQty <= 0) {
        throw new Error("This purchase has no received items to return.");
      }
      if (qty > receivedQty) {
        throw new Error("Return quantity exceeds received quantity.");
      }

      const currentStock = Number(purchase.product?.stock ?? 0);
      if (currentStock < qty) {
        throw new Error("Insufficient on-hand stock to return.");
      }

      const nextReceived = Math.max(0, receivedQty - qty);
      const orderedQty = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
      const nextStatus =
        nextReceived <= 0
          ? "CANCELLED"
          : orderedQty > 0 && nextReceived < orderedQty
          ? "PARTIALLY_RECEIVED"
          : "RECEIVED";

      await tx.purchase.update({
        where: { id: purchase.id },
        data: {
          receivedQuantity: nextReceived,
          status: nextStatus,
        },
      });

      await tx.product.update({
        where: { id: purchase.productId },
        data: { stock: currentStock - qty },
      });

      if (lotCode) {
        await applyLotAdjustment(tx, {
          productId: purchase.productId,
          delta: -qty,
          lotCode,
          reason: "SUPPLIER_RETURN",
          reasonCode: "SUPPLIER_RETURN",
          note: note || null,
        });
      } else {
        await allocateLotsForSale(tx, {
          productId: purchase.productId,
          quantity: qty,
          reason: "SUPPLIER_RETURN",
          note: note || null,
        });
      }

      const creditAmount = Number(purchase.unitCost || 0) * Number(qty);
      const credit = await tx.supplierPayment.create({
        data: {
          supplierId: purchase.supplierId,
          purchaseId: purchase.id,
          amount: creditAmount,
          method: "credit_memo",
          reference: "SUPPLIER_RETURN",
          note: note || "Supplier return credit",
          status: "NORMAL",
          paidAt: new Date(),
        },
      });

      return {
        purchaseId: purchase.id,
        productId: purchase.productId,
        productName: purchase.product?.name ?? "",
        productSku: purchase.product?.sku ?? "",
        unitCost: Number(purchase.unitCost || 0),
        nextStatus,
        supplier: purchase.supplier || null,
        supplierId: purchase.supplierId || null,
        creditId: credit.id,
        creditAmount,
      };
    });

    try {
      await recordAuditLog({
        actorId: user?.id ?? null,
        action: "PURCHASE_RETURN_TO_SUPPLIER",
        entityType: "PURCHASE",
        entityId: result.purchaseId,
        meta: {
          productId: result.productId,
          productName: result.productName,
          productSku: result.productSku,
          quantity: qty,
          supplierId: result.supplierId,
          supplierName: result.supplier,
          note: note || null,
          status: result.nextStatus,
          supplierPaymentId: result.creditId,
          supplierCreditAmount: result.creditAmount,
        },
      });
    } catch {
      // best-effort
    }

    try {
      const amount = Number(result.unitCost || 0) * Number(qty);
      if (amount > 0) {
        await postSupplierReturnEntry({
          purchaseId: result.purchaseId,
          amount,
          createdAt: new Date(),
          memo: result.supplier ? `Supplier return - ${result.supplier}` : undefined,
        });
      }
    } catch (e) {
      console.warn("Accounting supplier return posting skipped:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to return purchase.";
    console.error("Purchase return error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
