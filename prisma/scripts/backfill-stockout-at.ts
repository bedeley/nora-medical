import { prisma } from "@/lib/prisma";

async function main() {
  const products = await prisma.product.findMany({
    where: {
      lastStockoutAt: null,
      stock: { lte: 0 },
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  let updated = 0;
  for (const p of products) {
    const lastOutMovement = await prisma.inventoryMovement.findFirst({
      where: {
        productId: p.id,
        delta: { lt: 0 },
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const backfillAt = lastOutMovement?.createdAt ?? p.updatedAt ?? p.createdAt;
    await prisma.product.update({
      where: { id: p.id },
      data: { lastStockoutAt: backfillAt },
    });
    updated += 1;
  }

  console.log(`Stockout backfill complete. Updated: ${updated}.`);
}

main()
  .catch((err) => {
    console.error("Stockout backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
