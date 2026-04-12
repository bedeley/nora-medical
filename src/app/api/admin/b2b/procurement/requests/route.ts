import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type UserRow = { id: string; name: string | null; email: string | null; role: string };
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
type ReorderTemplateSnapshot = {
  id: string;
  customerId: string;
  name: string;
  notes: string | null;
  itemsText: string;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function parseSnapshot<T>(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: T };
    return parsed.snapshot ?? null;
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

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "B2B_PROCUREMENT_REQUEST",
      action: {
        in: [
          "B2B_PROCUREMENT_REQUEST_CREATED",
          "B2B_PROCUREMENT_REQUEST_ASSIGNED",
          "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
        ],
      },
    },
    orderBy: [{ entityId: "asc" }, { createdAt: "asc" }],
    take: 5000,
  });

  const latestById = new Map<string, ProcurementRequestSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot<ProcurementRequestSnapshot>(log.meta);
    if (!snapshot) continue;
    latestById.set(log.entityId, snapshot);
  }
  const snapshots = Array.from(latestById.values());
  const templateIds = Array.from(
    new Set(
      snapshots
        .map((row) => row.templateId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const templateLogs = templateIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "B2B_REORDER_TEMPLATE",
          entityId: { in: templateIds },
          action: {
            in: [
              "B2B_REORDER_TEMPLATE_CREATED",
              "B2B_REORDER_TEMPLATE_UPDATED",
            ],
          },
        },
        orderBy: [{ entityId: "asc" }, { createdAt: "desc" }],
      })
    : [];
  const templateItemsById = new Map<string, string>();
  for (const log of templateLogs) {
    if (templateItemsById.has(log.entityId)) continue;
    const tpl = parseSnapshot<ReorderTemplateSnapshot>(log.meta);
    const itemsText = (tpl?.itemsText || "").trim();
    if (itemsText) templateItemsById.set(log.entityId, itemsText);
  }
  const hydrated = snapshots.map((row) =>
    row.itemsText?.trim()
      ? row
      : {
          ...row,
          itemsText: row.templateId ? templateItemsById.get(row.templateId) || null : null,
        },
  );
  const userIds = Array.from(
    new Set(
      hydrated
        .flatMap((row) => [row.customerId, row.accountManagerId || null])
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const rows = hydrated.map((row) => ({
    ...row,
    customer: (userMap.get(row.customerId) as UserRow | undefined) || null,
    accountManager: row.accountManagerId
      ? (userMap.get(row.accountManagerId) as UserRow | undefined) || null
      : null,
    isArchived: false as boolean,
  }));

  const params = new URL(req.url).searchParams;
  const pageRaw = Number(params.get("page") || 1);
  const pageSizeRaw = Number(params.get("pageSize") || 25);
  const q = String(params.get("q") || "").trim().toLowerCase();
  const statusGroup = String(params.get("statusGroup") || "open").toLowerCase();
  const archiveAfterDaysRaw = Number(params.get("archiveAfterDays") || 30);
  const archiveAfterDays = Number.isFinite(archiveAfterDaysRaw)
    ? Math.max(1, Math.min(365, Math.floor(archiveAfterDaysRaw)))
    : 30;

  // New filter params
  const requestTypeFilter = String(params.get("requestType") || "").trim().toUpperCase();
  const validRequestTypes = new Set(["QUOTE", "PO_UPLOAD", "RECURRING_REORDER"]);
  const effectiveTypeFilter = validRequestTypes.has(requestTypeFilter) ? requestTypeFilter : "";

  const assignedManagerId = String(params.get("assignedManagerId") || "").trim();
  const startDate = String(params.get("start") || "").trim();
  const endDate = String(params.get("end") || "").trim();
  const startMs = startDate ? new Date(startDate + "T00:00:00.000Z").getTime() : null;
  const endMs = endDate ? new Date(endDate + "T23:59:59.999Z").getTime() : null;

  const nowMs = Date.now();
  const archiveMs = archiveAfterDays * 24 * 60 * 60 * 1000;

  const withArchive = rows.map((row) => {
    const isTerminal = row.status === "REJECTED" || row.status === "CLOSED";
    const updatedMs = new Date(row.updatedAt).getTime();
    const isArchived = isTerminal && Number.isFinite(updatedMs) && nowMs - updatedMs >= archiveMs;
    return { ...row, isArchived };
  });
  const openStatuses = new Set(["SUBMITTED", "IN_REVIEW", "QUOTED", "APPROVED"]);
  const clinicOptions = Array.from(
    new Set(
      withArchive
        .map((row) => (row.clinicName || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  // Build list of unique managers for the manager filter dropdown
  const managerOptions: Array<{ id: string; name: string | null; email: string | null }> = Array.from(
    new Map(
      withArchive
        .filter((row) => row.accountManager)
        .map((row) => [row.accountManager!.id, row.accountManager!]),
    ).values(),
  ).sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""));

  const filtered = withArchive
    .filter((row) => {
      // Status group filter
      if (statusGroup === "open") {
        if (row.isArchived || !openStatuses.has(row.status)) return false;
      } else if (statusGroup === "closed") {
        if (row.isArchived || (row.status !== "REJECTED" && row.status !== "CLOSED")) return false;
      } else if (statusGroup === "archived") {
        if (!row.isArchived) return false;
      }
      // Request type filter
      if (effectiveTypeFilter && row.requestType !== effectiveTypeFilter) return false;
      // Assigned manager filter
      if (assignedManagerId) {
        if (assignedManagerId === "__unassigned__") {
          if (row.accountManagerId) return false;
        } else {
          if (row.accountManagerId !== assignedManagerId) return false;
        }
      }
      // Date range filter (by createdAt)
      if (startMs !== null || endMs !== null) {
        const createdMs = new Date(row.createdAt).getTime();
        if (startMs !== null && createdMs < startMs) return false;
        if (endMs !== null && createdMs > endMs) return false;
      }
      // Text search
      if (q) {
        const haystack = [
          row.id,
          row.clinicName,
          row.contactName,
          row.contactPhone || "",
          row.contactEmail || "",
          row.customer?.name || "",
          row.customer?.email || "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (statusGroup === "all") {
        const rank = (row: { status: string; isArchived?: boolean }) => {
          if (row.isArchived) return 2;
          if (openStatuses.has(row.status)) return 0;
          return 1;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
      }
      return a.createdAt < b.createdAt ? 1 : -1;
    });

  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.max(10, Math.min(100, Math.floor(pageSizeRaw)))
    : 25;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.min(totalPages, Math.floor(pageRaw))) : 1;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
    totalPages,
    archiveAfterDays,
    clinicOptions,
    managerOptions,
  });
}
