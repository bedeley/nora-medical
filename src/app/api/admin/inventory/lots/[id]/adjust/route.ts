import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { applyLotAdjustment } from "@/lib/inventory-lots";
import { recordAuditLog } from "@/lib/audit-log";

type LotAdjustmentAuditPayload = {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  meta?: Record<string, unknown>;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await params;
  const id = String(rawId || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing lot id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const quantityRemaining = Number(body.quantityRemaining);
  const reason = String(body.reason || "").trim();
  const note = String(body.note || "").trim() || null;
  const reasonCode = reason.toUpperCase().replace(/\s+/g, "_");

  if (!Number.isFinite(quantityRemaining) || quantityRemaining < 0) {
    return NextResponse.json({ error: "Invalid quantity" }, { status: 400 });
  }
  if (!Number.isInteger(quantityRemaining)) {
    return NextResponse.json({ error: "Quantity must be a whole number" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "Reason is required" }, { status: 400 });
  }

  const lot = await prisma.inventoryLot.findUnique({
    where: { id },
    select: {
      id: true,
      productId: true,
      lotCode: true,
      expiryDate: true,
      quantityRemaining: true,
    },
  });
  if (!lot) {
    return NextResponse.json({ error: "Lot not found" }, { status: 404 });
  }

  const currentRemaining = Number(lot.quantityRemaining || 0);
  const delta = quantityRemaining - currentRemaining;
  if (delta === 0) {
    return NextResponse.json({
      ok: true,
      message: "No change",
    });
  }

  let auditPayload: LotAdjustmentAuditPayload | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: lot.productId },
        select: { id: true, stock: true, name: true, sku: true },
      });
      if (!product) {
        throw new Error("Product not found for lot adjustment.");
      }

      const currentStock = Number(product.stock || 0);
      const nextStock = currentStock + delta;
      if (nextStock < 0) {
        throw new Error("Adjustment would make product stock negative.");
      }

      await tx.product.update({
        where: { id: product.id },
        data: {
          stock: nextStock,
          ...(currentStock > 0 && nextStock <= 0 ? { lastStockoutAt: new Date() } : {}),
        },
      });

      await applyLotAdjustment(tx, {
        productId: lot.productId,
        delta,
        lotCode: lot.lotCode,
        expiryDate: lot.expiryDate ?? null,
        reason: "STOCK_ADJUSTMENT",
        reasonCode,
        note,
      });

      auditPayload = {
        actorId: (session.user as AuthenticatedUser).id,
        action: "LOT_ADJUSTMENT",
        entityType: "INVENTORY_LOT",
        entityId: lot.id,
        meta: {
          productId: product.id,
          productName: product.name,
          productSku: product.sku,
          lotCode: lot.lotCode,
          fromRemaining: currentRemaining,
          toRemaining: quantityRemaining,
          delta,
          reason: reason,
          reasonCode,
          note,
          stockBefore: currentStock,
          stockAfter: nextStock,
        },
      };
    });
  } catch (error) {
    console.error("Lot adjustment failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to adjust lot" },
      { status: 400 },
    );
  }

  if (auditPayload) {
    const finalizedAuditPayload = auditPayload as LotAdjustmentAuditPayload;
    await recordAuditLog({
      actorId: finalizedAuditPayload.actorId || null,
      action: finalizedAuditPayload.action,
      entityType: finalizedAuditPayload.entityType,
      entityId: finalizedAuditPayload.entityId,
      request: req,
      outcome: "SUCCESS",
      meta: {
        sourcePage: "admin/inventory-lots",
        section: "adjustment",
        operation: "adjust_remaining_quantity",
        resultSummary: `Adjusted lot ${lot.lotCode} by ${delta} units.`,
        ...(finalizedAuditPayload.meta || {}),
      },
    });
  }

  return NextResponse.json({ ok: true });
}
