import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const DEFAULT_CASH_CODE = "1000";
const DEFAULT_OVER_SHORT_CODE = "6990";

async function main() {
  const cashAccount =
    (await prisma.ledgerAccount.findUnique({ where: { code: DEFAULT_CASH_CODE } })) ||
    (await prisma.ledgerAccount.create({
      data: { code: DEFAULT_CASH_CODE, name: "Cash", type: "ASSET" },
    }));

  const totals = await prisma.journalLine.aggregate({
    where: {
      accountId: cashAccount.id,
      entry: { status: "POSTED" },
    },
    _sum: { debit: true, credit: true },
  });
  const expectedAmount =
    Number(totals._sum.debit || 0) - Number(totals._sum.credit || 0);

  const actualAmount = Number(
    new Prisma.Decimal(expectedAmount).minus(50).toFixed(2)
  );
  const variance = Number(
    new Prisma.Decimal(actualAmount).minus(expectedAmount).toFixed(2)
  );

  let journalEntryId: string | null = null;
  if (variance !== 0) {
    const overShort =
      (await prisma.ledgerAccount.findUnique({
        where: { code: DEFAULT_OVER_SHORT_CODE },
      })) ||
      (await prisma.ledgerAccount.create({
        data: {
          code: DEFAULT_OVER_SHORT_CODE,
          name: "Cash Over/Short",
          type: "EXPENSE",
        },
      }));
    const amount = Math.abs(variance);
    const lines =
      variance > 0
        ? [
            {
              accountId: cashAccount.id,
              debit: amount,
              credit: 0,
              description: "Cash count adjustment",
            },
            {
              accountId: overShort.id,
              debit: 0,
              credit: amount,
              description: "Cash over/short",
            },
          ]
        : [
            {
              accountId: overShort.id,
              debit: amount,
              credit: 0,
              description: "Cash over/short",
            },
            {
              accountId: cashAccount.id,
              debit: 0,
              credit: amount,
              description: "Cash count adjustment",
            },
          ];

    const entry = await prisma.journalEntry.create({
      data: {
        entryDate: new Date(),
        memo: "Cash reconciliation adjustment",
        sourceType: "MANUAL",
        status: "POSTED",
        lines: {
          create: lines,
        },
      },
    });
    journalEntryId = entry.id;
  }

  const rec = await prisma.cashReconciliation.create({
    data: {
      cashAccountId: cashAccount.id,
      countedAt: new Date(),
      expectedAmount,
      actualAmount,
      variance,
      notes: "Seeded cash count for tutorial",
      journalEntryId,
    },
    include: {
      cashAccount: true,
    },
  });

  console.log(
    `Seeded cash reconciliation ${rec.id} for ${rec.cashAccount.code} (${rec.cashAccount.name}).`
  );
}

main()
  .catch((err) => {
    console.error("Seed cash reconciliation failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
