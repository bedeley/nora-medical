import { prisma } from "@/lib/prisma";
import { ensureInventoryLot } from "@/lib/inventory-lots";

async function main() {
  const product = await prisma.product.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, supplierId: true },
  });

  if (!product) {
    console.log("No product found. Create a product first.");
    return;
  }

  const now = new Date();
  const exp30 = new Date(now);
  exp30.setDate(exp30.getDate() + 30);
  const exp90 = new Date(now);
  exp90.setDate(exp90.getDate() + 90);

  const lotA = await ensureInventoryLot(prisma, {
    productId: product.id,
    supplierId: product.supplierId ?? null,
    lotCode: `LOT-${product.id.slice(0, 6)}-A`,
    expiryDate: exp30,
    quantity: 15,
    notes: "Seeded lot expiring in 30 days",
  });

  const lotB = await ensureInventoryLot(prisma, {
    productId: product.id,
    supplierId: product.supplierId ?? null,
    lotCode: `LOT-${product.id.slice(0, 6)}-B`,
    expiryDate: exp90,
    quantity: 25,
    notes: "Seeded lot expiring in 90 days",
  });

  await prisma.inventoryMovement.createMany({
    data: [
      {
        productId: product.id,
        delta: 15,
        reason: "PURCHASE",
        lotId: lotA.id,
        note: "Seeded lot receipt",
      },
      {
        productId: product.id,
        delta: 25,
        reason: "PURCHASE",
        lotId: lotB.id,
        note: "Seeded lot receipt",
      },
    ],
  });

  console.log(`Seeded 2 lots for ${product.name}.`);
}

main()
  .catch((err) => {
    console.error("Seed inventory lots failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
