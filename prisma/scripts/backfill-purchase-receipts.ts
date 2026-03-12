import { prisma } from "@/lib/prisma";

async function main() {
  const purchases = await prisma.purchase.findMany({
    where: {
      OR: [
        { orderedQuantity: null },
        { status: "RECEIVED", receivedQuantity: { lt: 1 } },
      ],
    },
    select: { id: true, quantity: true, status: true, orderedQuantity: true, receivedQuantity: true },
  });
  let updated = 0;
  for (const p of purchases) {
    const orderedQuantity = p.orderedQuantity ?? p.quantity;
    const shouldReceive =
      p.status === "RECEIVED" || (p.receivedQuantity != null && p.receivedQuantity > 0);
    const receivedQuantity = shouldReceive ? p.quantity : 0;
    await prisma.purchase.update({
      where: { id: p.id },
      data: {
        orderedQuantity,
        receivedQuantity,
      },
    });
    updated += 1;
  }
  console.log(`Backfilled ${updated} purchases.`);
}

main()
  .catch((err) => {
    console.error("Backfill purchases failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
