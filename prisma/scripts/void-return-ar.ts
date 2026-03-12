import { prisma } from "@/lib/prisma";

async function main() {
  const idOrInvoice = process.argv[2];
  if (!idOrInvoice) {
    console.error("Usage: pnpm tsx prisma/scripts/void-return-ar.ts <order-id-or-invoice>");
    process.exit(1);
  }

  const order = await prisma.order.findFirst({
    where: {
      OR: [
        { id: idOrInvoice },
        { invoiceNumber: { equals: idOrInvoice, mode: "insensitive" } },
      ],
    },
    select: { id: true, invoiceNumber: true },
  });
  if (!order) {
    console.error("Order not found");
    process.exit(1);
  }

  const updated = await prisma.journalEntry.updateMany({
    where: {
      sourceType: "ORDER",
      sourceId: order.id,
      status: "POSTED",
      memo: { contains: "Return/refund" },
    },
    data: { status: "VOID" },
  });

  console.log(
    `Voided ${updated.count} return/refund journal entries for order ${order.invoiceNumber || order.id}.`,
  );
  console.log("Re-run pnpm db:diagnose-ar-mismatch to confirm AR is balanced.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
