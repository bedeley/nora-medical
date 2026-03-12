import { prisma } from "@/lib/prisma";
import { getAccountCodes } from "@/lib/accounting-posting";

function fmt(value: number) {
  return value.toFixed(2);
}

async function main() {
  const inputs = process.argv.slice(2).filter(Boolean);
  if (!inputs.length) {
    console.log("Usage: pnpm db:inspect-order-ledger <invoiceOrOrderId> [more...]");
    return;
  }

  const accountCodes = await getAccountCodes();
  const codeSet = new Set([
    accountCodes.SALES,
    accountCodes.COGS,
    accountCodes.INVENTORY,
    accountCodes.AR,
    accountCodes.VAT_PAYABLE,
  ]);

  for (const input of inputs) {
    const order =
      (await prisma.order.findUnique({
        where: { id: input },
        select: { id: true, invoiceNumber: true, status: true, createdAt: true },
      })) ||
      (await prisma.order.findFirst({
        where: { invoiceNumber: input },
        select: { id: true, invoiceNumber: true, status: true, createdAt: true },
      }));

    if (!order) {
      console.log(`Order not found for input: ${input}`);
      continue;
    }

    console.log(`\nOrder ${order.invoiceNumber || order.id}`);
    console.log(`Status: ${order.status} | Created: ${order.createdAt.toISOString()}`);

    const entries = await prisma.journalEntry.findMany({
      where: { status: "POSTED", sourceType: "ORDER", sourceId: order.id },
      include: { lines: { include: { account: true } } },
      orderBy: { entryDate: "asc" },
    });

    if (!entries.length) {
      console.log("No posted ORDER journal entries.");
    } else {
      console.log(`Posted ORDER entries: ${entries.length}`);
      for (const entry of entries) {
        console.log(`- ${entry.id} | ${entry.entryDate.toISOString()} | ${entry.memo || ""}`);
        let sales = 0;
        let cogs = 0;
        let inventory = 0;
        let ar = 0;
        let vat = 0;
        for (const line of entry.lines) {
          if (!codeSet.has(line.account.code)) continue;
          const debit = Number(line.debit || 0);
          const credit = Number(line.credit || 0);
          if (line.account.code === accountCodes.SALES) sales += credit - debit;
          if (line.account.code === accountCodes.COGS) cogs += debit - credit;
          if (line.account.code === accountCodes.INVENTORY) inventory += debit - credit;
          if (line.account.code === accountCodes.AR) ar += debit - credit;
          if (line.account.code === accountCodes.VAT_PAYABLE) vat += credit - debit;
        }
        console.log(
          `  Sales ${fmt(sales)} | COGS ${fmt(cogs)} | Inventory ${fmt(inventory)} | AR ${fmt(ar)} | VAT ${fmt(vat)}`,
        );
      }
    }

    const payments = await prisma.payment.findMany({
      where: { orderId: order.id, deletedAt: null },
      select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    if (!payments.length) {
      console.log("Payments: none");
    } else {
      console.log("Payments:");
      for (const p of payments) {
        console.log(
          `  ${p.createdAt.toISOString()} | ${fmt(Number(p.amount || 0))} | ${p.status} | ${p.refundDisposition || "-"} | ${p.id} | ${String(p.note || "").slice(0, 80)}`,
        );
      }
    }
  }
}

main()
  .catch((err) => {
    console.error("Inspect order ledger error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
