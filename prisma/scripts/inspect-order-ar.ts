import { prisma } from "@/lib/prisma";

async function main() {
  const idOrInvoice = process.argv[2];
  if (!idOrInvoice) {
    console.error("Usage: pnpm tsx prisma/scripts/inspect-order-ar.ts <order-id-or-invoice>");
    process.exit(1);
  }

  const order = await prisma.order.findFirst({
    where: {
      OR: [
        { id: idOrInvoice },
        { invoiceNumber: { equals: idOrInvoice, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      amountPaid: true,
      status: true,
    },
  });

  if (!order) {
    console.error("Order not found.");
    process.exit(1);
  }

  console.log("Order");
  console.log({
    id: order.id,
    invoice: order.invoiceNumber,
    status: order.status,
    total: Number(order.total || 0),
    amountPaid: Number(order.amountPaid || 0),
  });

  const payments = await prisma.payment.findMany({
    where: { orderId: order.id, deletedAt: null },
    select: {
      id: true,
      amount: true,
      status: true,
      refundDisposition: true,
      note: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log("\nPayments");
  payments.forEach((p) =>
    console.log({
      id: p.id,
      amount: Number(p.amount || 0),
      status: p.status,
      refundDisposition: p.refundDisposition,
      createdAt: p.createdAt,
      note: p.note,
    }),
  );

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) throw new Error("AR account 1100 not found");

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: arAccount.id,
      entry: {
        status: "POSTED",
        OR: [
          { sourceType: "ORDER", sourceId: order.id },
          { sourceType: "PAYMENT", sourceId: { in: payments.map((p) => p.id) } },
        ],
      },
    },
    select: {
      debit: true,
      credit: true,
      entry: { select: { id: true, sourceType: true, sourceId: true, memo: true, entryDate: true } },
    },
    orderBy: [{ entry: { entryDate: "asc" } }],
  });

  console.log("\nAR journal lines (POSTED)");
  let arNet = 0;
  lines.forEach((l) => {
    const debit = Number(l.debit || 0);
    const credit = Number(l.credit || 0);
    arNet += debit - credit;
    console.log({
      entryId: l.entry?.id,
      date: l.entry?.entryDate,
      sourceType: l.entry?.sourceType,
      sourceId: l.entry?.sourceId,
      memo: l.entry?.memo,
      debit,
      credit,
      runningNet: Math.round(arNet * 100) / 100,
    });
  });

  console.log("\nAR net total:", Math.round(arNet * 100) / 100);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
