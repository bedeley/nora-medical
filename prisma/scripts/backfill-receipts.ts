import { PrismaClient } from "@prisma/client";
import { computeReceiptHash } from "@/lib/receipt-hash";

const prisma = new PrismaClient();

async function main() {
  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { invoiceNumber: null },
        { receiptHash: null },
        { subtotal: 0 },
      ],
    },
    include: { items: true },
  });

  let updatedCount = 0;

  for (const order of orders) {
    const subtotalRaw = Number(order.subtotal ?? 0);
    const subtotal = subtotalRaw > 0 ? subtotalRaw : Number(order.total ?? 0);
    const taxRate = Number(order.taxRate ?? 0);
    const taxAmount = Number(order.taxAmount ?? 0);
    const invoiceNumber = order.invoiceNumber || `INV-${order.id}`;
    const total = Number(order.total ?? subtotal + taxAmount);

    const receiptHash = computeReceiptHash({
      orderId: order.id,
      invoiceNumber,
      subtotal,
      taxRate,
      taxAmount,
      total,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        price: Number(it.price),
      })),
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        invoiceNumber,
        receiptHash,
        subtotal,
        taxRate,
        taxAmount,
      },
    });
    updatedCount += 1;
  }

  console.log(`Backfilled ${updatedCount} order(s).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
