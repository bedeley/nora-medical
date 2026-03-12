import { prisma } from "@/lib/prisma";

function formatAmount(value: number) {
  return value.toFixed(2);
}

async function main() {
  const orderIds = process.argv.slice(2).filter(Boolean);
  if (!orderIds.length) {
    console.log("Usage: pnpm db:diagnose-order-ledger <orderId> [orderId...]");
    return;
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      invoiceNumber: true,
      total: true,
      amountPaid: true,
      status: true,
      customerType: true,
    },
  });
  const orderMap = new Map(orders.map((order) => [order.id, order]));

  const payments = await prisma.payment.findMany({
    where: { orderId: { in: orderIds }, deletedAt: null },
    select: {
      id: true,
      orderId: true,
      amount: true,
      status: true,
      refundDisposition: true,
      createdAt: true,
      note: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const paymentIds = payments.map((payment) => payment.id);

  const journalEntries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      OR: [
        { sourceType: "ORDER", sourceId: { in: orderIds } },
        paymentIds.length
          ? { sourceType: "PAYMENT", sourceId: { in: paymentIds } }
          : { sourceType: "PAYMENT", sourceId: { in: [] } },
      ],
    },
    include: {
      lines: { include: { account: true } },
    },
    orderBy: { entryDate: "asc" },
  });

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  const arAccountId = arAccount?.id ?? null;

  for (const orderId of orderIds) {
    const order = orderMap.get(orderId);
    if (!order) {
      console.log(`Order ${orderId} not found.`);
      continue;
    }

    const label = order.invoiceNumber || order.id;
    const operationalAr = Math.max(
      0,
      Number(order.total || 0) - Number(order.amountPaid || 0),
    );

    const orderPayments = payments.filter((payment) => payment.orderId === orderId);
    const entryRows = journalEntries.filter((entry) => {
      if (entry.sourceType === "ORDER" && entry.sourceId === orderId) return true;
      if (entry.sourceType === "PAYMENT" && entry.sourceId) {
        return orderPayments.some((payment) => payment.id === entry.sourceId);
      }
      return false;
    });

    let ledgerAr = 0;
    if (arAccountId) {
      for (const entry of entryRows) {
        for (const line of entry.lines) {
          if (line.accountId !== arAccountId) continue;
          ledgerAr += Number(line.debit || 0) - Number(line.credit || 0);
        }
      }
    }

    console.log(`\n${label}`);
    console.log(
      `Status=${order.status} | customer=${order.customerType} | operational AR=${formatAmount(
        operationalAr,
      )} | ledger AR=${formatAmount(ledgerAr)}`,
    );

    if (orderPayments.length) {
      console.log("Payments:");
      for (const payment of orderPayments) {
        console.log(
          `  ${payment.createdAt.toISOString()} | ${formatAmount(
            Number(payment.amount || 0),
          )} | ${payment.status} | ${payment.refundDisposition || "-"} | ${payment.id}`,
        );
      }
    } else {
      console.log("Payments: none");
    }

    if (entryRows.length) {
      console.log("Journal entries:");
      for (const entry of entryRows) {
        console.log(
          `  ${entry.entryDate.toISOString()} | ${entry.sourceType} | ${entry.sourceId} | ${entry.memo}`,
        );
        const arLines = entry.lines.filter((line) => line.accountId === arAccountId);
        if (arLines.length) {
          for (const line of arLines) {
            console.log(
              `    AR line: Dr ${formatAmount(Number(line.debit || 0))} Cr ${formatAmount(
                Number(line.credit || 0),
              )}`,
            );
          }
        } else {
          console.log("    AR line: none");
        }
      }
    } else {
      console.log("Journal entries: none");
    }
  }
}

main()
  .catch((err) => {
    console.error("Order ledger diagnostic error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
