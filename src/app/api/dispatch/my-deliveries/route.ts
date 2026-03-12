import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type DispatchStatus =
  | "PENDING"
  | "ASSIGNED"
  | "OUT_FOR_DELIVERY"
  | "FAILED_ATTEMPT"
  | "RESCHEDULED"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED";

type AssignmentMeta = {
  assignmentId?: string;
  assignmentMode?: "FULL" | "PARTIAL";
  partialPercent?: number;
  assignedItems?: Array<{
    itemId: string;
    productName?: string;
    assignedQty: number;
    remainingQtyAtAssign?: number;
  }>;
  riderUserId?: string;
  riderName?: string;
  riderPhone?: string;
  note?: string;
  assignedAt?: string;
  createdAt?: string;
};

type DispatchMeta = {
  status?: DispatchStatus;
  reason?: string;
  note?: string;
  scheduledAt?: string;
  attemptAt?: string;
  updatedAt?: string;
  recipientName?: string;
  recipientPhone?: string;
  deliveryNote?: string;
  proofImageUrl?: string;
  createdAt?: string;
};

type CollectionClaimMeta = {
  amount?: number;
  method?: string;
  reference?: string;
  note?: string;
  status?: string;
  collectedAt?: string;
  collectorId?: string;
  collectorName?: string;
  collectorRole?: string;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePhone(v?: string | null) {
  return String(v || "").replace(/\D+/g, "");
}

function normalizeName(v?: string | null) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function deliveredNoClaimTtlMs() {
  const raw = Number(process.env.DISPATCH_DELIVERED_NOCLAIM_TTL_HOURS || 24);
  const hours = Number.isFinite(raw) && raw > 0 ? raw : 24;
  return hours * 60 * 60 * 1000;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  if (!session || !["DISPATCHER", "ADMIN", "STAFF"].includes(role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const historyQ = String(url.searchParams.get("historyQ") || "").trim().toLowerCase();
  const historyFrom = String(url.searchParams.get("historyFrom") || "").trim();
  const historyTo = String(url.searchParams.get("historyTo") || "").trim();
  const historyStatus = String(url.searchParams.get("historyStatus") || "DELIVERED").toUpperCase();
  const historyClaim = String(url.searchParams.get("historyClaim") || "ALL").toUpperCase();
  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      invoiceNumber: true,
      createdAt: true,
      total: true,
      amountPaid: true,
      balance: true,
      status: true,
      deliveryStatus: true,
      deliveredAt: true,
      customerType: true,
      walkInName: true,
      walkInPhone: true,
      items: {
        select: {
          id: true,
          quantity: true,
          deliveredQuantity: true,
          product: { select: { name: true } },
        },
      },
      user: { select: { id: true, name: true, phone: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const orderIds = orders.map((o) => o.id);
  const logs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: {
            in: [
              "ORDER_DELIVERY_ASSIGN",
              "ORDER_DELIVERY_UNASSIGN",
              "ORDER_DELIVERY_STATUS_UPDATE",
              "ORDER_DELIVERY_RETURN_PENDING",
              "ORDER_DELIVERY_RETURN_CONFIRMED",
              "ORDER_DELIVERY_COLLECTION_RECORDED",
              "ORDER_DELIVERY_COLLECTION_CONFIRMED",
            ],
          },
        },
        select: {
          entityId: true,
          actorId: true,
          action: true,
          meta: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const assignmentByOrder = new Map<string, AssignmentMeta>();
  const dispatchByOrder = new Map<string, DispatchMeta>();
  const collectionClaimByOrder = new Map<string, CollectionClaimMeta & { createdAt?: string }>();
  const collectionConfirmedAtByOrder = new Map<string, string>();
  const unassignAtByOrder = new Map<string, string>();
  const returnPendingAtByOrder = new Map<string, string>();
  const returnConfirmedAtByOrder = new Map<string, string>();
  for (const row of logs) {
    const meta = parseMeta(row.meta);
    if (row.action === "ORDER_DELIVERY_ASSIGN" && !assignmentByOrder.has(row.entityId)) {
      assignmentByOrder.set(row.entityId, {
        assignmentId: String(meta?.assignmentId || ""),
        assignmentMode: (String(meta?.assignmentMode || "").toUpperCase() as "FULL" | "PARTIAL") || "FULL",
        partialPercent: Number(meta?.partialPercent || 0) || undefined,
        assignedItems: Array.isArray(meta?.assignedItems)
          ? (meta?.assignedItems as Array<Record<string, unknown>>).map((it) => ({
              itemId: String(it.itemId || ""),
              productName: String(it.productName || ""),
              assignedQty: Number(it.assignedQty || 0),
              remainingQtyAtAssign: Number(it.remainingQtyAtAssign || 0),
            }))
          : undefined,
        riderUserId: String(meta?.riderUserId || ""),
        riderName: String(meta?.riderName || ""),
        riderPhone: String(meta?.riderPhone || ""),
        note: String(meta?.note || ""),
        assignedAt: String(meta?.assignedAt || row.createdAt.toISOString()),
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_STATUS_UPDATE" && !dispatchByOrder.has(row.entityId)) {
      dispatchByOrder.set(row.entityId, {
        status: String(meta?.status || "") as DispatchStatus,
        reason: String(meta?.reason || ""),
        note: String(meta?.note || ""),
        scheduledAt: String(meta?.scheduledAt || ""),
        recipientName: String(meta?.recipientName || ""),
        recipientPhone: String(meta?.recipientPhone || ""),
        deliveryNote: String(meta?.deliveryNote || ""),
        proofImageUrl: String(meta?.proofImageUrl || ""),
        attemptAt: String(meta?.attemptAt || row.createdAt.toISOString()),
        updatedAt: String(meta?.updatedAt || row.createdAt.toISOString()),
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_COLLECTION_RECORDED" && !collectionClaimByOrder.has(row.entityId)) {
      collectionClaimByOrder.set(row.entityId, {
        amount: Number(meta?.amount || 0),
        method: String(meta?.method || ""),
        reference: String(meta?.reference || ""),
        note: String(meta?.note || ""),
        status: String(meta?.status || ""),
        collectedAt: String(meta?.collectedAt || row.createdAt.toISOString()),
        collectorId: String(meta?.collectorId || ""),
        collectorName: String(meta?.collectorName || ""),
        collectorRole: String(meta?.collectorRole || ""),
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_COLLECTION_CONFIRMED" && !collectionConfirmedAtByOrder.has(row.entityId)) {
      collectionConfirmedAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
    if (row.action === "ORDER_DELIVERY_RETURN_PENDING" && !returnPendingAtByOrder.has(row.entityId)) {
      returnPendingAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
    if (row.action === "ORDER_DELIVERY_RETURN_CONFIRMED" && !returnConfirmedAtByOrder.has(row.entityId)) {
      returnConfirmedAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
    if (row.action === "ORDER_DELIVERY_UNASSIGN" && !unassignAtByOrder.has(row.entityId)) {
      unassignAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
  }

  const me = user?.id
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: { phone: true, name: true },
      })
    : null;
  const userPhone = normalizePhone(me?.phone || null);
  const userName = normalizeName(me?.name || user?.name || null);
  const deliveredNoClaimTtl = deliveredNoClaimTtlMs();
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  const defaultHistoryFrom = new Date(startOfToday);
  defaultHistoryFrom.setDate(defaultHistoryFrom.getDate() - 6);
  const historyFromMs = historyFrom
    ? new Date(`${historyFrom}T00:00:00.000`).getTime()
    : defaultHistoryFrom.getTime();
  const historyToMs = historyTo
    ? new Date(`${historyTo}T23:59:59.999`).getTime()
    : now;
  const mapped = orders
    .map((order) => {
      const assignmentRaw = assignmentByOrder.get(order.id) || null;
      const unassignAt = unassignAtByOrder.get(order.id);
      const assignment =
        assignmentRaw &&
        (!unassignAt || new Date(unassignAt).getTime() < new Date(String(assignmentRaw.createdAt || "")).getTime())
          ? assignmentRaw
          : null;
      const dispatch = dispatchByOrder.get(order.id) || null;
      const assignedToMe =
        role === "ADMIN" ||
        role === "STAFF" ||
        (!!assignment &&
          (String(assignment.riderUserId || "") === user?.id ||
            (userPhone && normalizePhone(assignment.riderPhone) === userPhone) ||
            (userName && normalizeName(assignment.riderName) === userName)));

      if (!assignedToMe) return null;

      const orderDeliveryStatus = String(order.deliveryStatus || "").toUpperCase();
      const assignmentAt = assignment?.createdAt ? new Date(assignment.createdAt).getTime() : 0;
      const dispatchAt = dispatch?.createdAt ? new Date(dispatch.createdAt).getTime() : 0;
      const assignmentIsNewer = assignmentAt > dispatchAt;
      // If admin reassigned after last trip status event, treat as a fresh ASSIGNED job.
      const dispatchStatus: DispatchStatus = assignmentIsNewer
        ? "ASSIGNED"
        : (dispatch?.status as DispatchStatus | undefined) ||
          (orderDeliveryStatus === "DELIVERED"
            ? "DELIVERED"
            : orderDeliveryStatus === "PARTIALLY_DELIVERED"
            ? "PARTIALLY_DELIVERED"
            : assignment
            ? "ASSIGNED"
            : "PENDING");
      const collectionClaim = collectionClaimByOrder.get(order.id) || null;
      const collectionConfirmedAt = collectionConfirmedAtByOrder.get(order.id) || null;
      const returnPendingAt = returnPendingAtByOrder.get(order.id) || null;
      const returnConfirmedAt = returnConfirmedAtByOrder.get(order.id) || null;
      const collectionClaimCreatedAt = collectionClaim?.createdAt
        ? new Date(collectionClaim.createdAt).getTime()
        : null;
      const returnPendingAtMs = returnPendingAt ? new Date(returnPendingAt).getTime() : null;
      const hasPendingCollectionClaim =
        collectionClaimCreatedAt !== null &&
        (!collectionConfirmedAt || new Date(collectionConfirmedAt).getTime() < collectionClaimCreatedAt);
      const hasConfirmedCollectionClaim =
        collectionClaimCreatedAt !== null &&
        Boolean(collectionConfirmedAt) &&
        new Date(String(collectionConfirmedAt)).getTime() >= collectionClaimCreatedAt;
      const hasReturnPending =
        returnPendingAtMs !== null &&
        (!returnConfirmedAt || new Date(returnConfirmedAt).getTime() < returnPendingAtMs) &&
        (!unassignAt || new Date(unassignAt).getTime() < returnPendingAtMs);
      const balance = Number(order.balance || 0);
      const deliveredAtMs = Number.isFinite(new Date(String(order.deliveredAt || "")).getTime())
        ? new Date(String(order.deliveredAt || "")).getTime()
        : dispatchAt > 0
        ? dispatchAt
        : 0;
      const deliveredWithinNoClaimTtl =
        deliveredAtMs > 0 && now - deliveredAtMs <= deliveredNoClaimTtl;

      const activeForDispatcher =
        dispatchStatus === "ASSIGNED" ||
        dispatchStatus === "OUT_FOR_DELIVERY" ||
        dispatchStatus === "PARTIALLY_DELIVERED" ||
        // Delivered jobs:
        // - drop immediately once claim is confirmed by admin;
        // - keep while claim is pending;
        // - if still unpaid and no claim yet, keep for a short grace window.
        // - fully paid with no pending claim should drop immediately.
        (dispatchStatus === "DELIVERED" &&
          !hasConfirmedCollectionClaim &&
          (hasPendingCollectionClaim || (balance > 0.01 && deliveredWithinNoClaimTtl)));
      const returnPendingActive =
        hasReturnPending &&
        (dispatchStatus === "FAILED_ATTEMPT" || dispatchStatus === "RESCHEDULED");
      const activeWithReturnPending = activeForDispatcher || returnPendingActive;
      const completedForDispatcherToday =
        dispatchStatus === "DELIVERED" &&
        !activeWithReturnPending &&
        deliveredAtMs >= startOfTodayMs;
      const hasAnyCollectionClaim = Boolean(collectionClaim?.createdAt);
      const claimState = hasPendingCollectionClaim
        ? "PENDING"
        : hasConfirmedCollectionClaim
        ? "CONFIRMED"
        : hasAnyCollectionClaim
        ? "RECORDED"
        : "NONE";
      const activityAtMs =
        dispatchStatus === "DELIVERED" && deliveredAtMs > 0
          ? deliveredAtMs
          : dispatchAt > 0
          ? dispatchAt
          : new Date(order.createdAt).getTime();

      return {
        id: order.id,
        invoiceNumber: order.invoiceNumber,
        createdAt: order.createdAt.toISOString(),
        total: Number(order.total || 0),
        amountPaid: Number(order.amountPaid || 0),
        balance,
        orderStatus: order.status,
        deliveryStatus: order.deliveryStatus,
        deliveredAt: order.deliveredAt?.toISOString() || null,
        dispatchStatus,
        pendingCollection: hasPendingCollectionClaim
          ? {
              amount: Number(collectionClaim?.amount || 0),
              method: String(collectionClaim?.method || ""),
              reference: String(collectionClaim?.reference || ""),
              note: String(collectionClaim?.note || ""),
              collectedAt: String(collectionClaim?.collectedAt || collectionClaim?.createdAt || ""),
              claimCreatedAt: String(collectionClaim?.createdAt || ""),
            }
          : null,
        returnPending: returnPendingActive,
        returnPendingAt: returnPendingActive ? returnPendingAt : null,
        assignment,
        dispatch,
        customer: order.user
          ? {
              id: order.user.id,
              name: order.user.name,
              phone: order.user.phone,
              email: order.user.email,
            }
          : {
              id: null,
              name: order.walkInName,
              phone: order.walkInPhone,
              email: null,
            },
        items: (order.items || []).map((it) => ({
          id: it.id,
          name: it.product?.name || "Item",
          quantity: Number(it.quantity || 0),
          deliveredQuantity: Number(it.deliveredQuantity || 0),
        })),
        activeForDispatcher: activeWithReturnPending,
        completedForDispatcherToday,
        claimState,
        activityAtMs,
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    invoiceNumber: string | null;
    createdAt: string;
    total: number;
    amountPaid: number;
    balance: number;
    orderStatus: string;
    deliveryStatus: string | null;
    deliveredAt: string | null;
    dispatchStatus: DispatchStatus;
    pendingCollection: {
      amount: number;
      method: string;
      reference: string;
      note: string;
      collectedAt: string;
      claimCreatedAt: string;
    } | null;
    assignment: AssignmentMeta | null;
    dispatch: DispatchMeta | null;
    customer: { id: string | null; name: string | null; phone: string | null; email: string | null };
    items: Array<{ id: string; name: string; quantity: number; deliveredQuantity: number }>;
    activeForDispatcher: boolean;
    completedForDispatcherToday: boolean;
    claimState: "NONE" | "PENDING" | "CONFIRMED" | "RECORDED";
    activityAtMs: number;
  }>;

  const textMatch = (r: {
    invoiceNumber: string | null;
    customer: { name: string | null; phone: string | null };
    dispatchStatus: DispatchStatus;
    orderStatus: string;
  }) => {
    if (!q) return true;
    const hay = [
      r.invoiceNumber,
      r.customer.name,
      r.customer.phone,
      r.dispatchStatus,
      r.orderStatus,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };

  const active = mapped
    .filter((r) => r.activeForDispatcher)
    .filter((r) => textMatch(r));
  const completedToday = mapped
    .filter((r) => r.completedForDispatcherToday)
    .filter((r) => textMatch(r));
  const historyTextMatch = (r: {
    invoiceNumber: string | null;
    customer: { name: string | null; phone: string | null };
    dispatchStatus: DispatchStatus;
    orderStatus: string;
  }) => {
    if (!historyQ) return true;
    const hay = [
      r.invoiceNumber,
      r.customer.name,
      r.customer.phone,
      r.dispatchStatus,
      r.orderStatus,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(historyQ);
  };
  const historyItems = mapped
    .filter((r) => !r.activeForDispatcher)
    .filter((r) =>
      historyStatus === "ALL"
        ? true
        : String(r.dispatchStatus || "").toUpperCase() === historyStatus,
    )
    .filter((r) => {
      if (historyClaim === "ALL") return true;
      return String(r.claimState || "").toUpperCase() === historyClaim;
    })
    .filter((r) => (Number.isFinite(r.activityAtMs) ? r.activityAtMs >= historyFromMs && r.activityAtMs <= historyToMs : false))
    .filter((r) => historyTextMatch(r))
    .sort((a, b) => b.activityAtMs - a.activityAtMs)
    .slice(0, 200);

  const stripInternalFields = <
    T extends {
      activeForDispatcher?: boolean;
      completedForDispatcherToday?: boolean;
      claimState?: string;
      activityAtMs?: number;
    },
  >(
    row: T,
  ) => {
    const next = { ...row };
    delete next.activeForDispatcher;
    delete next.completedForDispatcherToday;
    delete next.claimState;
    delete next.activityAtMs;
    return next;
  };

  return NextResponse.json({
    items: active.map(stripInternalFields),
    completedToday: completedToday.map(stripInternalFields),
    historyItems: historyItems.map(stripInternalFields),
  });
}
