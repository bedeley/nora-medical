import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    take: 10000,
  });

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
  let openCount = 0;
  let unassignedOpenCount = 0;
  const firstAssignmentHours: number[] = [];
  const timeToQuotedHours: number[] = [];
  const timeToApprovedHours: number[] = [];
  let convertedToDraftCount = 0;
  const topRefs = new Map<string, number>();
  const requestRows: Array<{
    id: string;
    status: string;
    clinicName: string;
    ageDays: number;
    hasAssignment: boolean;
  }> = [];

  for (const [id, events] of grouped.entries()) {
    const created = events.find((e) => e.action === "B2B_PROCUREMENT_REQUEST_CREATED");
    if (!created?.snapshot) continue;
    const latestSnapshot = [...events]
      .reverse()
      .map((event) => event.snapshot)
      .find((snapshot): snapshot is ProcurementRequestSnapshot => Boolean(snapshot));
    if (!latestSnapshot) continue;

    const status = latestSnapshot.status;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const createdAtMs = new Date(latestSnapshot.createdAt).getTime();
    const ageDays = Math.max(0, Math.round(((now - createdAtMs) / 1000 / 3600 / 24) * 10) / 10);
    const hasAssignment = events.some((event) => event.action === "B2B_PROCUREMENT_REQUEST_ASSIGNED");
    const isOpen = !["REJECTED", "CLOSED"].includes(status);
    if (isOpen) {
      openCount += 1;
      if (!hasAssignment) unassignedOpenCount += 1;
    }

    const assignmentEvent = events.find((event) => event.action === "B2B_PROCUREMENT_REQUEST_ASSIGNED");
    if (assignmentEvent) {
      firstAssignmentHours.push((assignmentEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600);
    }

    const quotedEvent = events.find((event) => {
      if (event.action !== "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED") return false;
      return event.snapshot?.status === "QUOTED";
    });
    if (quotedEvent) {
      timeToQuotedHours.push((quotedEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600);
    }

    const approvedEvent = events.find((event) => {
      if (event.action !== "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED") return false;
      return event.snapshot?.status === "APPROVED";
    });
    if (approvedEvent) {
      timeToApprovedHours.push((approvedEvent.createdAt.getTime() - created.createdAt.getTime()) / 1000 / 3600);
    }

    if (events.some((event) => event.action === "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED")) {
      convertedToDraftCount += 1;
    }

    for (const ref of parseItemRefs(latestSnapshot.itemsText)) {
      topRefs.set(ref, (topRefs.get(ref) || 0) + 1);
    }

    requestRows.push({
      id,
      status,
      clinicName: latestSnapshot.clinicName,
      ageDays,
      hasAssignment,
    });
  }

  const totalRequests = requestRows.length;
  const denominator = totalRequests > 0 ? totalRequests : 1;
  const avg = (values: number[]) =>
    values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
  const topRequested = Array.from(topRefs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([itemRef, count]) => ({ itemRef, count }));
  const oldestOpen = requestRows
    .filter((row) => !["REJECTED", "CLOSED"].includes(row.status))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 20);

  return NextResponse.json({
    summary: {
      totalRequests,
      openCount,
      unassignedOpenCount,
      convertedToDraftCount,
      convertedToDraftRatePct: Math.round((convertedToDraftCount / denominator) * 1000) / 10,
      avgHoursToAssignment: avg(firstAssignmentHours),
      avgHoursToQuoted: avg(timeToQuotedHours),
      avgHoursToApproved: avg(timeToApprovedHours),
      statusCounts,
    },
    topRequested,
    oldestOpen,
  });
}
