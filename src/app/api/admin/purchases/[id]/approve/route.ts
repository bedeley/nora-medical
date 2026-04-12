import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-approve", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const requestBody = await req.json().catch(() => ({}));
  const sourcePage =
    String(
      new URL(req.url).searchParams.get("sourcePage") ||
      (requestBody as { sourcePage?: string }).sourcePage ||
      "admin/purchases",
    ).trim() || "admin/purchases";

  const { id } = await params;
  try {
    const purchase = await prisma.purchase.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        supplierId: true,
        supplier: true,
        productId: true,
        orderedQuantity: true,
        quantity: true,
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
    if (!purchase) return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
    if (purchase.status !== "PENDING_APPROVAL") {
      return NextResponse.json({ error: "Purchase is not pending approval." }, { status: 400 });
    }

    const updated = await prisma.purchase.update({
      where: { id },
      data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() },
    });

    try {
      const orderedQuantity = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
      await recordAuditLog({
        actorId: user.id,
        action: "PURCHASE_APPROVE",
        entityType: "PURCHASE",
        entityId: updated.id,
        request: req,
        meta: {
          correlationId: randomUUID(),
          sourcePage,
          section: sourcePage === "admin/supplier-payments" ? "pending-purchase-approvals" : "approvals",
          operation: "approve_purchase",
          previousStatus: purchase.status,
          status: updated.status,
          productId: purchase.productId,
          productName: purchase.product?.name || null,
          productSku: purchase.product?.sku || null,
          quantity: orderedQuantity,
          orderedQuantity,
          unitCost: Number(purchase.unitCost || 0),
          amount: Number(purchase.unitCost || 0) * orderedQuantity,
          supplier: purchase.supplier || null,
          supplierId: purchase.supplierId || null,
          expectedAt: purchase.expectedAt ? purchase.expectedAt.toISOString() : null,
          approvedById: user.id,
          approvedAt: updated.approvedAt ? updated.approvedAt.toISOString() : null,
          source: "PURCHASE_APPROVE",
          resultSummary: `Approved purchase for ${purchase.product?.name || "product"} and moved it into the payable workflow.`,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, status: updated.status });
  } catch (error) {
    console.error("Purchase approve error:", error);
    return NextResponse.json({ error: "Failed to approve purchase" }, { status: 500 });
  }
}
