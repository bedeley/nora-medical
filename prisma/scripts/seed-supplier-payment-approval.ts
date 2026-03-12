import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

async function main() {
  const purchases = await prisma.purchase.findMany({
    where: {
      deletedAt: null,
      supplierId: { not: null },
    },
    select: {
      id: true,
      supplierId: true,
      quantity: true,
      unitCost: true,
      supplier: true,
      supplierRef: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  for (const purchase of purchases) {
    const existingPending = await prisma.supplierPayment.findFirst({
      where: {
        purchaseId: purchase.id,
        status: "PENDING_APPROVAL",
        deletedAt: null,
      },
      select: { id: true },
    });

    if (existingPending) {
      console.log(`Pending payment already exists for purchase ${purchase.id}.`);
      return;
    }

    const totals = await prisma.supplierPayment.aggregate({
      where: {
        purchaseId: purchase.id,
        deletedAt: null,
        status: { not: "VOID" },
      },
      _sum: { amount: true },
    });

    const totalDue = new Prisma.Decimal(purchase.unitCost).mul(purchase.quantity);
    const paid = totals._sum.amount ?? new Prisma.Decimal(0);
    const outstanding = totalDue.minus(paid);

    if (outstanding.lte(0)) {
      continue;
    }

    const amount = Prisma.Decimal.min(outstanding, new Prisma.Decimal(500));
    const supplierLabel = purchase.supplierRef?.name ?? purchase.supplier ?? "supplier";

    await prisma.supplierPayment.create({
      data: {
        supplierId: purchase.supplierId,
        purchaseId: purchase.id,
        amount,
        method: "bank",
        reference: "SEED-PENDING",
        note: `Seed pending approval for ${supplierLabel}`,
        status: "PENDING_APPROVAL",
      },
    });

    console.log(
      `Created pending supplier payment of ${amount.toFixed(2)} for purchase ${purchase.id}.`
    );
    return;
  }

  console.log("No eligible purchase found with outstanding balance.");
}

main()
  .catch((err) => {
    console.error("Seed supplier payment failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
