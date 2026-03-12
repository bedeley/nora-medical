import { prisma } from "@/lib/prisma";
import { getAccountCodes } from "@/lib/accounting-posting";

function fmt(value: number) {
  return value.toFixed(2);
}

async function main() {
  const accountCodes = await getAccountCodes();
  const salesCode = accountCodes.SALES;
  const cogsCode = accountCodes.COGS;
  const inventoryCode = accountCodes.INVENTORY;

  const entries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "ORDER",
      memo: { contains: "Return/refund" },
    },
    include: { lines: { include: { account: true } } },
    orderBy: { entryDate: "asc" },
  });

  let fixed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const salesLine = entry.lines.find((line) => line.account.code === salesCode);
    const cogsLine = entry.lines.find((line) => line.account.code === cogsCode);
    const inventoryLine = entry.lines.find((line) => line.account.code === inventoryCode);
    if (!salesLine || !cogsLine || !inventoryLine) {
      skipped += 1;
      continue;
    }

    const salesNet = Number(salesLine.credit || 0) - Number(salesLine.debit || 0);
    const cogsNet = Number(cogsLine.debit || 0) - Number(cogsLine.credit || 0);
    const inventoryNet = Number(inventoryLine.debit || 0) - Number(inventoryLine.credit || 0);

    // Return/refund should debit sales (salesNet < 0).
    if (!(salesNet < -0.005)) {
      skipped += 1;
      continue;
    }

    // For restocked returns, COGS should be credit (cogsNet < 0) and inventory debit (inventoryNet > 0).
    // If both are reversed, flip them.
    if (cogsNet > 0.005 && inventoryNet < -0.005) {
      const amount = Math.max(Math.abs(cogsNet), Math.abs(inventoryNet));
      await prisma.$transaction([
        prisma.journalLine.update({
          where: { id: cogsLine.id },
          data: { debit: 0, credit: amount },
        }),
        prisma.journalLine.update({
          where: { id: inventoryLine.id },
          data: { debit: amount, credit: 0 },
        }),
      ]);
      fixed += 1;
      console.log(
        `Fixed entry ${entry.id}: flipped COGS/Inventory ${fmt(amount)}`,
      );
      continue;
    }

    skipped += 1;
  }

  console.log(`Return COGS direction repair complete. Fixed: ${fixed}, Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("Return COGS direction repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
