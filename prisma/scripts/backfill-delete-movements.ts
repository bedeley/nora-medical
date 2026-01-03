import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const deletedProducts = await prisma.product.findMany({
    where: { deletedAt: { not: null } },
    select: { id: true, name: true, stock: true },
  });

  if (deletedProducts.length === 0) {
    console.log("No deleted products found.");
    return;
  }

  const movementSums = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
    where: { productId: { in: deletedProducts.map((p) => p.id) } },
  });
  const movementMap = new Map(
    movementSums.map((m) => [m.productId, Number(m._sum.delta || 0)]),
  );

  let updated = 0;
  let skipped = 0;

  for (const product of deletedProducts) {
    const movementSum = movementMap.get(product.id) ?? 0;
    const currentStock = Number(product.stock || 0);

    if (movementSum === 0 && currentStock === 0) {
      skipped += 1;
      continue;
    }

    let deltaToZero = -movementSum;
    if (deltaToZero === 0 && currentStock !== 0) {
      deltaToZero = -currentStock;
    }

    await prisma.$transaction(async (tx) => {
      if (deltaToZero !== 0) {
        await tx.inventoryMovement.create({
          data: {
            productId: product.id,
            delta: deltaToZero,
            reason: "DELETE_BACKFILL",
          },
        });
      }
      if (currentStock !== 0) {
        await tx.product.update({
          where: { id: product.id },
          data: { stock: 0 },
        });
      }
      await tx.auditLog.create({
        data: {
          action: "PRODUCT_DELETE_BACKFILL",
          entityType: "PRODUCT",
          entityId: product.id,
          meta: JSON.stringify({
            name: product.name,
            movementSum,
            stockBefore: currentStock,
            delta: deltaToZero,
          }),
        },
      });
    });

    updated += 1;
    console.log(
      `Backfilled ${product.name} (${product.id}): movementSum=${movementSum}, stock=${currentStock}, delta=${deltaToZero}`,
    );
  }

  console.log(`Done. Updated ${updated} product(s). Skipped ${skipped}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
