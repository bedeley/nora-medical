import { prisma } from "@/lib/prisma";

function extractEntryId(memo?: string | null) {
  if (!memo) return null;
  const match = memo.match(/\(([^)]+)\)\s*$/);
  return match?.[1] || null;
}

async function main() {
  const reclassEntries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "MANUAL",
      memo: { contains: "Return/refund reclassification" },
    },
    select: { id: true, memo: true },
  });

  let voided = 0;
  let skipped = 0;

  for (const entry of reclassEntries) {
    const referencedId = extractEntryId(entry.memo);
    if (!referencedId) {
      skipped += 1;
      continue;
    }

    const referenced = await prisma.journalEntry.findUnique({
      where: { id: referencedId },
      select: { id: true, status: true, sourceType: true, memo: true },
    });

    if (!referenced || referenced.status === "VOID") {
      await prisma.journalEntry.update({
        where: { id: entry.id },
        data: { status: "VOID" },
      });
      voided += 1;
      continue;
    }

    if (referenced.sourceType === "PAYMENT" && referenced.memo?.includes("Return/refund")) {
      skipped += 1;
      continue;
    }

    skipped += 1;
  }

  console.log(
    `Return reclassification cleanup complete. Voided: ${voided}, Skipped: ${skipped}`,
  );
}

main()
  .catch((err) => {
    console.error("Return reclassification cleanup error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
