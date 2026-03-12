import { prisma } from "@/lib/prisma";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";

const EPSILON = 0.01;

async function main() {
  const totals = await loadAccountTotals();
  const inventoryRow = totals.find((row) => row.code === "1200");

  if (!inventoryRow) {
    console.log("Inventory ledger account (1200) not found. Skipping.");
    return;
  }

  const inventoryLedger = toNet(inventoryRow);
  const products = await prisma.product.findMany({
    select: { stock: true, cost: true },
  });
  const inventoryValuation = products.reduce(
    (sum, product) =>
      sum + Number(product.cost || 0) * Number(product.stock || 0),
    0,
  );

  const difference = inventoryLedger - inventoryValuation;
  if (Math.abs(difference) < EPSILON) {
    console.log("Inventory ledger already matches valuation. No adjustment needed.");
    return;
  }

  const inventoryAccountId =
    inventoryRow.accountId ||
    (await prisma.ledgerAccount.findUnique({ where: { code: "1200" } }))?.id;
  if (!inventoryAccountId) {
    throw new Error("Inventory account (1200) missing.");
  }

  const offsetAccount =
    (await prisma.ledgerAccount.findUnique({ where: { code: "5000" } })) ||
    (await prisma.ledgerAccount.findUnique({ where: { code: "6000" } }));
  if (!offsetAccount) {
    throw new Error("Missing offset account (5000 or 6000) for inventory adjustment.");
  }

  const adjustment = Math.abs(difference);
  const inventoryDebit = difference < 0 ? adjustment : 0;
  const inventoryCredit = difference > 0 ? adjustment : 0;
  const offsetDebit = difference > 0 ? adjustment : 0;
  const offsetCredit = difference < 0 ? adjustment : 0;

  await prisma.journalEntry.create({
    data: {
      entryDate: new Date(),
      memo: "Inventory valuation adjustment",
      sourceType: "MANUAL",
      status: "POSTED",
      lines: {
        create: [
          {
            accountId: inventoryAccountId,
            debit: inventoryDebit,
            credit: inventoryCredit,
            description: "Inventory valuation alignment",
          },
          {
            accountId: offsetAccount.id,
            debit: offsetDebit,
            credit: offsetCredit,
            description: "Inventory valuation offset",
          },
        ],
      },
    },
  });

  console.log(
    `Inventory adjustment posted for ${adjustment.toFixed(2)} to align ledger with valuation.`,
  );
}

main()
  .catch((err) => {
    console.error("Inventory ledger reconcile error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
