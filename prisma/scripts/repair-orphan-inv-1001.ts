import { prisma } from "@/lib/prisma";

async function main() {
  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "MANUAL",
      memo: { in: ["Invoice #INV-1001", "MoMo payment for INV-1001"] },
    },
    select: { id: true, memo: true },
  });

  if (!entries.length) {
    console.log("No INV-1001 manual entries found.");
    return;
  }

  for (const entry of entries) {
    await prisma.journalEntry.update({
      where: { id: entry.id },
      data: { status: "VOID" },
    });
    console.log(`Voided manual entry: ${entry.memo ?? entry.id}`);
  }

  console.log(`Voided ${entries.length} INV-1001 manual entry(ies).`);
}

main()
  .catch((err) => {
    console.error("INV-1001 orphan cleanup error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
