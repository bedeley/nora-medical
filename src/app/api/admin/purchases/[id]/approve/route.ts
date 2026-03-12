import { NextResponse } from "next/server";
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
      await recordAuditLog({
        actorId: user.id,
        action: "PURCHASE_APPROVE",
        entityType: "PURCHASE",
        entityId: updated.id,
        meta: {
          previousStatus: purchase.status,
          status: updated.status,
          productId: purchase.productId,
          quantity: Number(purchase.orderedQuantity ?? purchase.quantity ?? 0),
          unitCost: Number(purchase.unitCost || 0),
          amount:
            Number(purchase.unitCost || 0) *
            Number(purchase.orderedQuantity ?? purchase.quantity ?? 0),
          supplier: purchase.supplier || null,
          supplierId: purchase.supplierId || null,
          approvedById: user.id,
          approvedAt: updated.approvedAt ? updated.approvedAt.toISOString() : null,
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
