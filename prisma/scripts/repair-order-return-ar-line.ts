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
    console.log("Usage: pnpm db:repair-order-return-ar-line <orderId>");
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, customerType: true },
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

  const entry = await prisma.journalEntry.findFirst({
    where: {
      status: "POSTED",
      sourceType: "ORDER",
      sourceId: orderId,
      memo: { contains: "Return/refund" },
    },
    include: { lines: { include: { account: true } } },
    orderBy: { entryDate: "desc" },
  });

  if (!entry) {
    console.log("No return entry found for order.");
    return;
  }

  const arCredit = entry.lines
    .filter((line) => line.account.code === ACCOUNT_CODES.AR)
    .reduce((sum, line) => sum + Number(line.credit || 0), 0);
  const cashCredit = entry.lines
    .filter((line) => line.account.code === ACCOUNT_CODES.CASH)
    .reduce((sum, line) => sum + Number(line.credit || 0), 0);
  const storeCredit = entry.lines
    .filter((line) => line.account.code === ACCOUNT_CODES.STORE_CREDIT)
    .reduce((sum, line) => sum + Number(line.credit || 0), 0);

  const delta = round(arCredit - (cashCredit + storeCredit));
  if (!(delta > 0)) {
    console.log("No AR-only return credit to reclass for this order.");
    return;
  }

  const existing = await prisma.journalEntry.findFirst({
    where: {
      status: "POSTED",
      sourceType: "MANUAL",
      memo: `Return/refund AR reclass (${entry.id})`,
    },
    select: { id: true },
  });
  if (existing) {
    console.log("Reclass entry already exists for this return.");
    return;
  }

  const targetAccountId =
    order.customerType === "WALK_IN" ? cashAccountId : creditAccountId;
  const targetDescription =
    order.customerType === "WALK_IN"
      ? "Reclass return to cash refund"
      : "Reclass return to store credit";

  await prisma.journalEntry.create({
    data: {
      entryDate: new Date(),
      memo: `Return/refund AR reclass (${entry.id})`,
      sourceType: "MANUAL",
      status: "POSTED",
      lines: {
        create: [
          {
            accountId: arAccountId,
            debit: delta,
            credit: 0,
            description: "Reclass return AR credit",
          },
          {
            accountId: targetAccountId,
            debit: 0,
            credit: delta,
            description: targetDescription,
          },
        ],
      },
    },
  });

  console.log(`Reclassified ${delta.toFixed(2)} for order ${orderId}.`);
}

main()
  .catch((err) => {
    console.error("Return AR line repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
