import { prisma } from "@/lib/prisma";

async function main() {
  const customers = await prisma.user.findMany({
    where: { role: "CUSTOMER" },
    select: { id: true },
  });

  if (customers.length === 0) {
    console.log("No customers found. Skipping balance backfill.");
    return;
  }

  const customerIds = customers.map((customer) => customer.id);
  const orderSums = await prisma.order.groupBy({
    by: ["userId"],
    where: {
      userId: { in: customerIds },
      status: { not: "CANCELLED" },
    },
    _sum: { total: true, amountPaid: true },
  });

  const sumsByUser = new Map(
    orderSums
      .filter((row) => row.userId)
      .map((row) => [
        row.userId as string,
        {
          totalDue: Number(row._sum.total ?? 0),
          totalPaid: Number(row._sum.amountPaid ?? 0),
        },
      ]),
  );

  let updated = 0;
  for (const customerId of customerIds) {
    const totals = sumsByUser.get(customerId) || { totalDue: 0, totalPaid: 0 };
    const balance = Math.max(0, totals.totalDue - totals.totalPaid);

    await prisma.balance.upsert({
      where: { userId: customerId },
      update: {
        totalDue: totals.totalDue,
        totalPaid: totals.totalPaid,
        balance,
      },
      create: {
        userId: customerId,
        totalDue: totals.totalDue,
        totalPaid: totals.totalPaid,
        balance,
      },
    });
    updated += 1;
  }

  console.log(`Balance backfill complete. Updated ${updated} customers.`);
}

main()
  .catch((err) => {
    console.error("Backfill balances error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
