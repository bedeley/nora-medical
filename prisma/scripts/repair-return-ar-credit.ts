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

function getEntryWindow(entryDate: Date, minutes = 30) {
  const ms = minutes * 60 * 1000;
  return {
    gte: new Date(entryDate.getTime() - ms),
    lte: new Date(entryDate.getTime() + ms),
  };
}

async function main() {
  const arAccountId = await resolveAccountId(ACCOUNT_CODES.AR);
  const cashAccountId = await resolveAccountId(ACCOUNT_CODES.CASH);
  const creditAccountId = await resolveAccountId(ACCOUNT_CODES.STORE_CREDIT);

  if (!arAccountId || !cashAccountId || !creditAccountId) {
    throw new Error("Missing ledger accounts for AR/Cash/Store Credit.");
  }

  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "ORDER",
      memo: { contains: "Return/refund" },
    },
    include: { lines: { include: { account: true } } },
    orderBy: { entryDate: "asc" },
  });

  let corrected = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.sourceId) {
      skipped += 1;
      continue;
    }

    const order = await prisma.order.findUnique({
      where: { id: entry.sourceId },
      select: { id: true, balance: true },
    });
    if (!order) {
      skipped += 1;
      continue;
    }

    const balance = round(Number(order.balance || 0));
    if (balance > 0) {
      skipped += 1;
      continue;
    }

    const arCredit = entry.lines
      .filter((line) => line.account.code === ACCOUNT_CODES.AR)
      .reduce((sum, line) => sum + Number(line.credit || 0), 0);
    if (!(arCredit > 0)) {
      skipped += 1;
      continue;
    }

    const cashCredit = entry.lines
      .filter((line) => line.account.code === ACCOUNT_CODES.CASH)
      .reduce((sum, line) => sum + Number(line.credit || 0), 0);
    const storeCredit = entry.lines
      .filter((line) => line.account.code === ACCOUNT_CODES.STORE_CREDIT)
      .reduce((sum, line) => sum + Number(line.credit || 0), 0);

    const delta = round(arCredit - (cashCredit + storeCredit));
    if (!(delta > 0)) {
      skipped += 1;
      continue;
    }

    const payment = await prisma.payment.findFirst({
      where: {
        orderId: entry.sourceId,
        createdAt: getEntryWindow(entry.entryDate),
        deletedAt: null,
        OR: [
          { status: "REFUND" },
          { refundDisposition: "CREDIT" },
          { amount: { lt: 0 } },
        ],
      },
      select: { status: true, refundDisposition: true, amount: true },
    });

    const useStoreCredit =
      payment?.refundDisposition === "CREDIT" ||
      (payment && Number(payment.amount || 0) >= 0);

    const targetAccountId = useStoreCredit ? creditAccountId : cashAccountId;
    const targetDescription = useStoreCredit
      ? "Reclass return to store credit"
      : "Reclass return to cash refund";

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

    corrected += 1;
  }

  console.log(
    `Return AR reclass complete. Corrected: ${corrected}, Skipped: ${skipped}`,
  );
}

main()
  .catch((err) => {
    console.error("Return AR reclass error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
