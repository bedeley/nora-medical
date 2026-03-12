import { prisma } from "@/lib/prisma";

async function main() {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) {
    console.log("Usage: pnpm db:void-journal-entries <entryId> [entryId...]");
    return;
  }

  let voided = 0;
  let missing = 0;

  for (const id of ids) {
    const entry = await prisma.journalEntry.findUnique({
      where: { id },
      select: { id: true, status: true, memo: true },
    });
    if (!entry) {
      missing += 1;
      continue;
    }
    if (entry.status === "VOID") {
      continue;
    }
    await prisma.journalEntry.update({
      where: { id },
      data: { status: "VOID" },
    });
    voided += 1;
    console.log(`Voided entry ${id}${entry.memo ? ` (${entry.memo})` : ""}`);
  }

  console.log(`Void complete. Voided: ${voided}, Missing: ${missing}`);
}

main()
  .catch((err) => {
    console.error("Void journal entries error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
