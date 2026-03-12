import { prisma } from "@/lib/prisma";
import { getAccountCodes } from "@/lib/accounting-posting";

type OrderItemRow = {
  quantity: number | null;
  costAtSale: number | null;
  product?: { cost: number | null } | null;
};

async function main() {
  const accountCodes = await getAccountCodes();
  const cogsCode = accountCodes.COGS;
  const inventoryCode = accountCodes.INVENTORY;

  const [cogsAccount, inventoryAccount] = await Promise.all([
    prisma.ledgerAccount.findUnique({ where: { code: cogsCode } }),
    prisma.ledgerAccount.findUnique({ where: { code: inventoryCode } }),
  ]);

  if (!cogsAccount || !inventoryAccount) {
    console.error("Missing ledger accounts for COGS or Inventory. Aborting.");
    process.exitCode = 1;
    return;
  }

  const entries = await prisma.journalEntry.findMany({
    where: { status: "POSTED", sourceType: "ORDER" },
    include: { lines: { include: { account: true } } },
    orderBy: { entryDate: "asc" },
  });

  let updated = 0;
  let skipped = 0;
  let missingLines = 0;

  for (const entry of entries) {
    const orderId = entry.sourceId;
    if (!orderId) {
      skipped += 1;
      continue;
    }
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          select: {
            quantity: true,
            costAtSale: true,
            product: { select: { cost: true } },
          },
        },
      },
    });
    if (!order) {
      skipped += 1;
      continue;
    }

    const items = order.items as OrderItemRow[];
    const expectedCogs = items.reduce((sum, item) => {
      const qty = Number(item.quantity || 0);
      const unitCost =
        item.costAtSale != null
          ? Number(item.costAtSale)
          : Number(item.product?.cost ?? 0);
      return sum + unitCost * qty;
    }, 0);

    const cogsLine = entry.lines.find((line) => line.account.code === cogsCode);
    const inventoryLine = entry.lines.find((line) => line.account.code === inventoryCode);

    if (!cogsLine || !inventoryLine) {
      missingLines += 1;
      continue;
    }

    const nextCogs = Math.max(0, Number(expectedCogs.toFixed(2)));
    const currentCogs = Number(cogsLine.debit || 0);
    const currentInventory = Number(inventoryLine.credit || 0);

    if (Math.abs(currentCogs - nextCogs) < 0.005 && Math.abs(currentInventory - nextCogs) < 0.005) {
      skipped += 1;
      continue;
    }

    await prisma.$transaction([
      prisma.journalLine.update({
        where: { id: cogsLine.id },
        data: { debit: nextCogs, credit: 0 },
      }),
      prisma.journalLine.update({
        where: { id: inventoryLine.id },
        data: { debit: 0, credit: nextCogs },
      }),
    ]);

    updated += 1;
  }

  console.log(
    `Order COGS repair complete. Updated: ${updated}, Skipped: ${skipped}, Missing lines: ${missingLines}`,
  );
}

main()
  .catch((err) => {
    console.error("Order COGS repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
