import { prisma } from "@/lib/prisma";

type EntryRow = {
  id: string;
  memo: string | null;
  entryDate: Date;
};

async function main() {
  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "MANUAL",
      memo: { contains: "Return/refund AR reclass" },
    },
    select: { id: true, memo: true, entryDate: true },
    orderBy: { entryDate: "desc" },
  });

  const byMemo = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    if (!entry.memo) continue;
    const list = byMemo.get(entry.memo) ?? [];
    list.push(entry);
    byMemo.set(entry.memo, list);
  }

  let voided = 0;
  let skipped = 0;

  for (const [memo, list] of byMemo.entries()) {
    if (list.length <= 1) {
      skipped += 1;
      continue;
    }

    const sorted = list.sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime());
    const [, ...duplicates] = sorted;
    for (const dup of duplicates) {
      await prisma.journalEntry.update({
        where: { id: dup.id },
        data: { status: "VOID" },
      });
      voided += 1;
    }
    console.log(`Kept latest reclass for memo: ${memo}`);
  }

  console.log(`Orphan reclass cleanup complete. Voided: ${voided}, Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("Orphan reclass cleanup error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
