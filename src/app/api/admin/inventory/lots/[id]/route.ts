import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: rawId } = await params;
  const id = String(rawId || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing lot id" }, { status: 400 });
  }

  try {
    const lot = await prisma.inventoryLot.findUnique({
      where: { id },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            requiresLotTracking: true,
            requiresExpiryDate: true,
          },
        },
        supplier: { select: { id: true, name: true } },
        purchase: {
          select: {
            id: true,
            createdAt: true,
            status: true,
            orderedQuantity: true,
            receivedQuantity: true,
            unitCost: true,
            supplier: true,
            supplierId: true,
          },
        },
      },
    });
    if (!lot) {
      return NextResponse.json({ error: "Lot not found" }, { status: 404 });
    }

    const MOVEMENT_LIMIT = 200;

    const [movementTotal, movements] = await Promise.all([
      prisma.inventoryMovement.count({ where: { lotId: id } }),
      prisma.inventoryMovement.findMany({
        where: { lotId: id },
        select: {
          id: true,
          reason: true,
          reasonCode: true,
          delta: true,
          note: true,
          purchaseId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
        take: MOVEMENT_LIMIT,
      }),
    ]);

    await recordAuditLog({
      actorId: user?.id || null,
      request: req,
      action: "INVENTORY_LOT_TRACE_VIEWED",
      entityType: "INVENTORY_LOT",
      entityId: lot.id,
      outcome: "SUCCESS",
      meta: {
        sourcePage: "admin/inventory-lots",
        section: "trace",
        operation: "view",
        resultSummary: `Viewed lot trace for ${lot.lotCode}.`,
        lotCode: lot.lotCode,
        productId: lot.productId,
        productName: lot.product?.name || null,
        productSku: lot.product?.sku || null,
        movementTotal,
        movementsReturned: movements.length,
        movementsTruncated: movementTotal > MOVEMENT_LIMIT,
      },
    });

    return NextResponse.json({
      movementTotal,
      movementsTruncated: movementTotal > MOVEMENT_LIMIT,
      lot: {
        id: lot.id,
        lotCode: lot.lotCode,
        expiryDate: lot.expiryDate,
        receivedAt: lot.receivedAt,
        quantityReceived: lot.quantityReceived,
        quantityRemaining: lot.quantityRemaining,
        notes: lot.notes || null,
        supplier: lot.supplier
          ? { id: lot.supplier.id, name: lot.supplier.name }
          : null,
        product: lot.product
          ? {
              id: lot.product.id,
              name: lot.product.name,
              sku: lot.product.sku,
              requiresLotTracking: lot.product.requiresLotTracking,
              requiresExpiryDate: lot.product.requiresExpiryDate,
            }
          : null,
        purchase: lot.purchase
          ? {
              id: lot.purchase.id,
              createdAt: lot.purchase.createdAt,
              status: lot.purchase.status,
              orderedQuantity: Number(lot.purchase.orderedQuantity ?? 0),
              receivedQuantity: Number(lot.purchase.receivedQuantity ?? 0),
              unitCost: Number(lot.purchase.unitCost ?? 0),
              supplier: lot.purchase.supplier || null,
              supplierId: lot.purchase.supplierId || null,
            }
          : null,
      },
      movements: movements.map((row) => ({
        id: row.id,
        reason: row.reason,
        reasonCode: row.reasonCode || null,
        delta: Number(row.delta || 0),
        note: row.note || null,
        purchaseId: row.purchaseId || null,
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    console.error("Inventory lot trace fetch error:", error);
    return NextResponse.json({ error: "Failed to load lot trace" }, { status: 500 });
  }
}
