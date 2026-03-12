import { prisma } from "@/lib/prisma";

const ACCOUNT_CODES = {
  AR: "1100",
  CASH: "1000",
  STORE_CREDIT: "2200",
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function resolveAccountId(code: string) {
  const account = await prisma.ledgerAccount.findUnique({
    where: { code },
    select: { id: true },
  });
  return account?.id ?? null;
}

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.log("Usage: pnpm db:repair-order-ar-alignment <orderId>");
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, balance: true, customerType: true },
  });
  if (!order) {
    console.log("Order not found.");
    return;
  }

  const arAccountId = await resolveAccountId(ACCOUNT_CODES.AR);
  const cashAccountId = await resolveAccountId(ACCOUNT_CODES.CASH);
  const creditAccountId = await resolveAccountId(ACCOUNT_CODES.STORE_CREDIT);
  if (!arAccountId || !cashAccountId || !creditAccountId) {
    throw new Error("Missing ledger accounts for AR/Cash/Store Credit.");
  }

  const payments = await prisma.payment.findMany({
    where: { orderId, deletedAt: null },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);

  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      OR: [
        { sourceType: "ORDER", sourceId: orderId },
        paymentIds.length
          ? { sourceType: "PAYMENT", sourceId: { in: paymentIds } }
          : { sourceType: "PAYMENT", sourceId: { in: [] } },
        { sourceType: "MANUAL", memo: { contains: orderId } },
      ],
    },
    include: { lines: true },
  });

  let ledgerAr = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.accountId !== arAccountId) continue;
      ledgerAr += Number(line.debit || 0) - Number(line.credit || 0);
    }
  }
  ledgerAr = round(ledgerAr);

  const expected = Math.max(0, round(Number(order.balance || 0)));
  const delta = round(expected - ledgerAr);

  if (Math.abs(delta) <= 0.01) {
    console.log("AR already aligned for order.");
    return;
  }

  const existing = await prisma.journalEntry.findFirst({
    where: {
      status: "POSTED",
      sourceType: "MANUAL",
      memo: `AR alignment (${orderId})`,
    },
    select: { id: true },
  });
  if (existing) {
    console.log("AR alignment entry already exists.");
    return;
  }

  const targetAccountId =
    order.customerType === "WALK_IN" ? cashAccountId : creditAccountId;
  const targetDescription =
    order.customerType === "WALK_IN"
      ? "AR alignment to cash"
      : "AR alignment to store credit";

  await prisma.journalEntry.create({
    data: {
      entryDate: new Date(),
      memo: `AR alignment (${orderId})`,
      sourceType: "MANUAL",
      status: "POSTED",
      lines: {
        create: [
          {
            accountId: arAccountId,
            debit: delta > 0 ? delta : 0,
            credit: delta < 0 ? Math.abs(delta) : 0,
            description: "AR alignment",
          },
          {
            accountId: targetAccountId,
            debit: delta < 0 ? Math.abs(delta) : 0,
            credit: delta > 0 ? delta : 0,
            description: targetDescription,
          },
        ],
      },
    },
  });

  console.log(`AR alignment entry posted for order ${orderId}: ${delta.toFixed(2)}.`);
}

main()
  .catch((err) => {
    console.error("AR alignment repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
