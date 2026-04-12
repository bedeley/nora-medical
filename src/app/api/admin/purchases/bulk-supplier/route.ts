import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
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

    const requestedRows = await prisma.purchase.findMany({
      where: {
        id: { in: purchaseIds },
        deletedAt: null,
      },
      select: {
        id: true,
        productId: true,
        quantity: true,
        orderedQuantity: true,
        receivedQuantity: true,
        status: true,
        supplierId: true,
        supplier: true,
        product: {
          select: {
            name: true,
            sku: true,
          },
        },
      },
    });

    const supplier = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, name: true },
    });
    if (!supplier) {
      return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const eligibleRows = requestedRows.filter(
      (row) => !row.supplierId || !String(row.supplier || "").trim(),
    );
    const updatedPurchaseIds = eligibleRows.map((row) => row.id);
    const skippedPurchaseIds = requestedRows
      .filter((row) => !updatedPurchaseIds.includes(row.id))
      .map((row) => row.id);

    const result = await prisma.purchase.updateMany({
      where: {
        id: { in: updatedPurchaseIds },
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
          correlationId: randomUUID(),
          supplierId: supplier.id,
          supplierName: supplier.name,
          requestedCount: purchaseIds.length,
          matchedCount: requestedRows.length,
          eligibleCount: eligibleRows.length,
          updatedCount: result.count,
          purchaseIds,
          updatedPurchaseIds,
          skippedPurchaseIds,
          purchasesPreview: eligibleRows.slice(0, 25).map((row) => ({
            id: row.id,
            productId: row.productId,
            productName: row.product?.name || null,
            productSku: row.product?.sku || null,
            quantity: Number(row.orderedQuantity ?? row.quantity ?? 0),
            receivedQuantity: Number(row.receivedQuantity ?? 0),
            status: row.status,
            previousSupplierId: row.supplierId || null,
            previousSupplierName: row.supplier || null,
          })),
          source: "PURCHASE_BULK_SUPPLIER_ASSIGN",
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
