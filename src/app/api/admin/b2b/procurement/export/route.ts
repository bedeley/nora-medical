import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatDateGH } from "@/lib/currency";
import { recordAuditLog } from "@/lib/audit-log";

const SOURCE_PAGE = "admin/b2b/procurement";

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

function parseSnapshot<T>(meta: string | null) {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { snapshot?: T };
    return parsed.snapshot ?? null;
  } catch {
    return null;
  }
}

function csvCell(value: string | null | undefined): string {
  const s = String(value ?? "").replace(/\r?\n/g, " ");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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
  const statusGroup = String(url.searchParams.get("statusGroup") || "all").toLowerCase();
  const requestTypeFilter = String(url.searchParams.get("requestType") || "").trim().toUpperCase();
  const assignedManagerId = String(url.searchParams.get("assignedManagerId") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const startDate = url.searchParams.get("start")?.trim() || "";
  const endDate = url.searchParams.get("end")?.trim() || "";
  const archiveAfterDaysRaw = Number(url.searchParams.get("archiveAfterDays") || 30);
  const archiveAfterDays = Number.isFinite(archiveAfterDaysRaw)
    ? Math.max(1, Math.min(365, Math.floor(archiveAfterDaysRaw)))
    : 30;

  const validRequestTypes = new Set(["QUOTE", "PO_UPLOAD", "RECURRING_REORDER"]);
  const effectiveTypeFilter = validRequestTypes.has(requestTypeFilter) ? requestTypeFilter : "";
  const startMs = startDate ? new Date(startDate + "T00:00:00.000Z").getTime() : null;
  const endMs = endDate ? new Date(endDate + "T23:59:59.999Z").getTime() : null;

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

  const userIds = Array.from(
    new Set(
      snapshots
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

  const nowMs = Date.now();
  const archiveMs = archiveAfterDays * 24 * 60 * 60 * 1000;
  const openStatuses = new Set(["SUBMITTED", "IN_REVIEW", "QUOTED", "APPROVED"]);

  const rows = snapshots
    .map((row) => {
      const isTerminal = row.status === "REJECTED" || row.status === "CLOSED";
      const updatedMs = new Date(row.updatedAt).getTime();
      const isArchived = isTerminal && Number.isFinite(updatedMs) && nowMs - updatedMs >= archiveMs;
      return {
        ...row,
        isArchived,
        customer: userMap.get(row.customerId) || null,
        accountManager: row.accountManagerId ? userMap.get(row.accountManagerId) || null : null,
      };
    })
    .filter((row) => {
      if (statusGroup === "open") {
        if (row.isArchived || !openStatuses.has(row.status)) return false;
      } else if (statusGroup === "closed") {
        if (row.isArchived || (row.status !== "REJECTED" && row.status !== "CLOSED")) return false;
      } else if (statusGroup === "archived") {
        if (!row.isArchived) return false;
      }
      if (effectiveTypeFilter && row.requestType !== effectiveTypeFilter) return false;
      if (assignedManagerId) {
        if (assignedManagerId === "__unassigned__") {
          if (row.accountManagerId) return false;
        } else {
          if (row.accountManagerId !== assignedManagerId) return false;
        }
      }
      if (startMs !== null || endMs !== null) {
        const createdMs = new Date(row.createdAt).getTime();
        if (startMs !== null && createdMs < startMs) return false;
        if (endMs !== null && createdMs > endMs) return false;
      }
      if (q) {
        const haystack = [row.id, row.clinicName, row.contactName, row.contactPhone || "", row.contactEmail || ""]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const headers = [
    "Request ID",
    "Clinic Name",
    "Contact Name",
    "Contact Phone",
    "Contact Email",
    "Type",
    "Status",
    "Archived",
    "Account Manager",
    "Customer Email",
    "Created",
    "Updated",
    "PO Document",
    "Notes",
  ];

  const csvLines: string[] = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    csvLines.push(
      [
        csvCell(row.id),
        csvCell(row.clinicName),
        csvCell(row.contactName),
        csvCell(row.contactPhone),
        csvCell(row.contactEmail),
        csvCell(row.requestType),
        csvCell(row.status),
        csvCell(row.isArchived ? "Yes" : "No"),
        csvCell(row.accountManager?.name || row.accountManager?.email || row.accountManagerId || ""),
        csvCell(row.customer?.email || row.customerId),
        csvCell(formatDateGH(row.createdAt)),
        csvCell(formatDateGH(row.updatedAt)),
        csvCell(row.poDocumentUrl),
        csvCell(row.notes),
      ].join(","),
    );
  }

  const csv = csvLines.join("\r\n");
  const dateStr = new Date().toISOString().slice(0, 10);

  await recordAuditLog({
    actorId: user?.id || null,
    action: "B2B_PROCUREMENT_REQUEST_EXPORTED",
    entityType: "B2B_PROCUREMENT_REQUEST",
    entityId: "export",
    request: req,
    outcome: "SUCCESS",
    meta: {
      sourcePage: SOURCE_PAGE,
      section: "export",
      operation: "export_csv",
      actor: {
        id: user?.id || null,
        role: role || null,
        email: user?.email || null,
        name: user?.name || null,
      },
      filters: {
        statusGroup,
        requestType: effectiveTypeFilter || null,
        assignedManagerId: assignedManagerId || null,
        q: q || null,
        start: startDate || null,
        end: endDate || null,
        archiveAfterDays,
      },
      rowCount: rows.length,
      status: "SUCCESS",
      resultSummary: `Exported ${rows.length} B2B procurement request rows.`,
    },
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="b2b-procurement-${dateStr}.csv"`,
    },
  });
}
