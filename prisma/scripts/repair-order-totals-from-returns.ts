import { prisma } from "@/lib/prisma";

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { status: { not: "CANCELLED" } },
    include: {
      items: true,
    },
  });

  let updated = 0;

  for (const order of orders) {
    const hasReturns = order.items.some((item) => Number(item.returnedQuantity || 0) > 0);
    if (!hasReturns) continue;

    const expectedSubtotal = round(
      order.items.reduce((sum, item) => {
        const qty = Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0));
        const price = Number(item.price || 0);
        return sum + qty * price;
      }, 0),
    );

    const taxRate = Number(order.taxRate || 0);
    const previousSubtotal = Number(order.subtotal || 0);
    const previousTax = Number(order.taxAmount || 0);
    const expectedTax =
      taxRate > 0
        ? round((expectedSubtotal * taxRate) / 100)
        : previousSubtotal > 0
        ? round((previousTax * expectedSubtotal) / previousSubtotal)
        : 0;

    const expectedTotal = round(expectedSubtotal + expectedTax);

    const totalChanged =
      round(Number(order.subtotal || 0)) !== expectedSubtotal ||
      round(Number(order.taxAmount || 0)) !== expectedTax ||
      round(Number(order.total || 0)) !== expectedTotal;

    if (!totalChanged) continue;

    const amountPaid = round(Number(order.amountPaid || 0));
    const newBalance = Math.max(0, round(expectedTotal - amountPaid));
    const newStatus = newBalance <= 0 ? "PAID" : amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

    await prisma.order.update({
      where: { id: order.id },
      data: {
        subtotal: expectedSubtotal,
        taxAmount: expectedTax,
        total: expectedTotal,
        balance: newBalance,
        status: newStatus,
      },
    });

    updated += 1;
  }

  console.log(`Return total repair complete. Updated ${updated} order(s).`);
}

main()
  .catch((err) => {
    console.error("Return total repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
