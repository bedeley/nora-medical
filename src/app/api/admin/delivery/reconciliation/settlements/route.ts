import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type SettlementMeta = {
  settlementId?: string;
  settledAt?: string;
  receivedBy?: string;
  reference?: string | null;
  note?: string | null;
  orderCount?: number;
  totalBalance?: number;
  totalClaimed?: number;
};

type ConfirmMeta = {
  amount?: number;
  method?: string;
  reference?: string | null;
  claimCollectorName?: string | null;
  paymentPostingStatus?: string | null;
  paymentPostingError?: string | null;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SettlementMeta;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") || 25)));

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    select: {
      entityId: true,
      meta: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });

  const batchRows = logs.map((log) => {
      const meta = parseMeta(log.meta);
      return {
        sourceType: "SETTLEMENT_BATCH" as const,
        id: log.entityId,
        searchHint: null as string | null,
        settledAt: String(meta?.settledAt || log.createdAt.toISOString()),
        receivedBy: String(meta?.receivedBy || "").trim() || null,
        reference: String(meta?.reference || "").trim() || null,
        note: String(meta?.note || "").trim() || null,
        orderCount: Number(meta?.orderCount || 0),
        totalBalance: Number(meta?.totalBalance ?? meta?.totalClaimed ?? 0),
        actorName: log.actor?.name || null,
      };
    });

  const settlementIds = batchRows.map((row) => row.id);
  const [postedEntries, postAttempts] = await Promise.all([
    settlementIds.length
      ? prisma.journalEntry.findMany({
          where: { sourceType: "MANUAL", sourceId: { in: settlementIds }, status: "POSTED" },
          select: { id: true, sourceId: true, createdAt: true },
        })
      : Promise.resolve([]),
    settlementIds.length
      ? prisma.auditLog.findMany({
          where: {
            entityType: "DELIVERY_SETTLEMENT",
            entityId: { in: settlementIds },
            action: {
              in: [
                "DELIVERY_COLLECTION_SETTLEMENT_POST_ATTEMPT",
                "DELIVERY_COLLECTION_SETTLEMENT_POST_FAILED",
              ],
            },
          },
          select: { entityId: true, meta: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
  ]);
  const postedBySettlement = new Map<string, { journalEntryId: string; postedAt: string }>();
  for (const entry of postedEntries) {
    if (!entry.sourceId || postedBySettlement.has(entry.sourceId)) continue;
    postedBySettlement.set(entry.sourceId, {
      journalEntryId: entry.id,
      postedAt: entry.createdAt.toISOString(),
    });
  }
  const postAttemptErrorBySettlement = new Map<string, string>();
  for (const attempt of postAttempts) {
    if (postAttemptErrorBySettlement.has(attempt.entityId)) continue;
    const meta = parseMeta(attempt.meta) as Record<string, unknown> | null;
    const posted = Boolean(meta?.posted);
    if (posted) continue;
    const err = String(meta?.error || "").trim();
    if (err) postAttemptErrorBySettlement.set(attempt.entityId, err);
  }
  const enrichedBatchRows = batchRows.map((row) => {
    const posted = postedBySettlement.get(row.id);
    return {
      ...row,
      postingStatus: posted ? "POSTED" : "UNPOSTED",
      postingJournalId: posted?.journalEntryId || null,
      postingPostedAt: posted?.postedAt || null,
      postingError: postAttemptErrorBySettlement.get(row.id) || null,
    };
  });

  const confirmationLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "ORDER",
      action: "ORDER_DELIVERY_COLLECTION_CONFIRMED",
    },
    select: {
      entityId: true,
      meta: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  const orderIds = Array.from(new Set(confirmationLogs.map((row) => row.entityId)));
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, invoiceNumber: true },
      })
    : [];
  const invoiceByOrderId = new Map(orders.map((row) => [row.id, row.invoiceNumber || row.id]));
  const confirmationRows = confirmationLogs.map((log) => {
    const meta = parseMeta(log.meta) as ConfirmMeta | null;
    const amount = Number(meta?.amount || 0);
    const invoice = String(invoiceByOrderId.get(log.entityId) || log.entityId);
    const reference = String(meta?.reference || "").trim() || `Order ${invoice}`;
    const method = String(meta?.method || "").trim().toUpperCase() || null;
    const paymentPostingStatus = String(meta?.paymentPostingStatus || "").trim().toUpperCase();
    return {
      sourceType: "COLLECTION_CONFIRMATION" as const,
      id: `CONF-${log.entityId}-${log.createdAt.getTime()}`,
      searchHint: `${log.entityId} ${invoice}`.toLowerCase(),
      settledAt: log.createdAt.toISOString(),
      receivedBy: String(meta?.claimCollectorName || "").trim() || null,
      reference: method ? `${reference} (${method})` : reference,
      note: null,
      orderCount: 1,
      totalBalance: amount,
      actorName: log.actor?.name || null,
      postingStatus: paymentPostingStatus === "POSTED" ? ("POSTED" as const) : ("UNPOSTED" as const),
      postingJournalId: null,
      postingPostedAt: paymentPostingStatus === "POSTED" ? log.createdAt.toISOString() : null,
      postingError: String(meta?.paymentPostingError || "").trim() || null,
    };
  });

  const allRows = [...enrichedBatchRows, ...confirmationRows]
    .filter((row) => {
      if (!q) return true;
      return (
        row.id.toLowerCase().includes(q) ||
        String(row.searchHint || "").includes(q) ||
        String(row.receivedBy || "").toLowerCase().includes(q) ||
        String(row.reference || "").toLowerCase().includes(q) ||
        String(row.actorName || "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => new Date(b.settledAt).getTime() - new Date(a.settledAt).getTime());

  const total = allRows.length;
  const start = (page - 1) * pageSize;
  const items = allRows.slice(start, start + pageSize);

  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
    summary: {
      settlements: allRows.length,
      settledAmount: allRows.reduce((sum, row) => sum + row.totalBalance, 0),
      ordersCovered: allRows.reduce((sum, row) => sum + row.orderCount, 0),
      unpostedSettlements: allRows.filter((row) => row.postingStatus !== "POSTED").length,
    },
  });
}
