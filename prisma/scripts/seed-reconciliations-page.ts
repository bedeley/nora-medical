import bcrypt from "bcryptjs";

import { Role, type BankTxnType, type ReconciliationMatchStatus, type ReconciliationStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

type ReconciliationSeed = {
  key: string;
  bankName: string;
  status: ReconciliationStatus;
  statementBalance: number;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  transactionCount: number;
  matchedCount: number;
  assigneeRole?: Role;
};

function ymdUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, monthOneBased: number, day: number): Date {
  return new Date(Date.UTC(year, monthOneBased - 1, day, 0, 0, 0, 0));
}

function monthStart(date: Date): Date {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function monthEnd(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

async function ensureBankAccount(name: string) {
  const existing = await prisma.bankAccount.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.bankAccount.create({
    data: {
      name,
      bankName: name.includes("Savings") ? "Consolidated Bank Ghana" : "GCB Bank",
      accountNumberMasked: name.includes("Savings") ? "****8891" : "****1024",
      currency: "GHS",
      isActive: true,
    },
  });
}

async function ensureUserForRole(role: Role) {
  const existing = await prisma.user.findFirst({ where: { role, deletedAt: null }, orderBy: { createdAt: "asc" } });
  if (existing) return existing;

  const timestamp = Date.now();
  return prisma.user.create({
    data: {
      name: role === Role.ACCOUNTANT ? "Reconciliation Accountant" : "Reconciliation Admin",
      email: role === Role.ACCOUNTANT ? `recon.accountant.${timestamp}@noralls.test` : `recon.admin.${timestamp}@noralls.test`,
      password: await bcrypt.hash("ReconSeed#2026", 10),
      role,
    },
  });
}

async function ensureBankTransaction(params: {
  bankAccountId: string;
  postedAt: Date;
  amount: number;
  description: string;
  reference: string;
  type: BankTxnType;
}) {
  const existing = await prisma.bankTransaction.findFirst({
    where: { bankAccountId: params.bankAccountId, reference: params.reference },
  });
  if (existing) {
    return prisma.bankTransaction.update({
      where: { id: existing.id },
      data: {
        postedAt: params.postedAt,
        amount: params.amount,
        description: params.description,
        type: params.type,
      },
    });
  }
  return prisma.bankTransaction.create({ data: params });
}

async function ensureJournalLineForReconciliationTxn(params: {
  key: string;
  lineNumber: number;
  postedAt: Date;
  amount: number;
  type: BankTxnType;
}) {
  const bankAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1010" },
  }) || await prisma.ledgerAccount.create({
    data: { code: "1010", name: "Bank", type: "ASSET" },
  });

  const suspenseAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "2999" },
  }) || await prisma.ledgerAccount.create({
    data: { code: "2999", name: "Reconciliation Suspense", type: "LIABILITY" },
  });

  const memo = `Recon seed ${params.key} line ${params.lineNumber}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { memo, status: "POSTED" },
    include: { lines: true },
  });
  if (existing) {
    const existingBankLine = existing.lines.find((line) => line.accountId === bankAccount.id);
    if (existingBankLine) return existingBankLine.id;
  }

  const isCreditTxn = params.type === "CREDIT";
  const entry = await prisma.journalEntry.create({
    data: {
      entryDate: params.postedAt,
      memo,
      sourceType: "MANUAL",
      status: "POSTED",
      lines: {
        create: isCreditTxn
          ? [
              { accountId: bankAccount.id, debit: params.amount, credit: 0, description: memo },
              { accountId: suspenseAccount.id, debit: 0, credit: params.amount, description: memo },
            ]
          : [
              { accountId: suspenseAccount.id, debit: params.amount, credit: 0, description: memo },
              { accountId: bankAccount.id, debit: 0, credit: params.amount, description: memo },
            ],
      },
    },
    include: { lines: true },
  });

  const bankLine = entry.lines.find((line) => line.accountId === bankAccount.id);
  return bankLine?.id || null;
}

async function dedupeByDisplayedPeriod(bankAccountId: string, periodStart: Date, periodEnd: Date, preferredId: string) {
  const startYmd = ymdUtc(periodStart);
  const endYmd = ymdUtc(periodEnd);
  const candidates = await prisma.reconciliation.findMany({
    where: {
      bankAccountId,
      periodStart: {
        gte: new Date(`${startYmd}T00:00:00.000Z`),
        lte: new Date(`${startYmd}T23:59:59.999Z`),
      },
      periodEnd: {
        gte: new Date(`${endYmd}T00:00:00.000Z`),
        lte: new Date(`${endYmd}T23:59:59.999Z`),
      },
    },
    include: { lines: true },
    orderBy: { createdAt: "asc" },
  });
  if (candidates.length <= 1) return preferredId;

  const keep = candidates.find((c) => c.id === preferredId) || candidates[0];
  const others = candidates.filter((c) => c.id !== keep.id);

  for (const rec of others) {
    for (const line of rec.lines) {
      const existsOnKeep = await prisma.reconciliationLine.findFirst({
        where: { reconciliationId: keep.id, bankTransactionId: line.bankTransactionId },
        select: { id: true },
      });
      if (existsOnKeep) {
        await prisma.reconciliationLine.delete({ where: { id: line.id } });
      } else {
        await prisma.reconciliationLine.update({
          where: { id: line.id },
          data: { reconciliationId: keep.id },
        });
      }
    }
    await prisma.reconciliation.delete({ where: { id: rec.id } });
  }

  return keep.id;
}

async function upsertReconciliation(def: ReconciliationSeed, assigneeId: string | null) {
  const bank = await ensureBankAccount(def.bankName);
  const reconciliation = await prisma.reconciliation.upsert({
    where: {
      bankAccountId_periodStart_periodEnd: {
        bankAccountId: bank.id,
        periodStart: def.periodStart,
        periodEnd: def.periodEnd,
      },
    },
    update: {
      status: def.status,
      statementBalance: def.statementBalance,
      assignedToId: assigneeId,
    },
    create: {
      bankAccountId: bank.id,
      status: def.status,
      statementBalance: def.statementBalance,
      periodStart: def.periodStart,
      periodEnd: def.periodEnd,
      assignedToId: assigneeId,
    },
  });

  await prisma.reconciliation.update({
    where: { id: reconciliation.id },
    data: { createdAt: def.createdAt },
  });

  const canonicalId = await dedupeByDisplayedPeriod(
    bank.id,
    def.periodStart,
    def.periodEnd,
    reconciliation.id,
  );

  for (let i = 0; i < def.transactionCount; i += 1) {
    const lineNumber = i + 1;
    const shouldBeMatched = i < def.matchedCount;
    const postedAt = utcDate(def.periodStart.getUTCFullYear(), def.periodStart.getUTCMonth() + 1, Math.min(27, 5 + i * 4));
    const amount = 500 + i * 150;
    const txnType: BankTxnType = i % 2 === 0 ? "CREDIT" : "DEBIT";
    const txn = await ensureBankTransaction({
      bankAccountId: bank.id,
      postedAt,
      amount,
      description: `${def.key.toUpperCase()} TXN ${lineNumber}`,
      reference: `RECON-${def.key.toUpperCase()}-${lineNumber}`,
      type: txnType,
    });
    const journalLineId = await ensureJournalLineForReconciliationTxn({
      key: def.key,
      lineNumber,
      postedAt,
      amount,
      type: txnType,
    });
    await prisma.bankTransaction.update({
      where: { id: txn.id },
      data: { matched: shouldBeMatched },
    });

    const matchStatus: ReconciliationMatchStatus = i < def.matchedCount ? "MATCHED" : "UNMATCHED";
    await prisma.reconciliationLine.upsert({
      where: { bankTransactionId: txn.id },
      update: {
        reconciliationId: canonicalId,
        matchStatus,
        journalLineId: shouldBeMatched ? journalLineId : null,
      },
      create: {
        reconciliationId: canonicalId,
        bankTransactionId: txn.id,
        matchStatus,
        journalLineId: shouldBeMatched ? journalLineId : null,
      },
    });
  }

  return prisma.reconciliation.findUniqueOrThrow({ where: { id: canonicalId } });
}

async function main() {
  const now = new Date();
  const currentMonthStart = monthStart(now);
  const currentMonthEnd = monthEnd(now);

  const sevenDaysOldDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 8));
  const fourteenDaysOldDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 16));

  const olderOneStart = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const olderOneEnd = monthEnd(olderOneStart);
  const olderTwoStart = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)));
  const olderTwoEnd = monthEnd(olderTwoStart);
  const olderThreeStart = monthStart(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)));
  const olderThreeEnd = monthEnd(olderThreeStart);

  const accountant = await ensureUserForRole(Role.ACCOUNTANT);
  const admin = await ensureUserForRole(Role.ADMIN);

  const definitions: ReconciliationSeed[] = [
    {
      key: "current-open",
      bankName: "Primary Operating Account",
      status: "IN_PROGRESS",
      statementBalance: 4200,
      periodStart: currentMonthStart,
      periodEnd: currentMonthEnd,
      createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      transactionCount: 3,
      matchedCount: 1,
      assigneeRole: undefined,
    },
    {
      key: "age-8d",
      bankName: "Primary Operating Account",
      status: "IN_PROGRESS",
      statementBalance: 3650,
      periodStart: olderOneStart,
      periodEnd: olderOneEnd,
      createdAt: sevenDaysOldDate,
      transactionCount: 4,
      matchedCount: 2,
      assigneeRole: Role.ACCOUNTANT,
    },
    {
      key: "age-16d",
      bankName: "Secondary Savings Account",
      status: "IN_PROGRESS",
      statementBalance: 2780,
      periodStart: olderTwoStart,
      periodEnd: olderTwoEnd,
      createdAt: fourteenDaysOldDate,
      transactionCount: 3,
      matchedCount: 0,
      assigneeRole: Role.ADMIN,
    },
    {
      key: "closed-reference",
      bankName: "Secondary Savings Account",
      status: "CLOSED",
      statementBalance: 2995,
      periodStart: olderThreeStart,
      periodEnd: olderThreeEnd,
      createdAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 4)),
      transactionCount: 3,
      matchedCount: 3,
      assigneeRole: Role.ACCOUNTANT,
    },
  ];

  const results: Array<{ key: string; id: string; status: ReconciliationStatus; bank: string }> = [];
  for (const def of definitions) {
    const assigneeId = def.assigneeRole === Role.ACCOUNTANT ? accountant.id : def.assigneeRole === Role.ADMIN ? admin.id : null;
    const reconciliation = await upsertReconciliation(def, assigneeId);
    results.push({ key: def.key, id: reconciliation.id, status: reconciliation.status, bank: def.bankName });
  }

  const summary = await prisma.reconciliation.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  console.log("Seeded reconciliation page dataset:");
  for (const row of results) {
    console.log(`- ${row.key}: ${row.id} | ${row.bank} | ${row.status}`);
  }
  for (const item of summary) {
    console.log(`status=${item.status} count=${item._count._all}`);
  }
}

main()
  .catch((err) => {
    console.error("Seed reconciliations page failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
