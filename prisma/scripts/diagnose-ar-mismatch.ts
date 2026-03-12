import { prisma } from "@/lib/prisma";

type OrderRow = {
  id: string;
  invoiceNumber: string | null;
  total: number | null;
  amountPaid: number | null;
  status: string | null;
  customerType: string | null;
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

  const orders = await prisma.order.findMany({
    where: { status: { not: "CANCELLED" } },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      amountPaid: true,
      status: true,
      customerType: true,
    },
  });

  const payments = await prisma.payment.findMany({
    where: { deletedAt: null, orderId: { not: null } },
    select: { id: true, orderId: true },
  });
  const paymentToOrder = new Map(payments.map((p) => [p.id, p.orderId as string]));

  const arLines = await prisma.journalLine.findMany({
    where: { accountId: arAccount.id, entry: { status: "POSTED" } },
    select: {
      debit: true,
      credit: true,
      entry: { select: { id: true, sourceType: true, sourceId: true, memo: true } },
    },
  });

  const entryIdToOrder = new Map<string, string>();

  const ledgerByOrder = new Map<string, number>();
  for (const line of arLines) {
    const sourceType = line.entry?.sourceType;
    const sourceId = line.entry?.sourceId;
    let orderId: string | null = null;
    if (sourceType === "ORDER") {
      orderId = sourceId ?? null;
    } else if (sourceType === "PAYMENT") {
      orderId = sourceId ? paymentToOrder.get(sourceId) ?? null : null;
    } else if (sourceType === "MANUAL" && line.entry?.memo) {
      const match = line.entry.memo.match(/\(([^)]+)\)/);
      const referencedEntryId = match?.[1] ?? null;
      if (referencedEntryId) {
        const cached = entryIdToOrder.get(referencedEntryId);
        if (cached) {
          orderId = cached;
        } else {
          const referenced = await prisma.journalEntry.findUnique({
            where: { id: referencedEntryId },
            select: { sourceType: true, sourceId: true },
          });
          if (referenced?.sourceType === "ORDER" && referenced.sourceId) {
            orderId = referenced.sourceId;
            entryIdToOrder.set(referencedEntryId, referenced.sourceId);
          }
        }
      }
    }
    if (!orderId) continue;
    const delta = Number(line.debit || 0) - Number(line.credit || 0);
    ledgerByOrder.set(orderId, (ledgerByOrder.get(orderId) ?? 0) + delta);
  }

  const mismatches: Array<{
    order: OrderRow;
    operationalAr: number;
    ledgerAr: number;
    delta: number;
  }> = [];

  for (const order of orders) {
    const operationalAr = Math.max(
      0,
      Number(order.total || 0) - Number(order.amountPaid || 0),
    );
    const ledgerAr = round(ledgerByOrder.get(order.id) ?? 0);
    const delta = round(ledgerAr - operationalAr);
    if (Math.abs(delta) > 0.01) {
      mismatches.push({ order, operationalAr: round(operationalAr), ledgerAr, delta });
    }
  }

  if (!mismatches.length) {
    console.log("No per-order AR mismatches found.");
    return;
  }

  mismatches.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  console.log("Orders with AR mismatches:");
  for (const row of mismatches) {
    const label = row.order.invoiceNumber || row.order.id;
    console.log(
      `${label} | status=${row.order.status} | customer=${row.order.customerType} | operational=${row.operationalAr.toFixed(
        2,
      )} | ledger=${row.ledgerAr.toFixed(2)} | delta=${row.delta.toFixed(2)}`,
    );
  }
}

main()
  .catch((err) => {
    console.error("AR mismatch diagnostic error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
