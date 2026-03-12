import { prisma } from "@/lib/prisma";

async function main() {
  const seedDateRaw = process.env.SEED_DATE || "";
  const entryDate = seedDateRaw ? new Date(seedDateRaw) : new Date();
  if (seedDateRaw && Number.isNaN(entryDate.getTime())) {
    throw new Error("Invalid SEED_DATE. Use YYYY-MM-DD.");
  }
  const inventory =
    (await prisma.ledgerAccount.findUnique({ where: { code: "1200" } })) ||
    (await prisma.ledgerAccount.create({
      data: { code: "1200", name: "Inventory", type: "ASSET" },
    }));
  const offset =
    (await prisma.ledgerAccount.findUnique({ where: { code: "6000" } })) ||
    (await prisma.ledgerAccount.create({
      data: { code: "6000", name: "Operating Expenses", type: "EXPENSE" },
    }));

  const amountRaw = Number(process.env.SEED_AMOUNT || 100);
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 100;
  const entry = await prisma.journalEntry.create({
    data: {
      entryDate,
      memo: "Seed inventory valuation variance",
      sourceType: "MANUAL",
      status: "POSTED",
      lines: {
        create: [
          { accountId: inventory.id, debit: amount, credit: 0, description: "Inventory variance seed" },
          { accountId: offset.id, debit: 0, credit: amount, description: "Inventory variance offset" },
        ],
      },
    },
  });

  console.log(`Seeded inventory valuation variance entry ${entry.id} for ${amount.toFixed(2)}.`);
}

main()
  .catch((err) => {
    console.error("Seed inventory valuation variance failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
