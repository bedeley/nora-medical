import { prisma } from "@/lib/prisma";

type NetRow = {
  sourceType: string | null;
  sourceId: string | null;
  entryId: string;
  memo: string | null;
  net: number;
};

function round(n: number) {
  return Math.round(n * 100) / 100;
}

async function main() {
  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) {
    throw new Error("AR account (1100) not found");
  }

  const [orders, payments, lines] = await Promise.all([
    prisma.order.findMany({ select: { id: true } }),
    prisma.payment.findMany({ select: { id: true } }),
    prisma.journalLine.findMany({
      where: { accountId: arAccount.id, entry: { status: "POSTED" } },
      select: {
        debit: true,
        credit: true,
        entry: {
          select: {
            id: true,
            sourceType: true,
            sourceId: true,
            memo: true,
          },
        },
      },
    }),
  ]);

  const orderIds = new Set(orders.map((o) => o.id));
  const paymentIds = new Set(payments.map((p) => p.id));

  const netRows: NetRow[] = lines.map((l) => ({
    sourceType: l.entry?.sourceType ?? null,
    sourceId: l.entry?.sourceId ?? null,
    entryId: l.entry?.id ?? "",
    memo: l.entry?.memo ?? null,
    net: round(Number(l.debit || 0) - Number(l.credit || 0)),
  }));

  // Totals by sourceType
  const totals = new Map<string, number>();
  for (const r of netRows) {
    const key = r.sourceType ?? "UNKNOWN";
    totals.set(key, round((totals.get(key) ?? 0) + r.net));
  }

  // Identify orphans/missing links
  const orphans: NetRow[] = [];
  for (const r of netRows) {
    if (r.sourceType === "ORDER" && r.sourceId && !orderIds.has(r.sourceId)) {
      orphans.push(r);
    } else if (r.sourceType === "PAYMENT" && r.sourceId && !paymentIds.has(r.sourceId)) {
      orphans.push(r);
    } else if (!r.sourceType || r.sourceType === "MANUAL") {
      orphans.push(r);
    }
  }

  console.log("AR totals by sourceType:");
  for (const [k, v] of totals.entries()) {
    console.log(`  ${k}: ${v.toFixed(2)}`);
  }

  const arNet = netRows.reduce((s, r) => s + r.net, 0);
  console.log("\nAR net (all lines):", arNet.toFixed(2));

  if (orphans.length) {
    console.log("\nPotential orphan/adjustment AR entries (top 15 by absolute value):");
    orphans
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
      .slice(0, 15)
      .forEach((r) =>
        console.log({
          entryId: r.entryId,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          net: r.net.toFixed(2),
          memo: r.memo,
        }),
      );
  } else {
    console.log("\nNo orphan/adjustment AR entries detected.");
  }
}

main()
  .catch((e) => {
    console.error("ar-diff-breakdown error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
