import { prisma } from "@/lib/prisma";
import { setFeatureEnabled } from "@/lib/features";
import {
  postExpenseEntry,
  postOrderEntry,
  postPaymentEntry,
  postPurchaseEntry,
  postSupplierPaymentEntry,
} from "@/lib/accounting-posting";

async function main() {
  await setFeatureEnabled("accounting_auto_post", true);
  const orders = await prisma.order.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const payments = await prisma.payment.findMany({
    where: { deletedAt: null },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const expenses = await prisma.expense.findMany({
    where: { deletedAt: null },
    select: { id: true, amount: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const purchases = await prisma.purchase.findMany({
    where: { deletedAt: null },
    select: { id: true, unitCost: true, quantity: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const supplierPayments = await prisma.supplierPayment.findMany({
    where: { deletedAt: null, status: "NORMAL" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Backfilling ${orders.length} orders...`);
  for (const order of orders) {
    await postOrderEntry({ orderId: order.id });
  }

  console.log(`Backfilling ${payments.length} payments...`);
  for (const payment of payments) {
    const status = String(payment.status || "").toUpperCase();
    if (status === "REFUND" || status === "VOID") continue;
    await postPaymentEntry({ paymentId: payment.id });
  }

  console.log(`Backfilling ${expenses.length} expenses...`);
  for (const expense of expenses) {
    await postExpenseEntry({
      expenseId: expense.id,
      amount: Number(expense.amount || 0),
      createdAt: expense.createdAt,
    });
  }

  console.log(`Backfilling ${purchases.length} purchases...`);
  for (const purchase of purchases) {
    const amount =
      Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
    await postPurchaseEntry({
      purchaseId: purchase.id,
      amount,
      createdAt: purchase.createdAt,
      memo: "Backfilled purchase",
    });
  }

  console.log(`Backfilling ${supplierPayments.length} supplier payments...`);
  for (const payment of supplierPayments) {
    await postSupplierPaymentEntry({ supplierPaymentId: payment.id });
  }

  console.log("Accounting backfill complete.");
}

main()
  .catch((err) => {
    console.error("Backfill accounting error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
