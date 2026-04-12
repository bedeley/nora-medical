import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { hasPermission } from "@/lib/permissions";

const CANCELLABLE_STATUSES = new Set(["PENDING_APPROVAL", "APPROVED", "ORDERED"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!session || !canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-cancel", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;

  try {
    const purchase = await prisma.purchase.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        quantity: true,
        orderedQuantity: true,
        receivedQuantity: true,
        supplier: true,
        supplierId: true,
        productId: true,
        unitCost: true,
        expectedAt: true,
        product: {
          select: {
            name: true,
            sku: true,
          },
        },
      },
    });

    if (!purchase) {
      return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
    }

    const currentStatus = String(purchase.status || "").toUpperCase();
    const receivedQuantity = Number(purchase.receivedQuantity ?? 0);
    if (receivedQuantity > 0) {
      return NextResponse.json(
        { error: "Received purchases must be returned instead of cancelled." },
        { status: 400 },
      );
    }
    if (!CANCELLABLE_STATUSES.has(currentStatus)) {
      return NextResponse.json(
        { error: "Only pending approval, approved, or ordered purchases can be cancelled." },
        { status: 400 },
      );
    }

    const updated = await prisma.purchase.update({
      where: { id: purchase.id },
      data: { status: "CANCELLED" },
      select: { id: true, status: true },
    });

    try {
      const correlationId = randomUUID();
      const orderedQuantity = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
      await recordAuditLog({
        actorId: user?.id ?? null,
        action: "PURCHASE_CANCEL",
        entityType: "PURCHASE",
        entityId: updated.id,
        meta: {
          correlationId,
          previousStatus: currentStatus,
          status: updated.status,
          productId: purchase.productId,
          productName: purchase.product?.name || null,
          productSku: purchase.product?.sku || null,
          quantity: orderedQuantity,
          orderedQuantity,
          receivedQuantity,
          remainingQuantity: 0,
          unitCost: Number(purchase.unitCost || 0),
          amount: Number(purchase.unitCost || 0) * orderedQuantity,
          supplier: purchase.supplier || null,
          supplierId: purchase.supplierId || null,
          expectedAt: purchase.expectedAt ? purchase.expectedAt.toISOString() : null,
          cancelledAt: new Date().toISOString(),
          source: "PURCHASE_CANCEL",
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, status: updated.status });
  } catch (error) {
    console.error("Purchase cancel error:", error);
    return NextResponse.json({ error: "Failed to cancel purchase." }, { status: 500 });
  }
}
