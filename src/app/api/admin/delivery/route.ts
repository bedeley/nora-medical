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
};

type DispatchMeta = {
  status?: DispatchStatus;
  reason?: string;
  note?: string;
  scheduledAt?: string;
  attemptAt?: string;
  updatedAt?: string;
  podRequired?: boolean;
  recipientName?: string;
  recipientPhone?: string;
  deliveryNote?: string;
  proofImageUrl?: string;
};

type PaymentMeta = {
  method?: string;
  provider?: string;
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

type TimelineEvent = {
  at: string;
  action: string;
  actorName?: string | null;
  summary: string;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
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
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  const statusFilter = (searchParams.get("status") || "ALL").toUpperCase();
  const attentionOnly = searchParams.get("attentionOnly") === "1";
  const podMissingOnly = searchParams.get("podMissingOnly") === "1";
  const dateFrom = String(searchParams.get("dateFrom") || "").trim();
  const dateTo = String(searchParams.get("dateTo") || "").trim();
  const customerTypeFilter = String(searchParams.get("customerType") || "ALL").toUpperCase();
  const orderStatusFilter = String(searchParams.get("orderStatus") || "ALL").toUpperCase();
  const collectionStateFilter = String(searchParams.get("collectionState") || "ALL").toUpperCase();
  const assignmentScopeFilter = String(searchParams.get("assignmentScope") || "ALL").toUpperCase();
  const fulfillmentFilter = String(searchParams.get("fulfillment") || "OPEN").toUpperCase();
  const riderQuery = String(searchParams.get("rider") || "").trim().toLowerCase();
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") || 25)));

  const createdAt: { gte?: Date; lte?: Date } = {};
  if (dateFrom) {
    const from = new Date(`${dateFrom}T00:00:00.000`);
    if (!Number.isNaN(from.getTime())) createdAt.gte = from;
  }
  if (dateTo) {
    const to = new Date(`${dateTo}T23:59:59.999`);
    if (!Number.isNaN(to.getTime())) createdAt.lte = to;
  }

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELLED" },
      ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
      ...(q
        ? {
            OR: [
              { invoiceNumber: { contains: q, mode: "insensitive" } },
              { walkInName: { contains: q, mode: "insensitive" } },
              { walkInPhone: { contains: q, mode: "insensitive" } },
              { user: { is: { name: { contains: q, mode: "insensitive" } } } },
              { user: { is: { phone: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
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
      payments: {
        where: { deletedAt: null },
        select: { amount: true, status: true, note: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
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
    take: 400,
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
          action: true,
          meta: true,
          createdAt: true,
          actor: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const assignmentByOrder = new Map<string, AssignmentMeta & { actorName?: string; createdAt?: string }>();
  const dispatchByOrder = new Map<string, DispatchMeta & { actorName?: string; createdAt?: string }>();
  const collectionClaimByOrder = new Map<
    string,
    CollectionClaimMeta & { actorName?: string; createdAt?: string }
  >();
  const collectionConfirmedAtByOrder = new Map<string, string>();
  const unassignAtByOrder = new Map<string, string>();
  const returnPendingByOrder = new Map<
    string,
    { createdAt: string; assignmentId?: string | null; riderName?: string | null }
  >();
  const returnConfirmedAtByOrder = new Map<string, string>();
  const timelineByOrder = new Map<string, TimelineEvent[]>();
  const failedAttemptsByOrder = new Map<string, number>();
  const lastFailureByOrder = new Map<string, { reason?: string; createdAt: string }>();
  const nextScheduledByOrder = new Map<string, string>();
  for (const row of logs) {
    const meta = parseMeta(row.meta);
    const timeline = timelineByOrder.get(row.entityId) || [];
    if (timeline.length < 12) {
      let summary = row.action;
      if (row.action === "ORDER_DELIVERY_ASSIGN") {
        summary = `Assigned to ${String(meta?.riderName || "rider")}`;
      } else if (row.action === "ORDER_DELIVERY_UNASSIGN") {
        summary = `Unassigned${String(meta?.reason || "").trim() ? ` (${String(meta?.reason)})` : ""}`;
      } else if (row.action === "ORDER_DELIVERY_STATUS_UPDATE") {
        summary = `Status: ${String(meta?.status || "").replaceAll("_", " ").toLowerCase()}`;
      } else if (row.action === "ORDER_DELIVERY_COLLECTION_RECORDED") {
        summary = `Claim recorded: ${Number(meta?.amount || 0)}`;
      } else if (row.action === "ORDER_DELIVERY_COLLECTION_CONFIRMED") {
        summary = `Claim confirmed`;
      } else if (row.action === "ORDER_DELIVERY_RETURN_PENDING") {
        summary = `Return pending handover`;
      } else if (row.action === "ORDER_DELIVERY_RETURN_CONFIRMED") {
        summary = `Return received by admin`;
      }
      timeline.push({
        at: row.createdAt.toISOString(),
        action: row.action,
        actorName: row.actor?.name || null,
        summary,
      });
      timelineByOrder.set(row.entityId, timeline);
    }
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
        actorName: row.actor?.name || null || undefined,
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_UNASSIGN" && !unassignAtByOrder.has(row.entityId)) {
      unassignAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
    if (row.action === "ORDER_DELIVERY_RETURN_PENDING" && !returnPendingByOrder.has(row.entityId)) {
      returnPendingByOrder.set(row.entityId, {
        createdAt: row.createdAt.toISOString(),
        assignmentId: String(meta?.assignmentId || "").trim() || null,
        riderName: String(meta?.riderName || "").trim() || null,
      });
    }
    if (row.action === "ORDER_DELIVERY_RETURN_CONFIRMED" && !returnConfirmedAtByOrder.has(row.entityId)) {
      returnConfirmedAtByOrder.set(row.entityId, row.createdAt.toISOString());
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
        actorName: row.actor?.name || null || undefined,
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_COLLECTION_CONFIRMED" && !collectionConfirmedAtByOrder.has(row.entityId)) {
      collectionConfirmedAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
    if (row.action === "ORDER_DELIVERY_STATUS_UPDATE" && !dispatchByOrder.has(row.entityId)) {
      dispatchByOrder.set(row.entityId, {
        status: String(meta?.status || "") as DispatchStatus,
        reason: String(meta?.reason || ""),
        note: String(meta?.note || ""),
        scheduledAt: String(meta?.scheduledAt || ""),
        podRequired: Boolean(meta?.podRequired),
        recipientName: String(meta?.recipientName || ""),
        recipientPhone: String(meta?.recipientPhone || ""),
        deliveryNote: String(meta?.deliveryNote || ""),
        proofImageUrl: String(meta?.proofImageUrl || ""),
        attemptAt: String(meta?.attemptAt || row.createdAt.toISOString()),
        updatedAt: String(meta?.updatedAt || row.createdAt.toISOString()),
        actorName: row.actor?.name || null || undefined,
        createdAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_STATUS_UPDATE") {
      const status = String(meta?.status || "") as DispatchStatus;
      if (status === "FAILED_ATTEMPT") {
        failedAttemptsByOrder.set(row.entityId, (failedAttemptsByOrder.get(row.entityId) || 0) + 1);
        if (!lastFailureByOrder.has(row.entityId)) {
          lastFailureByOrder.set(row.entityId, {
            reason: String(meta?.reason || "") || undefined,
            createdAt: row.createdAt.toISOString(),
          });
        }
      }
      if (status === "RESCHEDULED" && !nextScheduledByOrder.has(row.entityId)) {
        const scheduledAt = String(meta?.scheduledAt || "").trim();
        if (scheduledAt) {
          nextScheduledByOrder.set(row.entityId, scheduledAt);
        }
      }
    }
  }

  const now = Date.now();
  const rows = orders
    .map((order) => {
      const assignmentRaw = assignmentByOrder.get(order.id) || null;
      const unassignAt = unassignAtByOrder.get(order.id);
      const assignment =
        assignmentRaw &&
        (!unassignAt || new Date(unassignAt).getTime() < new Date(String(assignmentRaw.createdAt || "")).getTime())
          ? assignmentRaw
          : null;
      const dispatch = dispatchByOrder.get(order.id) || null;
      const failedAttempts = failedAttemptsByOrder.get(order.id) || 0;
      const collectionClaim = collectionClaimByOrder.get(order.id) || null;
      const collectionConfirmedAt = collectionConfirmedAtByOrder.get(order.id) || null;
      const returnPending = returnPendingByOrder.get(order.id) || null;
      const returnConfirmedAt = returnConfirmedAtByOrder.get(order.id) || null;
      const collectionClaimCreatedAt = collectionClaim?.createdAt
        ? new Date(collectionClaim.createdAt).getTime()
        : null;
      const returnPendingCreatedAt = returnPending?.createdAt
        ? new Date(returnPending.createdAt).getTime()
        : null;
      const hasPendingCollectionClaim =
        collectionClaimCreatedAt !== null &&
        (!collectionConfirmedAt || new Date(collectionConfirmedAt).getTime() < collectionClaimCreatedAt);
      const hasReturnPending =
        returnPendingCreatedAt !== null &&
        (!returnConfirmedAt || new Date(returnConfirmedAt).getTime() < returnPendingCreatedAt) &&
        (!unassignAt || new Date(unassignAt).getTime() < returnPendingCreatedAt);
      const lastFailure = lastFailureByOrder.get(order.id) || null;
      const nextScheduledAt = nextScheduledByOrder.get(order.id) || dispatch?.scheduledAt || null;
      const dispatchStatus: DispatchStatus =
        String(order.deliveryStatus || "").toUpperCase() === "DELIVERED"
          ? "DELIVERED"
          : String(order.deliveryStatus || "").toUpperCase() === "PARTIALLY_DELIVERED"
          ? "PARTIALLY_DELIVERED"
          : (dispatch?.status as DispatchStatus | undefined) || (assignment ? "ASSIGNED" : "PENDING");
      const overdueReschedule =
        dispatchStatus === "RESCHEDULED" &&
        !!nextScheduledAt &&
        Number.isFinite(new Date(nextScheduledAt).getTime()) &&
        new Date(nextScheduledAt).getTime() <= now;
      const netPaid = Number(order.amountPaid || 0);
      const total = Number(order.total || 0);
      const balance = Number(order.balance || 0);
      const paymentEvents = (order.payments || []).map((p) => {
        const metaRaw = parseMeta(p.note) as PaymentMeta | null;
        return {
          amount: Number(p.amount || 0),
          status: String(p.status || "").toUpperCase(),
          method: String(metaRaw?.method || ""),
          provider: String(metaRaw?.provider || ""),
          createdAt: p.createdAt.toISOString(),
        };
      });
      const latestPayment = paymentEvents[0] || null;
      const cashCollectionStatus =
        balance <= 0.01
          ? "PAID_FULL"
          : netPaid > 0
          ? "PARTIAL_COLLECTED"
          : dispatchStatus === "DELIVERED" || dispatchStatus === "PARTIALLY_DELIVERED"
          ? "DELIVERED_UNPAID"
          : "UNPAID";
      const dispatchManaged =
        Boolean(assignment) ||
        Boolean(dispatch) ||
        dispatchStatus === "ASSIGNED" ||
        dispatchStatus === "OUT_FOR_DELIVERY" ||
        dispatchStatus === "FAILED_ATTEMPT" ||
        dispatchStatus === "RESCHEDULED";
      const podMissing =
        Boolean(dispatch?.podRequired) &&
        dispatchManaged &&
        (dispatchStatus === "DELIVERED" || dispatchStatus === "PARTIALLY_DELIVERED") &&
        !String(dispatch?.recipientName || "").trim() &&
        !String(dispatch?.recipientPhone || "").trim() &&
        !String(dispatch?.proofImageUrl || "").trim();
      const needsAttention =
        dispatchStatus === "FAILED_ATTEMPT" ||
        overdueReschedule ||
        cashCollectionStatus === "DELIVERED_UNPAID" ||
        podMissing ||
        hasPendingCollectionClaim ||
        hasReturnPending;
      const fullyDelivered =
        String(order.deliveryStatus || "").toUpperCase() === "DELIVERED" ||
        (order.items || []).every(
          (it) => Number(it.deliveredQuantity || 0) >= Number(it.quantity || 0),
        );
      return {
        id: order.id,
        invoiceNumber: order.invoiceNumber,
        createdAt: order.createdAt.toISOString(),
        total,
        amountPaid: netPaid,
        balance,
        orderStatus: order.status,
        deliveryStatus: order.deliveryStatus,
        deliveredAt: order.deliveredAt?.toISOString() || null,
        dispatchStatus,
        failedAttempts,
        lastFailureReason: lastFailure?.reason || null,
        lastFailureAt: lastFailure?.createdAt || null,
        nextScheduledAt,
        needsAttention,
        podMissing,
        cashCollectionStatus,
        latestPaymentMethod: latestPayment?.method || null,
        latestPaymentProvider: latestPayment?.provider || null,
        latestPaymentAt: latestPayment?.createdAt || null,
        paymentEvents,
        pendingCollection: hasPendingCollectionClaim
          ? {
              amount: Number(collectionClaim?.amount || 0),
              method: String(collectionClaim?.method || ""),
              reference: String(collectionClaim?.reference || ""),
              note: String(collectionClaim?.note || ""),
              collectedAt: String(collectionClaim?.collectedAt || collectionClaim?.createdAt || ""),
              collectorName: String(collectionClaim?.collectorName || collectionClaim?.actorName || ""),
              collectorRole: String(collectionClaim?.collectorRole || ""),
              claimCreatedAt: String(collectionClaim?.createdAt || ""),
            }
          : null,
        items: (order.items || []).map((it) => ({
          id: it.id,
          name: it.product?.name || "Item",
          quantity: Number(it.quantity || 0),
          deliveredQuantity: Number(it.deliveredQuantity || 0),
        })),
        customerType: order.customerType,
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
        assignment,
        returnPending: hasReturnPending,
        returnPendingAt: hasReturnPending ? String(returnPending?.createdAt || "") : null,
        dispatch,
        timelineRecent: timelineByOrder.get(order.id) || [],
        fullyDelivered,
      };
    })
    .filter((row) => statusFilter === "ALL" || row.dispatchStatus === statusFilter)
    .filter((row) => (attentionOnly ? row.needsAttention : true))
    .filter((row) => (podMissingOnly ? row.podMissing : true))
    .filter((row) => customerTypeFilter === "ALL" || String(row.customerType || "").toUpperCase() === customerTypeFilter)
    .filter((row) => orderStatusFilter === "ALL" || String(row.orderStatus || "").toUpperCase() === orderStatusFilter)
    .filter((row) => {
      if (collectionStateFilter === "ALL") return true;
      if (collectionStateFilter === "CLAIM_PENDING") return Boolean(row.pendingCollection);
      return String(row.cashCollectionStatus || "").toUpperCase() === collectionStateFilter;
    })
    .filter((row) => {
      if (assignmentScopeFilter === "ALL") return true;
      if (assignmentScopeFilter === "UNASSIGNED") return !row.assignment;
      if (assignmentScopeFilter === "FULL" || assignmentScopeFilter === "PARTIAL") {
        return String(row.assignment?.assignmentMode || "").toUpperCase() === assignmentScopeFilter;
      }
      return true;
    })
    .filter((row) => {
      if (fulfillmentFilter === "ALL") return true;
      if (fulfillmentFilter === "OPEN") {
        // Keep fulfilled-but-uncollected rows visible by default so admin can
        // confirm/record collections even after delivery is complete.
        const hasCollectionWork = Boolean(row.pendingCollection) || Number(row.balance || 0) > 0.01;
        return !row.fullyDelivered || hasCollectionWork;
      }
      if (fulfillmentFilter === "FULLY_DELIVERED") return row.fullyDelivered;
      return true;
    })
    .filter((row) => {
      if (!riderQuery) return true;
      const hay = [
        row.assignment?.riderName || "",
        row.assignment?.riderPhone || "",
        row.assignment?.actorName || "",
      ]
        .join(" ")
          .toLowerCase();
      return hay.includes(riderQuery);
    });

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const paged = rows.slice(start, start + pageSize);

  return NextResponse.json({
    items: paged,
    total,
    page,
    pageSize,
    summary: {
      pending: rows.filter((r) => r.dispatchStatus === "PENDING").length,
      assigned: rows.filter((r) => r.dispatchStatus === "ASSIGNED").length,
      outForDelivery: rows.filter((r) => r.dispatchStatus === "OUT_FOR_DELIVERY").length,
      failedAttempt: rows.filter((r) => r.dispatchStatus === "FAILED_ATTEMPT").length,
      rescheduled: rows.filter((r) => r.dispatchStatus === "RESCHEDULED").length,
      partiallyDelivered: rows.filter((r) => r.dispatchStatus === "PARTIALLY_DELIVERED").length,
      delivered: rows.filter((r) => r.dispatchStatus === "DELIVERED").length,
      needsAttention: rows.filter((r) => r.needsAttention).length,
      podMissing: rows.filter((r) => r.podMissing).length,
      collectionPending: rows.filter((r) => r.cashCollectionStatus !== "PAID_FULL").length,
      collectionClaimsPending: rows.filter((r) => Boolean(r.pendingCollection)).length,
    },
  });
}
