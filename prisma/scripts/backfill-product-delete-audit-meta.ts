import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Meta = Record<string, unknown>;

function parseMeta(raw: string | null): Meta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    // ignore
  }
  return {};
}

async function main() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "PRODUCT_DELETE", entityType: "PRODUCT" },
    select: { id: true, entityId: true, meta: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);

    const product = await prisma.product.findUnique({
      where: { id: row.entityId },
      select: {
        id: true,
        sku: true,
        category: true,
        brand: true,
        supplier: true,
        supplierId: true,
        cost: true,
        archived: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const orderHistoryCount = await prisma.orderItem.count({ where: { productId: row.entityId } });

    const next: Meta = {
      ...prev,
      sku: prev.sku ?? product?.sku ?? null,
      category: prev.category ?? product?.category ?? null,
      brand: prev.brand ?? product?.brand ?? null,
      supplier: prev.supplier ?? product?.supplier ?? null,
      supplierId: prev.supplierId ?? product?.supplierId ?? null,
      cost: prev.cost ?? (product?.cost != null ? Number(product.cost) : null),
      archivedBeforeDelete:
        prev.archivedBeforeDelete ?? (product?.archived != null ? Boolean(product.archived) : null),
      orderHistoryCount: prev.orderHistoryCount ?? orderHistoryCount,
      productCreatedAt: prev.productCreatedAt ?? product?.createdAt?.toISOString() ?? null,
      productUpdatedAt: prev.productUpdatedAt ?? product?.updatedAt?.toISOString() ?? null,
      deletedAt: prev.deletedAt ?? row.createdAt.toISOString(),
      backfillVersion: 1,
      backfilledAt: new Date().toISOString(),
    };

    const prevText = JSON.stringify(prev);
    const nextText = JSON.stringify(next);
    if (prevText !== nextText) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { meta: nextText } });
      updated += 1;
    }
  }

  console.log(`PRODUCT_DELETE audit meta backfill complete. Updated: ${updated}/${rows.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
