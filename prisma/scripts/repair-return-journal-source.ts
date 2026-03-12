import { prisma } from "@/lib/prisma";

function extractOrderId(memo?: string | null) {
  if (!memo) return null;
  const match = memo.match(/\(([^)]+)\)\s*$/);
  return match?.[1] || null;
}

async function main() {
  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "PAYMENT",
      memo: { contains: "Return/refund" },
    },
    include: { lines: true },
    orderBy: { entryDate: "asc" },
  });

  let created = 0;
  let voided = 0;
  let skipped = 0;

  for (const entry of entries) {
    const orderId = extractOrderId(entry.memo);
    if (!orderId) {
      skipped += 1;
      continue;
    }

    const existingOrderEntry = await prisma.journalEntry.findFirst({
      where: {
        status: "POSTED",
        sourceType: "ORDER",
        sourceId: orderId,
        memo: entry.memo,
      },
      select: { id: true },
    });

    if (!existingOrderEntry) {
      await prisma.journalEntry.create({
        data: {
          entryDate: entry.entryDate,
          memo: entry.memo,
          sourceType: "ORDER",
          sourceId: orderId,
          status: "POSTED",
          lines: {
            create: entry.lines.map((line) => ({
              accountId: line.accountId,
              debit: line.debit,
              credit: line.credit,
              description: line.description,
              taxCodeId: line.taxCodeId,
            })),
          },
        },
      });
      created += 1;
    }

    await prisma.journalEntry.update({
      where: { id: entry.id },
      data: { status: "VOID" },
    });
    voided += 1;
  }

  console.log(
    `Return journal source repair complete. Created: ${created}, Voided: ${voided}, Skipped: ${skipped}`
  );
}

main()
  .catch((err) => {
    console.error("Return journal source repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
