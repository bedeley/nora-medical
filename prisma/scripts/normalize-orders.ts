// @ts-nocheck
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

async function main() {
  const orders = await prisma.order.findMany({});
  let updates = 0;

  for (const o of orders) {
    const total = Number(o.total || 0);
    const status = o.status;
    const amountPaid = Number(o.amountPaid ?? 0);
    const balance = Number(o.balance ?? 0);

    // Skip cancellations — UI already excludes them from outstanding banners
    if (status === "CANCELLED") continue;

    let newAmountPaid = amountPaid;
    let newBalance = balance;
    let newStatus = status;

    if (status === "PAID") {
      newAmountPaid = total;
      newBalance = 0;
      newStatus = "PAID";
    } else if (status === "UNPAID") {
      newAmountPaid = 0;
      newBalance = total;
      newStatus = "UNPAID";
    } else {
      // Normalize partial/other statuses based on amounts
      newAmountPaid = clamp(amountPaid, 0, total);
      newBalance = Math.max(0, total - newAmountPaid);
      if (newAmountPaid >= total) newStatus = "PAID";
      else if (newAmountPaid <= 0) newStatus = "UNPAID";
      else newStatus = "PARTIALLY_PAID";
    }

    const changed =
      newAmountPaid !== amountPaid ||
      newBalance !== balance ||
      newStatus !== status;
    if (!changed) continue;

    await prisma.order.update({
      where: { id: o.id },
      data: {
        amountPaid: newAmountPaid,
        balance: newBalance,
        status: newStatus,
      },
    });
    updates++;
  }

  console.log(`Normalized ${updates} order(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
