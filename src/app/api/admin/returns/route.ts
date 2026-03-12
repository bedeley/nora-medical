import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValid, parseISO, startOfDay, endOfDay } from "date-fns";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

type ReturnRow = {
  id: string;
  date: string;
  orderId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  itemLabel: string | null;
  quantity: number | null;
  refundTotal: number;
  refundDisposition: string | null;
  appliedToBalance: number;
  restock: boolean | null;
  rmaDisposition: string | null;
  returnReason: string | null;
  returnReasonNote: string | null;
  source: "PAYMENT" | "ORDER";
};

function parseMeta(note: string | null) {
  if (!note || !note.trim().startsWith("{")) return null;
  try {
    return JSON.parse(note) as {
      reference?: string;
      orderId?: string;
      appliedToBalance?: number;
      restockToStock?: boolean;
      refundDisposition?: string;
      disposition?: string;
      reason?: string;
      reasonNote?: string;
      item?: { id?: string; quantity?: number; lineRefund?: number };
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const q = (searchParams.get("q") || "").trim();
  const type = (searchParams.get("type") || "all").toLowerCase();
  const source = (searchParams.get("source") || "all").toUpperCase();
  const rmaDisposition = (searchParams.get("rmaDisposition") || "all").toUpperCase();

  const dateFilter: { gte?: Date; lte?: Date } = {};
  if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
  if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));

  const payments = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      createdAt: Object.keys(dateFilter).length ? dateFilter : undefined,
      note: { contains: "ITEM_RETURN" },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderId: true,
      amount: true,
      refundDisposition: true,
      note: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  });

  const paymentItemIds = payments
    .map((p) => parseMeta(p.note)?.item?.id)
    .filter((id): id is string => Boolean(id));

  const items = paymentItemIds.length
    ? await prisma.orderItem.findMany({
        where: { id: { in: paymentItemIds } },
        select: { id: true, product: { select: { name: true } } },
      })
    : [];
  const itemNameById = new Map(items.map((row) => [row.id, row.product?.name || "Item"]));

  const paymentRows: ReturnRow[] = payments.map((payment) => {
    const meta = parseMeta(payment.note);
    const refundDisposition =
      payment.refundDisposition ||
      (meta?.refundDisposition ? String(meta.refundDisposition).toUpperCase() : null);
    const orderId = payment.orderId || meta?.orderId || null;
    const itemId = meta?.item?.id;
    const itemLabel = itemId ? itemNameById.get(itemId) || null : null;
    const quantity = meta?.item?.quantity ? Number(meta.item.quantity) : null;
    const refundTotal = Number(meta?.item?.lineRefund ?? Math.abs(Number(payment.amount || 0)));
    const appliedToBalance = Number(meta?.appliedToBalance || 0);
    const restock = meta?.restockToStock ?? null;
    const rmaDisposition =
      meta?.disposition ||
      (restock === null ? null : restock ? "RESTOCK" : "SCRAP");
    const returnReason = meta?.reason ? String(meta.reason) : null;
    const returnReasonNote = meta?.reasonNote ? String(meta.reasonNote) : null;
    const effectiveDisposition =
      appliedToBalance > 0 && refundTotal - appliedToBalance <= 0.01
        ? "APPLIED"
        : refundDisposition;
    return {
      id: payment.id,
      date: payment.createdAt.toISOString(),
      orderId,
      customerName: payment.user?.name || null,
      customerEmail: payment.user?.email || null,
      itemLabel,
      quantity,
      refundTotal,
      refundDisposition: effectiveDisposition,
      appliedToBalance,
      restock,
      rmaDisposition,
      returnReason,
      returnReasonNote,
      source: "PAYMENT",
    };
  });

  const journalEntries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "ORDER",
      memo: { startsWith: "Return/refund -" },
      entryDate: Object.keys(dateFilter).length ? dateFilter : undefined,
    },
    orderBy: { entryDate: "desc" },
    include: {
      lines: { include: { account: true } },
    },
  });

  const orderIdsFromJournal = journalEntries
    .map((entry) => {
      const match = entry.memo?.match(/\(([^)]+)\)\s*$/);
      return match?.[1] || null;
    })
    .filter((id): id is string => Boolean(id));

  const orders = orderIdsFromJournal.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIdsFromJournal } },
        select: { id: true, user: { select: { name: true, email: true } } },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));

  const paymentKeys = new Set(
    paymentRows.map((row) =>
      `${row.orderId || ""}|${row.itemLabel || ""}|${row.refundTotal.toFixed(2)}`
    ),
  );

  const journalRows: ReturnRow[] = journalEntries.map((entry) => {
    const memo = entry.memo || "";
    const orderMatch = memo.match(/\(([^)]+)\)\s*$/);
    const labelMatch = memo.match(/^Return\/refund\s*-\s*(.*)\s+\(/);
    const orderId = orderMatch?.[1] || null;
    const order = orderId ? orderById.get(orderId) : null;
    const refundLine = entry.lines.find((line) => line.account.code === "4000" && Number(line.debit || 0) > 0);
    const inventoryLine = entry.lines.find((line) => line.account.code === "1200" && Number(line.debit || 0) > 0);
    const cashLine = entry.lines.find((line) => line.account.code === "1000" && Number(line.credit || 0) > 0);
    const storeCreditLine = entry.lines.find((line) => line.account.code === "2200" && Number(line.credit || 0) > 0);
    const arLine = entry.lines.find((line) => line.account.code === "1100" && Number(line.credit || 0) > 0);
    const refundTotal = Number(refundLine?.debit || 0);
    const restock = Boolean(inventoryLine);
    const rmaDisposition = restock ? "RESTOCK" : "SCRAP";
    const appliedToBalance = Number(arLine?.credit || 0);
    const refundDisposition = cashLine
      ? "CASH"
      : storeCreditLine
      ? "CREDIT"
      : appliedToBalance > 0
      ? "APPLIED"
      : "APPLIED";
    return {
      id: entry.id,
      date: entry.entryDate.toISOString(),
      orderId,
      customerName: order?.user?.name || null,
      customerEmail: order?.user?.email || null,
      itemLabel: labelMatch?.[1] || null,
      quantity: null,
      refundTotal,
      refundDisposition,
      appliedToBalance,
      restock,
      rmaDisposition,
      returnReason: null,
      returnReasonNote: null,
      source: "ORDER",
    };
  });

  const dedupedJournalRows = journalRows.filter((row) => {
    const key = `${row.orderId || ""}|${row.itemLabel || ""}|${row.refundTotal.toFixed(2)}`;
    return !paymentKeys.has(key);
  });

  let rows = [...paymentRows, ...dedupedJournalRows].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  if (q) {
    const term = q.toLowerCase();
    rows = rows.filter((row) =>
      [
        row.orderId,
        row.customerName,
        row.customerEmail,
        row.itemLabel,
        row.refundDisposition,
      ]
        .filter(Boolean)
        .some((val) => String(val).toLowerCase().includes(term)),
    );
  }

  const baseTotals = rows.reduce(
    (acc, row) => {
      acc.totalReturns += row.refundTotal;
      acc.totalApplied += row.appliedToBalance;
      const disposition = (row.refundDisposition || "").toLowerCase();
      if (disposition === "credit") {
        const issuedCredit = Math.max(0, row.refundTotal - row.appliedToBalance);
        acc.totalCredit += issuedCredit;
      }
      if (disposition === "cash") acc.totalCash += row.refundTotal;
      return acc;
    },
    { totalReturns: 0, totalApplied: 0, totalCredit: 0, totalCash: 0 },
  );

  if (type !== "all") {
    rows = rows.filter((row) => {
      const disposition = (row.refundDisposition || "").toLowerCase();
      if (type === "applied") return row.appliedToBalance > 0 || disposition === "applied";
      if (type === "cash") return disposition === "cash";
      if (type === "credit") return disposition === "credit";
      return true;
    });
  }

  if (source === "PAYMENT" || source === "ORDER") {
    rows = rows.filter((row) => row.source === source);
  }

  if (rmaDisposition !== "ALL") {
    rows = rows.filter((row) => String(row.rmaDisposition || "").toUpperCase() === rmaDisposition);
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.totalReturns += row.refundTotal;
      acc.totalApplied += row.appliedToBalance;
      const disposition = (row.refundDisposition || "").toLowerCase();
      if (disposition === "credit") {
        const issuedCredit = Math.max(0, row.refundTotal - row.appliedToBalance);
        acc.totalCredit += issuedCredit;
      }
      if (disposition === "cash") acc.totalCash += row.refundTotal;
      return acc;
    },
    { totalReturns: 0, totalApplied: 0, totalCredit: 0, totalCash: 0 },
  );

  const autoApplyWhere: Parameters<typeof prisma.payment.aggregate>[0]["where"] = {
    deletedAt: null,
    note: { contains: "\"reference\":\"AUTO_APPLY\"" },
    ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
  };
  if (q) {
    autoApplyWhere.OR = [
      { user: { name: { contains: q, mode: "insensitive" } } },
      { user: { email: { contains: q, mode: "insensitive" } } },
      { orderId: { contains: q, mode: "insensitive" } },
    ];
  }

  const autoApplySum = await prisma.payment.aggregate({
    where: autoApplyWhere,
    _sum: { amount: true },
  });
  const storeCreditUsed = Number(autoApplySum._sum.amount || 0);

  return NextResponse.json({
    rows,
    totals: { ...totals, storeCreditUsed },
    baseTotals,
    total: rows.length,
  });
}
