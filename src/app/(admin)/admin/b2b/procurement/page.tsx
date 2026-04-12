"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDateGH } from "@/lib/currency";

type UserRow = { id: string; name: string | null; email: string | null; role: string };
type RequestRow = {
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
  customer: UserRow | null;
  accountManager: UserRow | null;
  isArchived?: boolean;
};

type ManagerOption = { id: string; name: string | null; email: string | null };

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${res.status})`);
  }
  return body;
};

const REOPEN_REASON_TEMPLATES = [
  "Customer updated scope; re-review needed",
  "Pricing revised; needs re-quote",
  "Stock availability changed; reopened",
  "Documents updated by clinic",
];

const STATUS_GROUP_OPTIONS = ["open", "closed", "archived", "all"] as const;
const ARCHIVE_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

function statusBadgeVariant(
  status: string,
): "outline" | "warning" | "secondary" | "success" | "destructive" {
  switch (status) {
    case "SUBMITTED":
      return "outline";
    case "IN_REVIEW":
      return "warning";
    case "QUOTED":
      return "secondary";
    case "APPROVED":
      return "success";
    case "REJECTED":
      return "destructive";
    case "CLOSED":
      return "secondary";
    default:
      return "outline";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "SUBMITTED":
      return "Submitted";
    case "IN_REVIEW":
      return "In Review";
    case "QUOTED":
      return "Quoted";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CLOSED":
      return "Closed";
    default:
      return status;
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "QUOTE":
      return "Quote";
    case "PO_UPLOAD":
      return "PO Upload";
    case "RECURRING_REORDER":
      return "Recurring Reorder";
    default:
      return type;
  }
}

// SLA uses createdAt (age of request since submission), not updatedAt
function calcSla(row: RequestRow) {
  const createdMs = new Date(row.createdAt).getTime();
  const ageHours = Number.isFinite(createdMs) ? Math.max(0, (Date.now() - createdMs) / 3_600_000) : 0;
  const ageLabel = ageHours >= 24 ? `${Math.floor(ageHours / 24)}d` : `${Math.max(1, Math.floor(ageHours))}h`;
  const risk =
    row.status === "IN_REVIEW" && ageHours >= 48
      ? "high"
      : row.status === "SUBMITTED" && ageHours >= 24
        ? "medium"
        : "normal";
  return { ageLabel, risk };
}

function SlaChip({ row }: { row: RequestRow }) {
  const { ageLabel, risk } = calcSla(row);
  const cls =
    risk === "high"
      ? "inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
      : risk === "medium"
        ? "inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700"
        : "inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground";
  return <span className={cls}>{ageLabel} old</span>;
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded border p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div className="h-4 w-4 rounded bg-muted" />
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="h-5 w-16 rounded-full bg-muted" />
      </div>
      <div className="h-3 w-64 rounded bg-muted" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-10 rounded bg-muted" />
        <div className="h-10 rounded bg-muted" />
        <div className="h-10 rounded bg-muted" />
      </div>
    </div>
  );
}

export default function AdminB2BProcurementPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: sessionData } = useSession();
  const isAdmin = (sessionData?.user as { role?: string } | undefined)?.role === "ADMIN";

  const [managerByRequest, setManagerByRequest] = useState<Record<string, string>>({});
  const [statusByRequest, setStatusByRequest] = useState<Record<string, string>>({});
  const [noteByRequest, setNoteByRequest] = useState<Record<string, string>>({});
  const [busyByRequest, setBusyByRequest] = useState<Record<string, boolean>>({});
  const [statusGroup, setStatusGroup] = useState<"open" | "closed" | "archived" | "all">("open");
  const [archiveAfterDays, setArchiveAfterDays] = useState<number>(30);
  const [search, setSearch] = useState(() => searchParams.get("search") || "");
  const [highlightId, setHighlightId] = useState(() => searchParams.get("highlight") || "");
  const [requestTypeFilter, setRequestTypeFilter] = useState("");
  const [assignedManagerFilter, setAssignedManagerFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedByRequest, setExpandedByRequest] = useState<Record<string, boolean>>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [selectedByRequest, setSelectedByRequest] = useState<Record<string, boolean>>({});
  const [bulkManagerId, setBulkManagerId] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const dateError = startDate && endDate && startDate > endDate
    ? "Start date must be before end date."
    : null;

  const safeStatusGroup = STATUS_GROUP_OPTIONS.includes(statusGroup as (typeof STATUS_GROUP_OPTIONS)[number])
    ? statusGroup
    : "open";
  const safeArchiveAfterDays = ARCHIVE_DAY_OPTIONS.includes(archiveAfterDays as (typeof ARCHIVE_DAY_OPTIONS)[number])
    ? archiveAfterDays
    : 30;

  const queryUrl = useMemo(() => {
    const p = new URLSearchParams({
      statusGroup: safeStatusGroup,
      archiveAfterDays: String(safeArchiveAfterDays),
      q: search,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (requestTypeFilter) p.set("requestType", requestTypeFilter);
    if (assignedManagerFilter) p.set("assignedManagerId", assignedManagerFilter);
    if (startDate && !dateError) p.set("start", startDate);
    if (endDate && !dateError) p.set("end", endDate);
    return `/api/admin/b2b/procurement/requests?${p.toString()}`;
  }, [safeStatusGroup, safeArchiveAfterDays, search, page, pageSize, requestTypeFilter, assignedManagerFilter, startDate, endDate, dateError]);

  const { data: requestsData, refetch, isFetching, error: requestsError } = useClientQuery<{
    items: RequestRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    clinicOptions?: string[];
    managerOptions?: ManagerOption[];
  }>({
    queryKey: ["admin", "b2b-procurement-requests", queryUrl],
    queryFn: () => fetcher(queryUrl),
  });
  const { data: usersData } = useClientQuery<{ rows: Array<{ user: UserRow }> }>({
    queryKey: ["admin", "customers-users-lite"],
    queryFn: () => fetcher("/api/admin/customers"),
  });

  const requests = useMemo(() => requestsData?.items || [], [requestsData?.items]);
  const total = Number(requestsData?.total || 0);
  const totalPages = Number(requestsData?.totalPages || 1);
  const clinicOptions = useMemo(() => requestsData?.clinicOptions || [], [requestsData?.clinicOptions]);
  // Manager options from the data (only managers of currently shown results + all assignable staff)
  const managerOptions = useMemo(() => requestsData?.managerOptions || [], [requestsData?.managerOptions]);

  const managers = useMemo(
    () =>
      (usersData?.rows || [])
        .map((row) => row.user)
        .filter((u) => u.role === "ADMIN" || u.role === "STAFF"),
    [usersData?.rows],
  );

  const selectedIds = useMemo(
    () => requests.filter((row) => selectedByRequest[row.id]).map((row) => row.id),
    [requests, selectedByRequest],
  );
  const selectedRows = useMemo(
    () => requests.filter((row) => selectedByRequest[row.id]),
    [requests, selectedByRequest],
  );
  const selectedIncludesQuotedOrApproved = selectedRows.some(
    (row) => row.status === "QUOTED" || row.status === "APPROVED",
  );
  const allOnPageSelected = requests.length > 0 && requests.every((row) => selectedByRequest[row.id]);
  const visibleOpenCount = requests.filter((row) => !["REJECTED", "CLOSED"].includes(row.status)).length;
  const visibleUnassignedCount = requests.filter(
    (row) => !["REJECTED", "CLOSED"].includes(row.status) && !row.accountManagerId,
  ).length;
  const visibleSlaRiskCount = requests.filter((row) => {
    const { risk } = calcSla(row);
    return risk !== "normal" && !["REJECTED", "CLOSED"].includes(row.status);
  }).length;

  // Audit log link for the whole procurement page (admin only)
  const auditLogHref = `/admin/audit?entityType=B2B_PROCUREMENT_REQUEST&sourcePage=admin%2Fb2b%2Fprocurement`;

  // Export URL with current filters
  const exportHref = useMemo(() => {
    const p = new URLSearchParams({
      statusGroup: safeStatusGroup,
      archiveAfterDays: String(safeArchiveAfterDays),
      q: search,
    });
    if (requestTypeFilter) p.set("requestType", requestTypeFilter);
    if (assignedManagerFilter) p.set("assignedManagerId", assignedManagerFilter);
    if (startDate && !dateError) p.set("start", startDate);
    if (endDate && !dateError) p.set("end", endDate);
    return `/api/admin/b2b/procurement/export?${p.toString()}`;
  }, [safeStatusGroup, safeArchiveAfterDays, search, requestTypeFilter, assignedManagerFilter, startDate, endDate, dateError]);

  useEffect(() => {
    const nextSearch = searchParams.get("search") || "";
    const nextHighlight = searchParams.get("highlight") || "";
    if (nextSearch) {
      setSearch(nextSearch);
      setPage(1);
    }
    setHighlightId(nextHighlight);
  }, [searchParams]);

  // Load persisted preferences
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-b2b-procurement-prefs");
    if (raw) {
      try {
        const p = JSON.parse(raw) as {
          statusGroup?: "open" | "closed" | "archived" | "all";
          archiveAfterDays?: number;
          pageSize?: number;
        };
        if (p.statusGroup && STATUS_GROUP_OPTIONS.includes(p.statusGroup)) setStatusGroup(p.statusGroup);
        if (typeof p.archiveAfterDays === "number" && ARCHIVE_DAY_OPTIONS.includes(p.archiveAfterDays as (typeof ARCHIVE_DAY_OPTIONS)[number])) {
          setArchiveAfterDays(p.archiveAfterDays);
        }
        if (typeof p.pageSize === "number" && [10, 25, 50].includes(p.pageSize)) setPageSize(p.pageSize);
      } catch {
        // ignore
      }
    }
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded || typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-b2b-procurement-prefs",
      JSON.stringify({ statusGroup: safeStatusGroup, archiveAfterDays: safeArchiveAfterDays, pageSize }),
    );
  }, [prefsLoaded, safeStatusGroup, safeArchiveAfterDays, pageSize]);

  // Prune selection when page changes
  useEffect(() => {
    setSelectedByRequest((prev) => {
      const visible = new Set(requests.map((row) => row.id));
      const next: Record<string, boolean> = {};
      for (const [id, selected] of Object.entries(prev)) {
        if (selected && visible.has(id)) next[id] = true;
      }
      const prevKeys = Object.keys(prev).filter((k) => prev[k]);
      const nextKeys = Object.keys(next);
      if (prevKeys.length === nextKeys.length && prevKeys.every((key) => next[key] === true)) return prev;
      return next;
    });
  }, [requests]);

  const assignManager = async (requestId: string) => {
    const row = requests.find((r) => r.id === requestId);
    const accountManagerId = managerByRequest[requestId] || row?.accountManagerId || "";
    if (!accountManagerId) {
      toast.error("Select an account manager first.");
      return;
    }
    try {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: true }));
      const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountManagerId, note: noteByRequest[requestId] || undefined }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; autoPromoted?: boolean; notification?: { ok: boolean } }));
      if (!res.ok) {
        toast.error(body.error || "Failed to assign manager");
        return;
      }
      if (body.autoPromoted) {
        toast.success("Manager assigned. Request advanced from Submitted to In Review.");
      } else {
        toast.success("Account manager assigned.");
      }
      if (body.notification && !body.notification.ok) {
        toast.warning("Manager assigned, but customer notification could not be sent.");
      }
      await refetch();
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const updateStatus = async (requestId: string) => {
    const row = requests.find((r) => r.id === requestId);
    const status = statusByRequest[requestId] || "";
    if (!row || !status || status === row.status) {
      toast.error("Choose a new status before updating.");
      return;
    }
    if (row && (row.status === "QUOTED" || row.status === "APPROVED") && status === "IN_REVIEW") {
      toast.error("Cannot move QUOTED/APPROVED requests back to IN_REVIEW.");
      return;
    }
    const effectiveManagerId = managerByRequest[requestId] || row?.accountManagerId || "";
    if ((status === "QUOTED" || status === "APPROVED") && !effectiveManagerId) {
      toast.error("Assign an account manager before moving to QUOTED/APPROVED.");
      return;
    }
    try {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: true }));
      const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note: noteByRequest[requestId] || undefined }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; notification?: { ok: boolean } }));
      if (!res.ok) {
        toast.error(body.error || "Failed to update status");
        return;
      }
      toast.success("Status updated.");
      if (body.notification && !body.notification.ok) {
        toast.warning("Status updated, but customer notification could not be sent.");
      }
      setExpandedByRequest((prev) => ({ ...prev, [requestId]: true }));
      await refetch();
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const reopenRequest = async (requestId: string) => {
    const note = noteByRequest[requestId]?.trim() || "";
    if (!note) {
      toast.error("Add a workflow note explaining the reopen reason.");
      return;
    }
    try {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: true }));
      const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "IN_REVIEW", reopen: true, note }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body.error || "Failed to reopen request");
        return;
      }
      toast.success("Request reopened to In Review.");
      setExpandedByRequest((prev) => ({ ...prev, [requestId]: true }));
      await refetch();
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const openDraftOrder = async (requestId: string) => {
    try {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: true }));
      const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/draft-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({} as { error?: string; warning?: string }));
      if (!res.ok) {
        toast.error(body.error || "Could not prepare draft order");
        return;
      }
      if (body.warning) toast.warning(body.warning);
      else toast.success("Draft order prepared. Opening order form.");
      router.push(`/admin/orders/new?b2bRequestId=${encodeURIComponent(requestId)}`);
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const openTenderBuilder = (requestId: string) => {
    router.push(`/admin/b2b/tenders?procurementRequestId=${encodeURIComponent(requestId)}`);
  };

  const applyBulkAction = async (action: "assign" | "status") => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one request.");
      return;
    }
    if (action === "assign" && !bulkManagerId) {
      toast.error("Select a manager for bulk assign.");
      return;
    }
    if (action === "status" && !bulkStatus) {
      toast.error("Select a status for bulk update.");
      return;
    }
    if (action === "status" && bulkStatus === "IN_REVIEW" && selectedIncludesQuotedOrApproved) {
      toast.error("Cannot move selected QUOTED/APPROVED requests back to IN_REVIEW.");
      return;
    }
    if (
      action === "status" &&
      (bulkStatus === "QUOTED" || bulkStatus === "APPROVED") &&
      selectedRows.some((row) => !row.accountManagerId)
    ) {
      toast.error("Use Apply Assign first; all selected requests need a manager before QUOTED/APPROVED.");
      return;
    }
    try {
      setBulkBusy(true);
      const payload: Record<string, unknown> = {
        action,
        ids: selectedIds,
        note: bulkNote || undefined,
      };
      if (action === "assign") payload.accountManagerId = bulkManagerId;
      if (action === "status") payload.status = bulkStatus;

      const res = await fetch("/api/admin/b2b/procurement/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({} as { error?: string; successCount?: number; failCount?: number }));
      if (!res.ok) {
        toast.error(body.error || "Bulk action failed.");
        return;
      }
      const { successCount = 0, failCount = 0 } = body;
      if (successCount > 0) toast.success(`${action === "assign" ? "Assigned" : "Updated status for"} ${successCount} request(s).`);
      if (failCount > 0) toast.error(`${failCount} request(s) could not be updated. Check individual rows.`);
      await refetch();
    } catch {
      toast.error("Bulk action failed.");
    } finally {
      setBulkBusy(false);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setRequestTypeFilter("");
    setAssignedManagerFilter("");
    setStartDate("");
    setEndDate("");
    setPage(1);
  };

  const hasActiveFilters = Boolean(search || requestTypeFilter || assignedManagerFilter || startDate || endDate);

  return (
    <section className="container mx-auto py-8 max-w-6xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">B2B Procurement Workflow</h1>
          <p className="text-sm text-muted-foreground">
            Manage clinic quote requests, PO uploads, and recurring reorder workflows.
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <Link href="/admin/b2b/procurement/analytics" className="underline">
              Analytics dashboard
            </Link>
            <Link href="/admin/b2b/tenders" className="underline">
              Tender builder
            </Link>
            {isAdmin && (
              <Link href={auditLogHref} className="underline">
                View audit log
              </Link>
            )}
          </div>
        </div>
        <a
          href={exportHref}
          download
          className="inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Export CSV
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            <div className="rounded border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">Visible requests</div>
              <div className="text-lg font-semibold">{requests.length}</div>
            </div>
            <div className="rounded border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">Open on page</div>
              <div className="text-lg font-semibold">{visibleOpenCount}</div>
            </div>
            <div className="rounded border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">Unassigned open</div>
              <div className={`text-lg font-semibold ${visibleUnassignedCount > 0 ? "text-amber-600" : ""}`}>
                {visibleUnassignedCount}
              </div>
            </div>
            <div className="rounded border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">SLA risk</div>
              <div className={`text-lg font-semibold ${visibleSlaRiskCount > 0 ? "text-red-600" : ""}`}>
                {visibleSlaRiskCount}
              </div>
            </div>
          </div>

          {requestsError ? (
            <div
              role="alert"
              className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Failed to load procurement requests. Refresh the page or try again.
            </div>
          ) : null}

          {/* Filter bar */}
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="filter-queue" className="text-xs text-muted-foreground block mb-1">Queue</label>
              <select
                id="filter-queue"
                className="h-9 w-full sm:w-[140px] rounded border bg-background px-3 text-sm"
                value={safeStatusGroup}
                onChange={(e) => { setStatusGroup(e.target.value as "open" | "closed" | "archived" | "all"); setPage(1); }}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </div>
            <div>
              <label htmlFor="filter-type" className="text-xs text-muted-foreground block mb-1">Type</label>
              <select
                id="filter-type"
                className="h-9 w-full sm:w-[160px] rounded border bg-background px-3 text-sm"
                value={requestTypeFilter}
                onChange={(e) => { setRequestTypeFilter(e.target.value); setPage(1); }}
              >
                <option value="">All types</option>
                <option value="QUOTE">Quote</option>
                <option value="PO_UPLOAD">PO Upload</option>
                <option value="RECURRING_REORDER">Recurring Reorder</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Manager</label>
              <select
                className="h-9 w-full sm:w-[170px] rounded border bg-background px-3 text-sm"
                value={assignedManagerFilter}
                onChange={(e) => { setAssignedManagerFilter(e.target.value); setPage(1); }}
              >
                <option value="">All managers</option>
                <option value="__unassigned__">Unassigned</option>
                {managerOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.email || m.id}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="filter-from" className="text-xs text-muted-foreground block mb-1">From</label>
              <Input id="filter-from" type="date" className="h-9 w-full sm:w-[140px]" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPage(1); }} />
            </div>
            <div>
              <label htmlFor="filter-to" className="text-xs text-muted-foreground block mb-1">To</label>
              <Input id="filter-to" type="date" className="h-9 w-full sm:w-[140px]" value={endDate} onChange={(e) => { setEndDate(e.target.value); setPage(1); }} />
            </div>
            <div className="w-full sm:min-w-[200px] flex-1">
              <label className="text-xs text-muted-foreground block mb-1">Search</label>
              <Input
                list="procurement-clinic-options"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search clinic, contact, or request ID..."
              />
              <datalist id="procurement-clinic-options">
                {clinicOptions.map((name) => (
                  <option key={`clinic-${name}`} value={name} />
                ))}
              </datalist>
            </div>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            {dateError && (
              <span className="text-xs text-destructive self-end pb-2" role="alert">
                {dateError}
              </span>
            )}
          </div>

          {/* Auto-archive setting */}
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Auto-archive closed requests after</span>
            <select
              className="h-7 rounded border bg-background px-2 text-xs"
              value={String(safeArchiveAfterDays)}
              onChange={(e) => { setArchiveAfterDays(Number(e.target.value)); setPage(1); }}
            >
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
              <option value="90">90 days</option>
            </select>
          </div>

          {/* Bulk actions - only when items are selected */}
          {selectedIds.length > 0 && (
            <div className="mb-3 rounded border bg-muted/30 p-2">
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Bulk actions ({selectedIds.length} selected)
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <select
                  className="h-9 w-full sm:w-[200px] rounded border bg-background px-3 text-sm"
                  value={bulkManagerId || "__none__"}
                  onChange={(e) => setBulkManagerId(e.target.value === "__none__" ? "" : e.target.value)}
                >
                  <option value="__none__">Select manager</option>
                  {managers.map((m) => (
                    <option key={`bulk-m-${m.id}`} value={m.id}>{m.name || m.email || m.id}</option>
                  ))}
                </select>
                <select
                  className="h-9 w-full sm:w-[180px] rounded border bg-background px-3 text-sm"
                  value={bulkStatus || "__none__"}
                  onChange={(e) => setBulkStatus(e.target.value === "__none__" ? "" : e.target.value)}
                >
                  <option value="__none__">Select status</option>
                  <option value="IN_REVIEW" disabled={selectedIncludesQuotedOrApproved}>In Review</option>
                  <option value="QUOTED">Quoted</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="CLOSED">Closed</option>
                </select>
                <Input
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                  placeholder="Bulk note (optional)"
                  className="h-9 w-full sm:min-w-[180px] flex-1"
                />
                <Button
                  className="h-9 w-full sm:w-auto"
                  variant="outline"
                  onClick={() => applyBulkAction("assign")}
                  disabled={bulkBusy}
                >
                  Apply Assign
                </Button>
                <Button
                  className="h-9 w-full sm:w-auto"
                  onClick={() => applyBulkAction("status")}
                  disabled={bulkBusy}
                >
                  Apply Status
                </Button>
                <Button
                  className="h-9 w-full sm:w-auto"
                  variant="ghost"
                  onClick={() => setSelectedByRequest({})}
                  disabled={bulkBusy}
                >
                  Clear selection
                </Button>
              </div>
            </div>
          )}

          {/* Select-all row */}
          {requests.length > 0 && (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={allOnPageSelected}
                onChange={(e) => {
                  if (e.target.checked) {
                    const next: Record<string, boolean> = {};
                    for (const row of requests) next[row.id] = true;
                    setSelectedByRequest(next);
                  } else {
                    setSelectedByRequest({});
                  }
                }}
              />
              <span>{allOnPageSelected ? "Deselect all on page" : "Select all on page"}</span>
            </div>
          )}

          {/* Request list */}
          {requestsError ? null : isFetching && requests.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
            </div>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No procurement requests found.</p>
          ) : (
            <div className="space-y-3">
              {requests.map((row) => {
                const isTerminal = row.status === "REJECTED" || row.status === "CLOSED";
                const shouldCollapse = isTerminal || row.isArchived;
                const expanded = expandedByRequest[row.id] ?? !shouldCollapse;
                const isBusy = Boolean(busyByRequest[row.id]);

                return (
                  <div
                    key={row.id}
                    className={`rounded border p-3 space-y-3 ${
                      highlightId === row.id ? "border-primary bg-primary/5" : ""
                    }`}
                  >
                    {/* Card header */}
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={Boolean(selectedByRequest[row.id])}
                          onChange={(e) =>
                            setSelectedByRequest((prev) => ({ ...prev, [row.id]: e.target.checked }))
                          }
                        />
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{row.clinicName}</span>
                            <Badge variant={statusBadgeVariant(row.status)}>
                              {statusLabel(row.status)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{typeLabel(row.requestType)}</span>
                            <SlaChip row={row} />
                            {row.isArchived && (
                              <span className="text-xs text-muted-foreground italic">archived</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <span>{row.contactName}</span>
                            {row.contactPhone && (
                              <> - <a href={`tel:${row.contactPhone}`} className="hover:underline">{row.contactPhone}</a></>
                            )}
                            {row.contactEmail && (
                              <> - <a href={`mailto:${row.contactEmail}`} className="hover:underline">{row.contactEmail}</a></>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Customer: {row.customer?.name || row.customer?.email || row.customerId}
                            {" - "}
                            Submitted: {formatDateGH(row.createdAt)}
                            {row.accountManager && (
                              <> - Manager: {row.accountManager.name || row.accountManager.email}</>
                            )}
                          </div>
                          {isAdmin && (
                            <Link
                              href={`/admin/audit?entityType=B2B_PROCUREMENT_REQUEST&entityId=${encodeURIComponent(row.id)}&sourcePage=admin/b2b/procurement`}
                              className="text-xs underline text-muted-foreground"
                            >
                              View audit trail
                            </Link>
                          )}
                        </div>
                      </div>
                      {shouldCollapse && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExpandedByRequest((prev) => ({ ...prev, [row.id]: !expanded }))
                          }
                        >
                          {expanded ? "Collapse" : "Expand"}
                        </Button>
                      )}
                    </div>

                    {/* Collapsed summary */}
                    {shouldCollapse && !expanded ? (
                      <div className="rounded bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        {typeLabel(row.requestType)} - {statusLabel(row.status)}
                        {row.isArchived ? " - archived" : ""}
                        {row.itemsText ? " - items on file" : " - no items"}
                      </div>
                    ) : null}

                    {/* Expanded body */}
                    {(!shouldCollapse || expanded) && (
                      <>
                        <div className="grid gap-3 sm:grid-cols-1 lg:grid-cols-3">
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Assign account manager</label>
                            <Select
                              value={managerByRequest[row.id] || row.accountManagerId || "__none__"}
                              onValueChange={(value) =>
                                setManagerByRequest((prev) => ({
                                  ...prev,
                                  [row.id]: value === "__none__" ? "" : value,
                                }))
                              }
                              disabled={isTerminal}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Not assigned</SelectItem>
                                {managers.map((m) => (
                                  <SelectItem key={m.id} value={m.id}>
                                    {m.name || m.email || m.id}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Update status</label>
                            {(() => {
                              const effectiveManagerId = managerByRequest[row.id] || row.accountManagerId || "";
                              const blockInReview = row.status === "QUOTED" || row.status === "APPROVED";
                              return (
                                <Select
                                  value={statusByRequest[row.id] || "__select__"}
                                  onValueChange={(value) =>
                                    setStatusByRequest((prev) => ({ ...prev, [row.id]: value }))
                                  }
                                  disabled={isTerminal}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder={`Current: ${statusLabel(row.status)}`} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__select__" disabled>
                                      Current: {statusLabel(row.status)}
                                    </SelectItem>
                                    {/* SUBMITTED is not a valid transition target - omitted intentionally */}
                                    {!isTerminal && (
                                      <SelectItem value="IN_REVIEW" disabled={blockInReview}>
                                        In Review
                                      </SelectItem>
                                    )}
                                    {!isTerminal && (
                                      <SelectItem value="QUOTED" disabled={!effectiveManagerId}>
                                        Quoted
                                      </SelectItem>
                                    )}
                                    {!isTerminal && (
                                      <SelectItem value="APPROVED" disabled={!effectiveManagerId}>
                                        Approved
                                      </SelectItem>
                                    )}
                                    <SelectItem value="REJECTED">Rejected</SelectItem>
                                    <SelectItem value="CLOSED">Closed</SelectItem>
                                  </SelectContent>
                                </Select>
                              );
                            })()}
                          </div>

                          <div>
                            <label className="text-xs text-transparent block mb-1 select-none">Actions</label>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => assignManager(row.id)}
                                disabled={isBusy || isTerminal}
                              >
                                Assign
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => updateStatus(row.id)}
                                disabled={isBusy || isTerminal}
                              >
                                Update Status
                              </Button>
                              {isTerminal && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => reopenRequest(row.id)}
                                  disabled={isBusy}
                                >
                                  Reopen
                                </Button>
                              )}
                              {(row.status === "QUOTED" || row.status === "APPROVED") && (
                                <>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openTenderBuilder(row.id)}
                                    disabled={isBusy}
                                  >
                                    Create Tender
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => openDraftOrder(row.id)}
                                    disabled={isBusy}
                                  >
                                    Draft Order
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div>
                          <label className="text-xs text-muted-foreground block mb-1">Workflow note</label>
                          <Input
                            value={noteByRequest[row.id] || ""}
                            onChange={(e) =>
                              setNoteByRequest((prev) => ({ ...prev, [row.id]: e.target.value }))
                            }
                            placeholder={isTerminal ? "Required for reopen - explain reason" : "Optional note for this action"}
                          />
                          {isTerminal && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {REOPEN_REASON_TEMPLATES.map((reason) => (
                                <button
                                  key={`${row.id}-reason-${reason}`}
                                  type="button"
                                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                                  onClick={() =>
                                    setNoteByRequest((prev) => ({ ...prev, [row.id]: reason }))
                                  }
                                >
                                  {reason}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {row.itemsText && (
                          <div>
                            <label className="text-xs text-muted-foreground block mb-1">Requested items</label>
                            <Textarea rows={4} readOnly value={row.itemsText} />
                          </div>
                        )}

                        {row.poDocumentUrl && (
                          <a
                            href={row.poDocumentUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline"
                          >
                            Open uploaded PO document
                          </a>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages} ({total} request{total === 1 ? "" : "s"})
            </span>
            <div className="flex items-center gap-2">
              <select
                className="h-8 w-full sm:w-[110px] rounded border bg-background px-2 text-xs"
                value={String(pageSize)}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              >
                <option value="10">10 / page</option>
                <option value="25">25 / page</option>
                <option value="50">50 / page</option>
              </select>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
