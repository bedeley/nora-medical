import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-expected-date", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({} as { expectedAt?: string | null }));
    const rawExpectedAt = typeof body.expectedAt === "string" ? body.expectedAt.trim() : "";
    const expectedAt = rawExpectedAt ? new Date(rawExpectedAt) : null;
    if (expectedAt && Number.isNaN(expectedAt.getTime())) {
      return NextResponse.json({ error: "Invalid expected date." }, { status: 400 });
    }

    const purchase = await prisma.purchase.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        expectedAt: true,
        productId: true,
        quantity: true,
        orderedQuantity: true,
        supplier: true,
      },
    });
    if (!purchase) return NextResponse.json({ error: "Purchase not found." }, { status: 404 });

    const updated = await prisma.purchase.update({
      where: { id },
      data: { expectedAt },
      select: { id: true, expectedAt: true },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "PURCHASE_EXPECTED_DATE_UPDATE",
        entityType: "PURCHASE",
        entityId: purchase.id,
        meta: {
          purchaseId: purchase.id,
          previousExpectedAt: purchase.expectedAt ? purchase.expectedAt.toISOString() : null,
          expectedAt: updated.expectedAt ? updated.expectedAt.toISOString() : null,
          status: purchase.status,
          productId: purchase.productId,
          quantity: Number(purchase.orderedQuantity ?? purchase.quantity ?? 0),
          supplier: purchase.supplier || null,
          updatedById: user.id,
          updatedAt: new Date().toISOString(),
        },
      });
    } catch {
      // best effort
    }

    return NextResponse.json({ ok: true, expectedAt: updated.expectedAt ? updated.expectedAt.toISOString() : null });
  } catch (error) {
    console.error("Purchase expected-date update error:", error);
    return NextResponse.json({ error: "Failed to update expected date." }, { status: 500 });
  }
}

