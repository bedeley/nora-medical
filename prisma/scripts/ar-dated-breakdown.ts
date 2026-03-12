import { prisma } from "@/lib/prisma";

function round(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  const asOfArg = process.argv[2];
  if (!asOfArg) {
    console.error("Usage: pnpm tsx prisma/scripts/ar-dated-breakdown.ts 2026-01-28");
    process.exit(1);
  }
  const asOf = new Date(asOfArg);
  if (Number.isNaN(asOf.getTime())) {
    console.error("Invalid date; use YYYY-MM-DD");
    process.exit(1);
  }
  asOf.setHours(23, 59, 59, 999);

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) throw new Error("AR account 1100 not found");

  const lines = await prisma.journalLine.findMany({
    where: { accountId: arAccount.id, entry: { status: "POSTED" } },
    select: {
      debit: true,
      credit: true,
      entry: { select: { entryDate: true, sourceType: true, sourceId: true } },
    },
  });

  let onOrBefore = 0;
  let after = 0;
  for (const l of lines) {
    const net = Number(l.debit || 0) - Number(l.credit || 0);
    const date = l.entry?.entryDate;
    if (!date) continue;
    if (date <= asOf) onOrBefore += net;
    else after += net;
  }

  console.log(`As of (<=) ${asOfArg}: ${round(onOrBefore).toFixed(2)}`);
  console.log(`After ${asOfArg}: ${round(after).toFixed(2)}`);
  console.log(`Total all: ${round(onOrBefore + after).toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
