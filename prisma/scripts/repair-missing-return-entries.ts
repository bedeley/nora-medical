import { prisma } from "@/lib/prisma";
import { postReturnEntry } from "@/lib/accounting-posting";
import { setFeatureEnabled } from "@/lib/features";

type ReturnMeta = {
  orderId?: string;
  refundMode?: "cash" | "credit";
  adjustmentAmount?: number;
  item?: { id?: string; lineRefund?: number; quantity?: number };
};

function parseMeta(note?: string | null): ReturnMeta | null {
  if (!note) return null;
  try {
    return JSON.parse(note) as ReturnMeta;
  } catch {
    return null;
  }
}

async function main() {
  await setFeatureEnabled("accounting_auto_post", true);

  const candidates = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      amount: 0,
      status: "NORMAL",
    },
    select: { id: true, orderId: true, note: true, createdAt: true },
  });

  let created = 0;
  let skipped = 0;
  let missing = 0;

  for (const payment of candidates) {
    const meta = parseMeta(payment.note);
    if (!meta?.adjustmentAmount || !meta.orderId || !meta.item?.id) {
      skipped += 1;
      continue;
    }

    const orderId = meta.orderId;
    const lineRefund = Number(meta.item.lineRefund || 0);
    const appliedToBalance = Number(meta.adjustmentAmount || 0);
    if (!(lineRefund > 0) || !(appliedToBalance > 0)) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.journalEntry.findFirst({
      where: {
        status: "POSTED",
        sourceType: "ORDER",
        sourceId: orderId,
        memo: { contains: "Return/refund" },
        entryDate: {
          gte: new Date(payment.createdAt.getTime() - 15 * 60 * 1000),
          lte: new Date(payment.createdAt.getTime() + 15 * 60 * 1000),
        },
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const orderItem = await prisma.orderItem.findUnique({
      where: { id: meta.item.id },
      include: { product: { select: { name: true, cost: true } } },
    });
    if (!orderItem) {
      missing += 1;
      continue;
    }

    const itemLabel = orderItem.product?.name || "Item";
    const refundMode = meta.refundMode === "credit" ? "credit" : "cash";

    await postReturnEntry({
      sourceType: "ORDER",
      sourceId: orderId,
      entryDate: payment.createdAt,
      orderId,
      itemLabel,
      refundAmount: lineRefund,
      appliedToBalance,
      refundMode,
      restock: false,
      cogsAmount: 0,
    });

    created += 1;
  }

  console.log(
    `Missing return entry repair complete. Created: ${created}, Skipped: ${skipped}, Missing items: ${missing}`
  );
}

main()
  .catch((err) => {
    console.error("Missing return entry repair error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
