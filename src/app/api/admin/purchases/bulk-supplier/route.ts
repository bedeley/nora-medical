import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { hasPermission } from "@/lib/permissions";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!session || !canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-bulk-supplier", 60_000, 30);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      purchaseIds?: string[];
      supplierId?: string;
    };
    const purchaseIds = Array.isArray(body.purchaseIds)
      ? body.purchaseIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const supplierId = String(body.supplierId || "").trim();
    if (!purchaseIds.length) {
      return NextResponse.json({ error: "Select at least one purchase." }, { status: 400 });
    }
    if (!supplierId) {
      return NextResponse.json({ error: "Supplier is required." }, { status: 400 });
    }

    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, name: true },
    });
    if (!supplier) {
      return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const result = await prisma.purchase.updateMany({
      where: {
        id: { in: purchaseIds },
        deletedAt: null,
        OR: [{ supplierId: null }, { supplier: null }, { supplier: "" }],
      },
      data: {
        supplierId: supplier.id,
        supplier: supplier.name,
      },
    });

    try {
      await recordAuditLog({
        actorId: user?.id ?? null,
        action: "PURCHASE_BULK_SUPPLIER_ASSIGN",
        entityType: "PURCHASE",
        entityId: "BULK",
        meta: {
          supplierId: supplier.id,
          supplierName: supplier.name,
          requestedCount: purchaseIds.length,
          updatedCount: result.count,
          purchaseIds,
        },
      });
    } catch {
      // best effort
    }

    return NextResponse.json({ ok: true, updatedCount: result.count });
  } catch (error) {
    console.error("Bulk supplier assign error:", error);
    return NextResponse.json({ error: "Failed to update supplier." }, { status: 500 });
  }
}

