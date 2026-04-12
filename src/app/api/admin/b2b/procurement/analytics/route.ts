import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

type ProcurementRequestSnapshot = {
  id: string;
  customerId: string;
  requestType: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER";
  status: "SUBMITTED" | "IN_REVIEW" | "QUOTED" | "APPROVED" | "REJECTED" | "CLOSED";
  clinicName: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  notes: string | null;
  poDocumentUrl: string | null;
  templateId: string | null;
  itemsText: string | null;
  accountManagerId: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseSnapshot(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: ProcurementRequestSnapshot };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

function parseItemRefs(itemsText: string | null | undefined) {
  if (!itemsText) return [];
  return itemsText
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[\-\*\u2022]\s*/, ""))
    .filter(Boolean)
    .map((line) => {
      const m =
        line.match(/^(.*?)[\s:,\-xX]+\s*(\d+(?:\.\d+)?)\s*(?:units?|pcs?|boxes?)?$/i) ||
        line.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\)$/);
      return (m?.[1] || line).trim().toLowerCase();
    })
    .filter(Boolean);
}

/** Group requests by YYYY-MM and count totals and outcomes */
function buildMonthlyTrend(
  requestRows: Array<{ createdAt: string; status: string }>,
): Array<{ month: string; submitted: number; approved: number; rejected: number; closed: number }> {
  const trendMap = new Map<
    string,
    { submitted: number; approved: number; rejected: number; closed: number }
  >();
  for (const row of requestRows) {
    const month = row.createdAt.slice(0, 7); // "YYYY-MM"
    const entry = trendMap.get(month) ?? {
      submitted: 0,
      approved: 0,
      rejected: 0,
      closed: 0,
    };
    entry.submitted++;
    if (row.status === "APPROVED") entry.approved++;
    if (row.status === "REJECTED") entry.rejected++;
    if (row.status === "CLOSED") entry.closed++;
    trendMap.set(month, entry);
  }
  return Array.from(trendMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, counts]) => ({ month, ...counts }));
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

  const url = new URL(req.url);
  const startDate = url.searchParams.get("start")?.trim() || "";
  const endDate = url.searchParams.get("end")?.trim() || "";
  const startMs = startDate ? new Date(startDate + "T00:00:00.000Z").getTime() : null;
  const endMs = endDate ? new Date(endDate + "T23:59:59.999Z").getTime() : null;

  const LOG_LIMIT = 10000;
  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
          "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
        ],
      },
    },
    select: { entityId: true, action: true, createdAt: true, meta: true },
    orderBy: [{ entityId: "asc" }, { createdAt: "asc" }],
    take: LOG_LIMIT,
  });

  // Warn callers if the query hit the hard cap; analytics will be incomplete.
  const truncated = logs.length >= LOG_LIMIT;

  type EventRow = {
    createdAt: Date;
    action: string;
    snapshot: ProcurementRequestSnapshot | null;
  };
  const grouped = new Map<string, EventRow[]>();
  for (const log of logs) {
    const row: EventRow = {
      createdAt: log.createdAt,
      action: log.action,
      snapshot: parseSnapshot(log.meta),
    };
    const list = grouped.get(log.entityId) || [];
    list.push(row);
    grouped.set(log.entityId, list);
  }

  const now = Date.now();
  const statusCounts: Record<string, number> = {};
  const requestTypeCounts: Record<string, number> = {};
  let openCount = 0;
  let unassignedOpenCount = 0;
  const firstAssignmentHours: number[] = [];
  const timeToQuotedHours: number[] = [];
  const timeToApprovedHours: number[] = [];
  let draftEligibleCount = 0;
  let convertedToDraftCount = 0;
  const topRefs = new Map<string, number>();
  const requestRows: Array<{
    id: string;
    status: string;
    requestType: string;
    clinicName: string;
    ageDays: number;
    hasAssignment: boolean;
    accountManagerId: string | null;
    createdAt: string;
  }> = [];

  for (const [id, events] of grouped.entries()) {
    const created = events.find((e) => e.action === "B2B_PROCUREMENT_REQUEST_CREATED");
    if (!created?.snapshot) continue;
    const latestSnapshot = [...events]
      .reverse()
      .map((event) => event.snapshot)
      .find((snapshot): snapshot is ProcurementRequestSnapshot => Boolean(snapshot));
    if (!latestSnapshot) continue;

    // Apply date range filter using the request's original creation time.
    const createdAtMs = new Date(latestSnapshot.createdAt).getTime();
    if (startMs !== null && createdAtMs < startMs) continue;
    if (endMs !== null && createdAtMs > endMs) continue;

    const status = latestSnapshot.status;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    requestTypeCounts[latestSnapshot.requestType] =
      (requestTypeCounts[latestSnapshot.requestType] || 0) + 1;

    const ageDays = Math.max(0, Math.round(((now - createdAtMs) / 1000 / 3600 / 24) * 10) / 10);

    const isOpen = !["REJECTED", "CLOSED"].includes(status);
    if (isOpen) {
      openCount += 1;
      if (!latestSnapshot.accountManagerId) {
        unassignedOpenCount += 1;
      }
    }

    const hasAssignment = Boolean(latestSnapshot.accountManagerId);
    const everDraftEligible =
      ["QUOTED", "APPROVED"].includes(status) ||
      events.some((event) => event.action === "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED") ||
      events.some((event) => {
        if (event.action !== "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED") return false;
        return event.snapshot?.status === "QUOTED" || event.snapshot?.status === "APPROVED";
      });
    if (everDraftEligible) draftEligibleCount += 1;

    const assignmentEvent = events.find(
      (event) => event.action === "B2B_PROCUREMENT_REQUEST_ASSIGNED",
    );
    if (assignmentEvent) {
      firstAssignmentHours.push(
        (assignmentEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600,
      );
    }

    const quotedEvent = events.find((event) => {
      if (event.action !== "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED") return false;
      return event.snapshot?.status === "QUOTED";
    });
    if (quotedEvent) {
      timeToQuotedHours.push(
        (quotedEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600,
      );
    }

    const approvedEvent = events.find((event) => {
      if (event.action !== "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED") return false;
      return event.snapshot?.status === "APPROVED";
    });
    if (approvedEvent) {
      timeToApprovedHours.push(
        (approvedEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600,
      );
    }

    if (
      events.some((event) => event.action === "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED")
    ) {
      convertedToDraftCount += 1;
    }

    for (const ref of parseItemRefs(latestSnapshot.itemsText)) {
      topRefs.set(ref, (topRefs.get(ref) || 0) + 1);
    }

    requestRows.push({
      id,
      status,
      requestType: latestSnapshot.requestType,
      clinicName: latestSnapshot.clinicName,
      ageDays,
      hasAssignment,
      accountManagerId: latestSnapshot.accountManagerId || null,
      createdAt: latestSnapshot.createdAt,
    });
  }

  const totalRequests = requestRows.length;
  const draftDenominator = draftEligibleCount > 0 ? draftEligibleCount : 1;
  const avg = (values: number[]) =>
    values.length
      ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
      : null;
  const topRequested = Array.from(topRefs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([itemRef, count]) => ({ itemRef, count }));
  const oldestOpen = requestRows
    .filter((row) => !["REJECTED", "CLOSED"].includes(row.status))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 20);

  // ── Manager workload ────────────────────────────────────────────────────────
  const managerIdSet = new Set<string>();
  for (const row of requestRows) {
    if (row.accountManagerId) managerIdSet.add(row.accountManagerId);
  }
  const managerUsers =
    managerIdSet.size > 0
      ? await prisma.user.findMany({
          where: { id: { in: Array.from(managerIdSet) } },
          select: { id: true, name: true, email: true },
        })
      : [];
  const managerNameMap = new Map(
    managerUsers.map((u) => [u.id, u.name ?? u.email ?? u.id]),
  );

  const managerWorkloadMap = new Map<
    string,
    { openCount: number; inReviewCount: number; quotedCount: number }
  >();
  for (const row of requestRows.filter((r) => !["REJECTED", "CLOSED"].includes(r.status))) {
    const mId = row.accountManagerId ?? "__unassigned__";
    const entry = managerWorkloadMap.get(mId) ?? {
      openCount: 0,
      inReviewCount: 0,
      quotedCount: 0,
    };
    entry.openCount++;
    if (row.status === "IN_REVIEW") entry.inReviewCount++;
    if (row.status === "QUOTED") entry.quotedCount++;
    managerWorkloadMap.set(mId, entry);
  }
  const managerWorkload = Array.from(managerWorkloadMap.entries())
    .map(([managerId, stats]) => ({
      managerId,
      managerName:
        managerId === "__unassigned__"
          ? "Unassigned"
          : (managerNameMap.get(managerId) ?? managerId),
      ...stats,
    }))
    .sort((a, b) => b.openCount - a.openCount);

  // ── Monthly submission trend ────────────────────────────────────────────────
  const trend = buildMonthlyTrend(requestRows);

  // ── Audit log: record this analytics view ──────────────────────────────────
  await recordAuditLog({
    actorId: user?.id ?? null,
    action: "B2B_PROCUREMENT_ANALYTICS_VIEWED",
    entityType: "B2B_PROCUREMENT_ANALYTICS",
    entityId: "summary",
    meta: {
      sourcePage: "admin/b2b/procurement/analytics",
      section: "analytics",
      operation: "VIEW",
      filters: { start: startDate || null, end: endDate || null },
      resultSummary: {
        totalRequests,
        openCount,
        unassignedOpenCount,
        draftEligibleCount,
        convertedToDraftCount,
        truncated,
      },
      actor: {
        id: user?.id ?? null,
        role: role ?? null,
        email: user?.email ?? null,
        name: user?.name ?? null,
      },
    },
    request: req,
    outcome: "SUCCESS",
  });

  return NextResponse.json({
    summary: {
      totalRequests,
      openCount,
      unassignedOpenCount,
      draftEligibleCount,
      convertedToDraftCount,
      convertedToDraftRatePct: Math.round((convertedToDraftCount / draftDenominator) * 1000) / 10,
      avgHoursToAssignment: avg(firstAssignmentHours),
      avgHoursToQuoted: avg(timeToQuotedHours),
      avgHoursToApproved: avg(timeToApprovedHours),
      statusCounts,
      requestTypeCounts,
    },
    topRequested,
    oldestOpen,
    managerWorkload,
    trend,
    truncated,
  });
}
