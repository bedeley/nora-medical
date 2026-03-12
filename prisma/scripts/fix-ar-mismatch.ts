import { prisma } from "@/lib/prisma";
import { postOrderEntry } from "@/lib/accounting-posting";

async function main() {
  const idOrInvoice = process.argv[2];
  if (!idOrInvoice) {
    console.error("Usage: pnpm tsx prisma/scripts/fix-ar-mismatch.ts <order-id-or-invoice>");
    process.exit(1);
  }

  // Locate the order by id or invoiceNumber (case-insensitive)
  const order = await prisma.order.findFirst({
    where: {
      OR: [
        { id: idOrInvoice },
        { invoiceNumber: { equals: idOrInvoice, mode: "insensitive" } },
      ],
    },
    select: { id: true, invoiceNumber: true, total: true, amountPaid: true, status: true },
  });
  if (!order) {
    console.error(`Order not found for '${idOrInvoice}'.`);
    process.exit(1);
  }

  // Check existing posted journal entries for this order
  const entries = await prisma.journalEntry.findMany({
    where: { sourceType: "ORDER", sourceId: order.id, status: "POSTED" },
    select: { id: true, memo: true, entryDate: true },
  });

  console.log(`Order ${order.invoiceNumber || order.id}`);
  console.log(
    `  status=${order.status} total=${Number(order.total || 0).toFixed(
      2,
    )} paid=${Number(order.amountPaid || 0).toFixed(2)}`,
  );
  console.log(`  posted order entries: ${entries.length}`);
  entries.forEach((e) =>
    console.log(`    ${e.id} @ ${e.entryDate.toISOString()} memo=${e.memo || "-"}`),
  );

  if (entries.length === 0) {
    console.log("No posted ORDER entries found. Posting one now...");
    const entry = await postOrderEntry({ orderId: order.id });
    if (entry) {
      console.log(`Posted entry ${entry.id}`);
    } else {
      console.log("Post skipped (feature flag off, period closed, or duplicate detected).");
    }
  } else {
    console.log("At least one ORDER entry already posted; not reposting.");
  }

  // Show AR net for this order after the fix
  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) {
    console.error("AR account (1100) not found; cannot compute AR net.");
    return;
  }

  const arLines = await prisma.journalLine.findMany({
    where: {
      accountId: arAccount.id,
      entry: { status: "POSTED", sourceType: { in: ["ORDER", "PAYMENT"] } },
      OR: [{ entry: { sourceId: order.id } }, { entry: { sourceId: { in: [order.id] } } }],
    },
    select: { debit: true, credit: true, entry: { select: { sourceType: true, sourceId: true } } },
  });

  const arNet = arLines.reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0);
  const operational = Math.max(0, Number(order.total || 0) - Number(order.amountPaid || 0));

  console.log(`After fix — operational AR: ${operational.toFixed(2)}, ledger AR: ${arNet.toFixed(2)}, delta: ${(arNet - operational).toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
