import { prisma } from "@/lib/prisma";

type OrphanRow = {
  entryId: string;
  entryDate: Date;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  arNet: number;
};

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function main() {
  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) {
    throw new Error("AR account (1100) not found.");
  }

  const arLines = await prisma.journalLine.findMany({
    where: { accountId: arAccount.id, entry: { status: "POSTED" } },
    select: {
      debit: true,
      credit: true,
      entry: { select: { id: true, entryDate: true, memo: true, sourceType: true, sourceId: true } },
    },
  });

  const payments = await prisma.payment.findMany({
    where: { deletedAt: null },
    select: { id: true, orderId: true },
  });
  const paymentToOrder = new Map(payments.map((p) => [p.id, p.orderId]));

  const orphanByEntry = new Map<string, OrphanRow>();

  for (const line of arLines) {
    const entry = line.entry;
    if (!entry) continue;

    let hasOrder = false;
    if (entry.sourceType === "ORDER" && entry.sourceId) {
      hasOrder = true;
    } else if (entry.sourceType === "PAYMENT" && entry.sourceId) {
      const orderId = paymentToOrder.get(entry.sourceId);
      hasOrder = Boolean(orderId);
    }

    if (hasOrder) continue;

    const net = round(Number(line.debit || 0) - Number(line.credit || 0));
    const existing = orphanByEntry.get(entry.id);
    if (existing) {
      existing.arNet = round(existing.arNet + net);
    } else {
      orphanByEntry.set(entry.id, {
        entryId: entry.id,
        entryDate: entry.entryDate,
        memo: entry.memo,
        sourceType: entry.sourceType ?? null,
        sourceId: entry.sourceId ?? null,
        arNet: net,
      });
    }
  }

  const rows = Array.from(orphanByEntry.values()).filter((row) => Math.abs(row.arNet) > 0.01);
  if (!rows.length) {
    console.log("No orphan AR entries found.");
    return;
  }

  rows.sort((a, b) => Math.abs(b.arNet) - Math.abs(a.arNet));

  console.log("Orphan AR entries (not tied to an order or payment):");
  for (const row of rows) {
    console.log(
      `${row.entryDate.toISOString()} | ${row.entryId} | ${row.sourceType ?? "-"} | ${
        row.sourceId ?? "-"
      } | ${row.arNet.toFixed(2)} | ${row.memo ?? "-"}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("AR orphan diagnostic error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
