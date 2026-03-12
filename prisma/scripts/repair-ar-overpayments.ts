import { prisma } from "@/lib/prisma";
import { postPaymentEntry } from "@/lib/accounting-posting";

type OrderRow = {
  id: string;
  invoiceNumber: string | null;
  total: number;
  amountPaid: number;
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
    select: { id: true, invoiceNumber: true, total: true, amountPaid: true },
  });
  const payments = await prisma.payment.findMany({
    where: { orderId: { not: null }, deletedAt: null },
    select: { id: true, orderId: true },
  });
  const paymentIdsByOrder = new Map<string, string[]>();
  for (const p of payments) {
    const oid = p.orderId as string | null;
    if (!oid) continue;
    const list = paymentIdsByOrder.get(oid) || [];
    list.push(p.id);
    paymentIdsByOrder.set(oid, list);
  }

  const arLines = await prisma.journalLine.findMany({
    where: { accountId: arAccount.id, entry: { status: "POSTED" } },
    select: {
      debit: true,
      credit: true,
      entry: { select: { sourceType: true, sourceId: true } },
    },
  });

  const ledgerByOrder = new Map<string, number>();
  for (const line of arLines) {
    const entry = line.entry;
    if (!entry) continue;
    let orderId: string | null = null;
    if (entry.sourceType === "ORDER") {
      orderId = entry.sourceId ?? null;
    } else if (entry.sourceType === "PAYMENT") {
      orderId = entry.sourceId ? (payments.find((p) => p.id === entry.sourceId)?.orderId as string | null) : null;
    }
    if (!orderId) continue;
    const delta = Number(line.debit || 0) - Number(line.credit || 0);
    ledgerByOrder.set(orderId, (ledgerByOrder.get(orderId) ?? 0) + delta);
  }

  const toFix: OrderRow[] = [];
  for (const o of orders) {
    const operationalAr = Math.max(0, Number(o.total || 0) - Number(o.amountPaid || 0));
    const ledgerAr = round(ledgerByOrder.get(o.id) ?? 0);
    if (operationalAr === 0 && ledgerAr < -0.01) {
      toFix.push({ ...o, total: Number(o.total || 0), amountPaid: Number(o.amountPaid || 0) });
    }
  }

  if (!toFix.length) {
    console.log("No overpayment AR mismatches detected.");
    return;
  }

  console.log(`Found ${toFix.length} overpayment mismatches. Voiding and reposting payment entries...`);

  for (const o of toFix) {
    const paymentIds = paymentIdsByOrder.get(o.id) || [];
    if (!paymentIds.length) {
      console.log(`  ${o.invoiceNumber || o.id}: no payments linked; skipping.`);
      continue;
    }

    // Void posted payment journal entries
    await prisma.journalEntry.updateMany({
      where: { sourceType: "PAYMENT", sourceId: { in: paymentIds }, status: "POSTED" },
      data: { status: "VOID" },
    });

    // Repost each payment using current logic (caps applied via note when present)
    for (const pid of paymentIds) {
      await postPaymentEntry({ paymentId: pid });
    }

    console.log(`  ${o.invoiceNumber || o.id}: reposted ${paymentIds.length} payment entries`);
  }

  console.log("Done. Re-run pnpm db:diagnose-ar-mismatch to confirm.");
}

main()
  .catch((e) => {
    console.error("repair-ar-overpayments error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
