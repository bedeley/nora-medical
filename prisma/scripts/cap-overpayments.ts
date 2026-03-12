import { prisma } from "@/lib/prisma";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";

async function main() {
  const orders = await prisma.order.findMany({
    where: { status: { not: "CANCELLED" } },
    select: { id: true, invoiceNumber: true },
  });

  let updated = 0;
  for (const o of orders) {
    await recomputeOrderTotalsFromPayments(prisma, o.id);
    updated += 1;
  }

  console.log(`Recomputed ${updated} orders and capped overpayments at order total.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
