import { prisma } from "@/lib/prisma";

async function main() {
  const existingWalkIn = await prisma.order.findMany({
    where: { customerType: "WALK_IN" },
    select: { id: true },
  });
  const alreadyWalkIn = new Set(existingWalkIn.map((o) => o.id));

  const needsWalkIn = await prisma.order.findMany({
    where: { userId: null, deletedAt: null },
    select: { id: true, walkInName: true },
  });

  let updated = 0;
  for (const order of needsWalkIn) {
    if (alreadyWalkIn.has(order.id)) continue;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        customerType: "WALK_IN",
        walkInName: order.walkInName?.trim() || "Walk-in Customer",
      },
    });
    updated += 1;
  }

  console.log(`Backfilled ${updated} walk-in orders.`);
}

main()
  .catch((err) => {
    console.error("Backfill walk-in orders failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
