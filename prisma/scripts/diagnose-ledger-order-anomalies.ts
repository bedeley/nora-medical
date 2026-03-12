import { prisma } from "@/lib/prisma";
import { getAccountCodes } from "@/lib/accounting-posting";

type EntryRow = {
  id: string;
  sourceId: string | null;
  entryDate: Date;
  memo: string | null;
  lines: Array<{
    debit: number | null;
    credit: number | null;
    account: { code: string; type: string };
  }>;
};

function formatAmount(value: number) {
  return value.toFixed(2);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const accountCodes = await getAccountCodes();
  const salesCode = accountCodes.SALES;
  const cogsCode = accountCodes.COGS;

  const entries = (await prisma.journalEntry.findMany({
    where: { status: "POSTED", sourceType: "ORDER" },
    include: { lines: { include: { account: true } } },
    orderBy: { entryDate: "asc" },
  })) as EntryRow[];

  const ordersById = new Map(
    (
      await prisma.order.findMany({
        select: { id: true, invoiceNumber: true, status: true },
      })
    ).map((order) => [order.id, order]),
  );

  const salesEntriesByOrder = new Map<
    string,
    Array<{
      entry: EntryRow;
      salesNet: number;
      cogsNet: number;
    }>
  >();

  for (const entry of entries) {
    if (!entry.sourceId) continue;
    const salesNet = entry.lines
      .filter((line) => line.account.code === salesCode)
      .reduce((sum, line) => sum + Number(line.credit || 0) - Number(line.debit || 0), 0);
    const cogsNet = entry.lines
      .filter((line) => line.account.code === cogsCode)
      .reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0);

    if (!salesEntriesByOrder.has(entry.sourceId)) {
      salesEntriesByOrder.set(entry.sourceId, []);
    }
    salesEntriesByOrder.get(entry.sourceId)!.push({ entry, salesNet, cogsNet });
  }

  const duplicateSalesEntries: Array<{
    orderId: string;
    invoiceNumber: string | null;
    entries: Array<{ entry: EntryRow; salesNet: number; cogsNet: number }>;
  }> = [];
  const cancelledSalesEntries: Array<{
    orderId: string;
    invoiceNumber: string | null;
    entry: EntryRow;
    salesNet: number;
    cogsNet: number;
  }> = [];

  for (const [orderId, rows] of salesEntriesByOrder.entries()) {
    const salesRows = rows.filter((row) => row.salesNet > 0.005);
    if (salesRows.length > 1) {
      duplicateSalesEntries.push({
        orderId,
        invoiceNumber: ordersById.get(orderId)?.invoiceNumber ?? null,
        entries: salesRows,
      });
    }
    const status = ordersById.get(orderId)?.status || "";
    if (status === "CANCELLED" || status === "CANCELED") {
      for (const row of salesRows) {
        cancelledSalesEntries.push({
          orderId,
          invoiceNumber: ordersById.get(orderId)?.invoiceNumber ?? null,
          entry: row.entry,
          salesNet: row.salesNet,
          cogsNet: row.cogsNet,
        });
      }
    }
  }

  console.log("Ledger order anomalies");
  console.log(`Duplicate sales entries: ${duplicateSalesEntries.length}`);
  console.log(`Cancelled orders with posted sales entries: ${cancelledSalesEntries.length}`);

  if (duplicateSalesEntries.length) {
    console.log("\nDuplicate sales entries (per order):");
    for (const dup of duplicateSalesEntries) {
      const label = dup.invoiceNumber || dup.orderId;
      console.log(`- ${label} (${dup.entries.length} sales entries)`);
      dup.entries.forEach((row) => {
        console.log(
          `  ${row.entry.id} | ${row.entry.entryDate.toISOString()} | sales ${formatAmount(row.salesNet)} | cogs ${formatAmount(row.cogsNet)} | memo ${row.entry.memo || ""}`,
        );
      });
    }
  }

  if (cancelledSalesEntries.length) {
    console.log("\nCancelled order entries:");
    for (const row of cancelledSalesEntries) {
      const label = row.invoiceNumber || row.orderId;
      console.log(
        `- ${label} | ${row.entry.id} | ${row.entry.entryDate.toISOString()} | sales ${formatAmount(row.salesNet)} | cogs ${formatAmount(row.cogsNet)} | memo ${row.entry.memo || ""}`,
      );
    }
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to void duplicates/cancelled sales entries.");
    return;
  }

  const toVoid = new Set<string>();

  for (const dup of duplicateSalesEntries) {
    const ordered = dup.entries.slice().sort((a, b) => a.entry.entryDate.getTime() - b.entry.entryDate.getTime());
    ordered.slice(1).forEach((row) => toVoid.add(row.entry.id));
  }
  for (const row of cancelledSalesEntries) {
    toVoid.add(row.entry.id);
  }

  let voided = 0;
  for (const entryId of toVoid) {
    await prisma.journalEntry.update({
      where: { id: entryId },
      data: { status: "VOID" },
    });
    voided += 1;
  }

  console.log(`\nVoided entries: ${voided}`);
}

main()
  .catch((err) => {
    console.error("Ledger anomaly diagnostic error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
