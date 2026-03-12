import { prisma } from "@/lib/prisma";
import { getAccountCodes } from "@/lib/accounting-posting";

type OrderRow = {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  createdAt: Date;
  items: Array<{
    quantity: number | null;
    price: number | null;
    costAtSale: number | null;
    product: { cost: number | null } | null;
  }>;
};

function formatAmount(value: number) {
  return value.toFixed(2);
}

async function main() {
  const accountCodes = await getAccountCodes();
  const salesCode = accountCodes.SALES;
  const cogsCode = accountCodes.COGS;

  const orders = (await prisma.order.findMany({
    where: { status: { notIn: ["CANCELLED", "CANCELED"] } },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      createdAt: true,
      items: {
        select: {
          quantity: true,
          price: true,
          costAtSale: true,
          product: { select: { cost: true } },
        },
      },
    },
  })) as OrderRow[];

  const entries = await prisma.journalEntry.findMany({
    where: { status: "POSTED", sourceType: "ORDER" },
    include: { lines: { include: { account: true } } },
  });

  const ledgerByOrder = new Map<
    string,
    { revenue: number; cogs: number; entryCount: number }
  >();

  for (const entry of entries) {
    if (!entry.sourceId) continue;
    let revenue = 0;
    let cogs = 0;
    for (const line of entry.lines) {
      if (line.account.code === salesCode) {
        revenue += Number(line.credit || 0) - Number(line.debit || 0);
      }
      if (line.account.code === cogsCode) {
        cogs += Number(line.debit || 0) - Number(line.credit || 0);
      }
    }
    if (!ledgerByOrder.has(entry.sourceId)) {
      ledgerByOrder.set(entry.sourceId, { revenue: 0, cogs: 0, entryCount: 0 });
    }
    const existing = ledgerByOrder.get(entry.sourceId)!;
    existing.revenue += revenue;
    existing.cogs += cogs;
    existing.entryCount += 1;
  }

  const deltas = orders.map((order) => {
    const operationalRevenue = order.items.reduce((sum, item) => {
      const qty = Number(item.quantity || 0);
      return sum + Number(item.price || 0) * qty;
    }, 0);
    const operationalCogs = order.items.reduce((sum, item) => {
      const qty = Number(item.quantity || 0);
      const unitCost =
        item.costAtSale != null
          ? Number(item.costAtSale)
          : Number(item.product?.cost ?? 0);
      return sum + unitCost * qty;
    }, 0);
    const ledger = ledgerByOrder.get(order.id) || { revenue: 0, cogs: 0, entryCount: 0 };
    return {
      id: order.id,
      invoiceNumber: order.invoiceNumber,
      status: order.status,
      revenueDelta: ledger.revenue - operationalRevenue,
      cogsDelta: ledger.cogs - operationalCogs,
      ledgerRevenue: ledger.revenue,
      ledgerCogs: ledger.cogs,
      operationalRevenue,
      operationalCogs,
      entryCount: ledger.entryCount,
    };
  });

  const topRevenue = deltas
    .filter((row) => Math.abs(row.revenueDelta) > 0.01)
    .sort((a, b) => Math.abs(b.revenueDelta) - Math.abs(a.revenueDelta))
    .slice(0, 25);

  const topCogs = deltas
    .filter((row) => Math.abs(row.cogsDelta) > 0.01)
    .sort((a, b) => Math.abs(b.cogsDelta) - Math.abs(a.cogsDelta))
    .slice(0, 25);

  console.log("Top revenue deltas (ledger - operational):");
  if (!topRevenue.length) {
    console.log("  none");
  }
  topRevenue.forEach((row) => {
    const label = row.invoiceNumber || row.id;
    console.log(
      `- ${label} | delta ${formatAmount(row.revenueDelta)} | ledger ${formatAmount(
        row.ledgerRevenue,
      )} | op ${formatAmount(row.operationalRevenue)} | entries ${row.entryCount}`,
    );
  });

  console.log("\nTop COGS deltas (ledger - operational):");
  if (!topCogs.length) {
    console.log("  none");
  }
  topCogs.forEach((row) => {
    const label = row.invoiceNumber || row.id;
    console.log(
      `- ${label} | delta ${formatAmount(row.cogsDelta)} | ledger ${formatAmount(
        row.ledgerCogs,
      )} | op ${formatAmount(row.operationalCogs)} | entries ${row.entryCount}`,
    );
  });
}

main()
  .catch((err) => {
    console.error("Ledger order delta diagnostic error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
