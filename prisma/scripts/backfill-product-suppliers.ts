import { prisma } from "@/lib/prisma";

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, supplierId: true, supplier: true },
  });

  let linked = 0;
  for (const product of products) {
    let supplierId = product.supplierId;
    if (!supplierId && product.supplier) {
      const supplier = await prisma.supplier.findFirst({
        where: { name: { equals: product.supplier, mode: "insensitive" } },
        select: { id: true },
      });
      supplierId = supplier?.id || null;
    }
    if (!supplierId) continue;
    await prisma.productSupplier.updateMany({
      where: { productId: product.id },
      data: { isPrimary: false },
    });
    await prisma.productSupplier.upsert({
      where: { productId_supplierId: { productId: product.id, supplierId } },
      create: { productId: product.id, supplierId, isPrimary: true },
      update: { isPrimary: true },
    });
    linked += 1;
  }

  console.log(`Linked ${linked} products to primary suppliers.`);
}

main()
  .catch((err) => {
    console.error("Backfill product suppliers failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
