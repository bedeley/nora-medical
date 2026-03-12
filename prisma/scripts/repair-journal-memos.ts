import { prisma } from "@/lib/prisma";

function shortenLabel(prefix: string, text: string) {
  if (!text.startsWith(prefix)) return text;
  const rest = text.replace(prefix, "").trim();
  if (!rest.startsWith("INV-")) return text;
  const parts = rest.split(/\s+/);
  return `${prefix}${parts[0]}`;
}

async function main() {
  const entries = await prisma.journalEntry.findMany({
    where: { sourceType: "PAYMENT" },
    select: { id: true, memo: true, lines: { select: { id: true, description: true } } },
  });

  let updated = 0;
  let linesUpdated = 0;
  for (const entry of entries) {
    let entryDirty = false;
    if (entry.memo) {
      const nextMemo = shortenLabel("Customer payment - ", entry.memo);
      if (nextMemo !== entry.memo) {
        await prisma.journalEntry.update({
          where: { id: entry.id },
          data: { memo: nextMemo },
        });
        entryDirty = true;
        updated += 1;
      }
    }
    for (const line of entry.lines) {
      if (!line.description) continue;
      const nextPayment = shortenLabel("Payment received - ", line.description);
      const nextAR = shortenLabel("Accounts receivable - ", nextPayment);
      if (nextAR === line.description) continue;
      await prisma.journalLine.update({
        where: { id: line.id },
        data: { description: nextAR },
      });
      linesUpdated += 1;
    }
    if (entryDirty) continue;
  }

  console.log(
    `Journal memo repair complete. Updated ${updated} entries, ${linesUpdated} lines.`,
  );
}

main()
  .catch((err) => {
    console.error("Repair journal memos error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
