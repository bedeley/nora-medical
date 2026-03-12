import { prisma } from "@/lib/prisma";
import { setFeatureEnabled } from "@/lib/features";

const ACCOUNT_CODES = {
  CASH: "1000",
  AR: "1100",
  STORE_CREDIT: "2200",
};

const DEFAULT_ACCOUNTS: Record<
  string,
  { name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }
> = {
  "1000": { name: "Cash", type: "ASSET" },
  "1100": { name: "Accounts Receivable", type: "ASSET" },
  "2200": { name: "Store Credit", type: "LIABILITY" },
};

async function ensureAccount(code: string) {
  const existing = await prisma.ledgerAccount.findUnique({ where: { code } });
  if (existing) return existing.id;
  const template = DEFAULT_ACCOUNTS[code];
  if (!template) return null;
  const created = await prisma.ledgerAccount.create({
    data: { code, name: template.name, type: template.type },
  });
  return created.id;
}

async function main() {
  await setFeatureEnabled("accounting_auto_post", true);

  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "PAYMENT",
      memo: { contains: "Return/refund" },
    },
    include: {
      lines: { include: { account: true } },
    },
  });

  const payments = await prisma.payment.findMany({
    where: { id: { in: entries.map((entry) => entry.sourceId || "") } },
    select: { id: true, status: true, refundDisposition: true, amount: true },
  });
  const paymentMap = new Map(payments.map((payment) => [payment.id, payment]));

  let corrected = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.sourceId) {
      skipped += 1;
      continue;
    }
    const payment = paymentMap.get(entry.sourceId);
    if (!payment) {
      skipped += 1;
      continue;
    }

    const arLine = entry.lines.find((line) => line.account.code === ACCOUNT_CODES.AR);
    const arCredit = arLine ? Number(arLine.credit || 0) : 0;
    if (!(arCredit > 0)) {
      skipped += 1;
      continue;
    }

    const isStoreCredit = payment.refundDisposition === "CREDIT";
    const isCashRefund =
      String(payment.status || "").toUpperCase() === "REFUND" || Number(payment.amount || 0) < 0;

    const targetCode = isStoreCredit
      ? ACCOUNT_CODES.STORE_CREDIT
      : isCashRefund
      ? ACCOUNT_CODES.CASH
      : null;
    if (!targetCode) {
      skipped += 1;
      continue;
    }

    const targetLine = entry.lines.find((line) => line.account.code === targetCode);
    const targetCredit = targetLine ? Number(targetLine.credit || 0) : 0;
    const delta = arCredit - targetCredit;
    if (!(delta > 0)) {
      skipped += 1;
      continue;
    }

    const arId = await ensureAccount(ACCOUNT_CODES.AR);
    const targetId = await ensureAccount(targetCode);
    if (!arId || !targetId) {
      skipped += 1;
      continue;
    }

    await prisma.journalEntry.create({
      data: {
        entryDate: new Date(),
        memo: `Return/refund reclassification (${entry.id})`,
        sourceType: "MANUAL",
        status: "POSTED",
        lines: {
          create: [
            {
              accountId: arId,
              debit: delta,
              credit: 0,
              description: "Reclass return refund from AR",
            },
            {
              accountId: targetId,
              debit: 0,
              credit: delta,
              description: isStoreCredit
                ? "Reclass to store credit"
                : "Reclass to cash refund",
            },
          ],
        },
      },
    });

    corrected += 1;
  }

  console.log(`Return refund reclassification complete. Corrected: ${corrected}, Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("Return refund reclassification error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
