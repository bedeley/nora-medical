"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const REOPEN_REASON_TEMPLATES = [
  "Customer updated scope and requested re-review",
  "Pricing revised and request needs re-quote",
  "Stock availability changed; request reopened",
  "Documents updated by clinic; resume workflow",
];
const STATUS_GROUP_OPTIONS = ["open", "closed", "archived", "all"] as const;
const ARCHIVE_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

export default function AdminB2BProcurementPage() {
  const router = useRouter();
  const [managerByRequest, setManagerByRequest] = useState<Record<string, string>>({});
  const [statusByRequest, setStatusByRequest] = useState<Record<string, string>>({});
  const [noteByRequest, setNoteByRequest] = useState<Record<string, string>>({});
  const [busyByRequest, setBusyByRequest] = useState<Record<string, boolean>>({});
  const [statusGroup, setStatusGroup] = useState<"open" | "closed" | "archived" | "all">("open");
  const [archiveAfterDays, setArchiveAfterDays] = useState<number>(30);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expandedByRequest, setExpandedByRequest] = useState<Record<string, boolean>>({});
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [selectedByRequest, setSelectedByRequest] = useState<Record<string, boolean>>({});
  const [bulkManagerId, setBulkManagerId] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkNote, setBulkNote] = useState("");

  const safeStatusGroup = STATUS_GROUP_OPTIONS.includes(statusGroup as (typeof STATUS_GROUP_OPTIONS)[number])
    ? statusGroup
    : "open";
  const safeArchiveAfterDays = ARCHIVE_DAY_OPTIONS.includes(archiveAfterDays as (typeof ARCHIVE_DAY_OPTIONS)[number])
    ? archiveAfterDays
    : 30;

  const { data: requestsData, refetch } = useClientQuery<{
    items: RequestRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    clinicOptions?: string[];
  }>({
    queryKey: ["admin", "b2b-procurement-requests", safeStatusGroup, safeArchiveAfterDays, search, page, pageSize],
    queryFn: () =>
      fetcher(
        `/api/admin/b2b/procurement/requests?statusGroup=${encodeURIComponent(
          safeStatusGroup,
        )}&archiveAfterDays=${safeArchiveAfterDays}&q=${encodeURIComponent(search)}&page=${page}&pageSize=${pageSize}`,
      ),
  });
  const { data: usersData } = useClientQuery<{ rows: Array<{ user: UserRow }> }>({
    queryKey: ["admin", "customers-users-lite"],
    queryFn: () => fetcher("/api/admin/customers"),
  });

  const requests = useMemo(() => requestsData?.items || [], [requestsData?.items]);
  const total = Number(requestsData?.total || 0);
  const totalPages = Number(requestsData?.totalPages || 1);
  const clinicOptions = useMemo(() => requestsData?.clinicOptions || [], [requestsData?.clinicOptions]);
  const managers = (usersData?.rows || [])
    .map((row) => row.user)
    .filter((u) => u.role === "ADMIN" || u.role === "STAFF");
  const selectedIds = requests.filter((row) => selectedByRequest[row.id]).map((row) => row.id);
  const selectedRows = requests.filter((row) => selectedByRequest[row.id]);
  const selectedIncludesQuotedOrApproved = selectedRows.some(
    (row) => row.status === "QUOTED" || row.status === "APPROVED",
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-b2b-procurement-prefs");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          statusGroup?: "open" | "closed" | "archived" | "all";
          archiveAfterDays?: number;
          pageSize?: number;
        };
        if (parsed.statusGroup && STATUS_GROUP_OPTIONS.includes(parsed.statusGroup)) {
          setStatusGroup(parsed.statusGroup);
        }
        if (
          typeof parsed.archiveAfterDays === "number" &&
          ARCHIVE_DAY_OPTIONS.includes(parsed.archiveAfterDays as (typeof ARCHIVE_DAY_OPTIONS)[number])
        ) {
          setArchiveAfterDays(parsed.archiveAfterDays);
        }
        if (typeof parsed.pageSize === "number" && [10, 25, 50].includes(parsed.pageSize)) {
          setPageSize(parsed.pageSize);
        }
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

  useEffect(() => {
    setSelectedByRequest((prev) => {
      const visible = new Set(requests.map((row) => row.id));
      const next: Record<string, boolean> = {};
      for (const [id, selected] of Object.entries(prev)) {
        if (selected && visible.has(id)) next[id] = true;
      }
      const prevKeys = Object.keys(prev).filter((k) => prev[k]);
      const nextKeys = Object.keys(next);
      if (
        prevKeys.length === nextKeys.length &&
        prevKeys.every((key) => next[key] === true)
      ) {
        return prev;
      }
      return next;
    });
  }, [requests]);

  const calcSla = (row: RequestRow) => {
    const updatedMs = new Date(row.updatedAt).getTime();
    const ageHours = Number.isFinite(updatedMs) ? Math.max(0, (Date.now() - updatedMs) / 3_600_000) : 0;
    const ageLabel = ageHours >= 24 ? `${Math.floor(ageHours / 24)}d` : `${Math.max(1, Math.floor(ageHours))}h`;
    const risk = row.status === "IN_REVIEW" && ageHours >= 48 ? "high" : row.status === "SUBMITTED" && ageHours >= 24 ? "medium" : "normal";
    return { ageLabel, risk };
  };

  const assignManager = async (requestId: string) => {
    const accountManagerId = managerByRequest[requestId];
    if (!accountManagerId) {
      toast.error("Select an account manager first.");
      return;
    }
    try {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: true }));
      const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountManagerId,
          note: noteByRequest[requestId] || undefined,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body.error || "Failed to assign manager");
        return;
      }
      toast.success("Account manager assigned.");
      await refetch();
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const updateStatus = async (requestId: string) => {
    const status = statusByRequest[requestId];
    if (!status) {
      toast.error("Select a status first.");
      return;
    }
    const row = requests.find((r) => r.id === requestId);
    if (
      row &&
      (row.status === "QUOTED" || row.status === "APPROVED") &&
      status === "IN_REVIEW"
    ) {
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
        body: JSON.stringify({
          status,
          note: noteByRequest[requestId] || undefined,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body.error || "Failed to update status");
        return;
      }
      toast.success("Status updated.");
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
        body: JSON.stringify({
          status: "IN_REVIEW",
          reopen: true,
          note,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body.error || "Failed to reopen request");
        return;
      }
      toast.success("Request reopened to IN_REVIEW.");
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
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body.error || "Could not prepare draft order");
        return;
      }
      toast.success("Draft order prepared. Opening order form.");
      router.push(`/admin/orders/new?b2bRequestId=${encodeURIComponent(requestId)}`);
    } finally {
      setBusyByRequest((prev) => ({ ...prev, [requestId]: false }));
    }
  };

  const openTenderBuilder = (requestId: string) => {
    router.push(`/admin/b2b/tenders?procurementRequestId=${encodeURIComponent(requestId)}`);
  };

  const applyBulkAssign = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one request.");
      return;
    }
    if (!bulkManagerId) {
      toast.error("Select a manager for bulk assign.");
      return;
    }
    try {
      const results = await Promise.all(
        selectedIds.map(async (id) => {
          const res = await fetch(`/api/admin/b2b/procurement/requests/${id}/assign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountManagerId: bulkManagerId,
              note: bulkNote || undefined,
            }),
          });
          const body = await res.json().catch(() => ({} as { error?: string }));
          return { ok: res.ok, error: body.error || "" };
        }),
      );
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      if (okCount > 0) toast.success(`Assigned ${okCount} request(s).`);
      if (failCount > 0) toast.error(`${failCount} request(s) failed assignment.`);
      await refetch();
    } catch {
      toast.error("Bulk assign failed.");
    }
  };

  const applyBulkStatus = async () => {
    if (selectedIds.length === 0) {
      toast.error("Select at least one request.");
      return;
    }
    if (!bulkStatus) {
      toast.error("Select a bulk status.");
      return;
    }
    if (bulkStatus === "IN_REVIEW" && selectedIncludesQuotedOrApproved) {
      toast.error("Cannot move selected QUOTED/APPROVED requests back to IN_REVIEW.");
      return;
    }
    if (
      (bulkStatus === "QUOTED" || bulkStatus === "APPROVED") &&
      selectedRows.some((row) => !row.accountManagerId)
    ) {
      toast.error("Assign manager for all selected requests before QUOTED/APPROVED.");
      return;
    }
    try {
      const results = await Promise.all(
        selectedIds.map(async (id) => {
          const res = await fetch(`/api/admin/b2b/procurement/requests/${id}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: bulkStatus,
              note: bulkNote || undefined,
            }),
          });
          const body = await res.json().catch(() => ({} as { error?: string }));
          return { ok: res.ok, error: body.error || "" };
        }),
      );
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      if (okCount > 0) toast.success(`Updated status for ${okCount} request(s).`);
      if (failCount > 0) toast.error(`${failCount} request(s) failed status update.`);
      await refetch();
    } catch {
      toast.error("Bulk status update failed.");
    }
  };

  return (
    <section className="container mx-auto py-8 max-w-6xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">B2B Procurement Workflow</h1>
        <p className="text-sm text-muted-foreground">
          Manage clinic quote requests, PO uploads, and recurring reorder workflows.
        </p>
        <div className="mt-2">
          <Link href="/admin/b2b/procurement/analytics" className="text-xs underline">
            Open analytics dashboard
          </Link>
          {" · "}
          <Link href="/admin/b2b/tenders" className="text-xs underline">
            Open tender builder
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Queue</label>
              <select
                className="h-10 w-full sm:w-[150px] rounded border bg-background px-3 text-sm"
                value={safeStatusGroup}
                onChange={(e) => {
                  setStatusGroup(e.target.value as "open" | "closed" | "archived" | "all");
                  setPage(1);
                }}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Auto-archive after</label>
              <select
                className="h-10 w-full sm:w-[170px] rounded border bg-background px-3 text-sm"
                value={String(safeArchiveAfterDays)}
                onChange={(e) => {
                  setArchiveAfterDays(Number(e.target.value));
                  setPage(1);
                }}
              >
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
              </select>
            </div>
            <div className="w-full sm:min-w-[220px] flex-1">
              <label className="text-xs text-muted-foreground block mb-1">Search</label>
              <Input
                list="procurement-clinic-options"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Clinic, contact, request ID, customer (clinic suggestions available)"
              />
              <datalist id="procurement-clinic-options">
                {clinicOptions.map((name) => (
                  <option key={`clinic-${name}`} value={name} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="mb-3 rounded border p-2">
            <div className="mb-2 text-xs text-muted-foreground">
              Bulk actions ({selectedIds.length} selected)
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <select
                className="h-10 w-full sm:w-[210px] rounded border bg-background px-3 text-sm"
                value={bulkManagerId || "__none__"}
                onChange={(e) => setBulkManagerId(e.target.value === "__none__" ? "" : e.target.value)}
              >
                <option value="__none__">Select manager</option>
                {managers.map((m) => (
                  <option key={`bulk-m-${m.id}`} value={m.id}>
                    {m.name || m.email || m.id}
                  </option>
                ))}
              </select>
              <select
                className="h-10 w-full sm:w-[190px] rounded border bg-background px-3 text-sm"
                value={bulkStatus || "__none__"}
                onChange={(e) => setBulkStatus(e.target.value === "__none__" ? "" : e.target.value)}
              >
                <option value="__none__">Select status</option>
                <option value="IN_REVIEW" disabled={selectedIncludesQuotedOrApproved}>
                  In Review
                </option>
                <option value="QUOTED">Quoted</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="CLOSED">Closed</option>
              </select>
              <Input
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
                placeholder="Bulk note (optional)"
                className="w-full sm:min-w-[220px] flex-1"
              />
              <Button className="w-full sm:w-auto" variant="outline" onClick={applyBulkAssign} disabled={selectedIds.length === 0}>
                Apply Assign
              </Button>
              <Button className="w-full sm:w-auto" onClick={applyBulkStatus} disabled={selectedIds.length === 0}>
                Apply Status
              </Button>
            </div>
          </div>
          {requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No procurement requests yet.</p>
          ) : (
            <div className="space-y-3">
              {requests.map((row) => (
                <div key={row.id} className="rounded border p-3 space-y-3">
                  {(() => {
                    const isTerminal = row.status === "REJECTED" || row.status === "CLOSED";
                    const shouldCollapse = isTerminal || row.isArchived;
                    const expanded = expandedByRequest[row.id] || !shouldCollapse;
                    return (
                      <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(selectedByRequest[row.id])}
                          onChange={(e) =>
                            setSelectedByRequest((prev) => ({
                              ...prev,
                              [row.id]: e.target.checked,
                            }))
                          }
                        />
                        <span className="font-medium">{row.clinicName}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.requestType} - {row.status} - Updated {formatDateGH(row.updatedAt)}
                        {" | "}
                        {(() => {
                          const sla = calcSla(row);
                          const cls =
                            sla.risk === "high"
                              ? "text-red-700"
                              : sla.risk === "medium"
                                ? "text-amber-700"
                                : "text-muted-foreground";
                          return <span className={cls}>SLA age: {sla.ageLabel}</span>;
                        })()}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Customer: {row.customer?.name || row.customer?.email || row.customerId}
                    </div>
                  </div>
                  {shouldCollapse && !expanded ? (
                    <div className="flex items-center justify-between rounded border bg-muted/30 px-3 py-2 text-xs">
                      <span>
                        {row.requestType} | {row.status}
                        {row.isArchived ? " | archived by age" : ""}
                        {" | "}
                        {row.itemsText ? "items available" : "no items"}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setExpandedByRequest((prev) => ({ ...prev, [row.id]: true }))
                        }
                      >
                        Expand
                      </Button>
                    </div>
                  ) : null}
                  {!shouldCollapse || expanded ? (
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
                        value={statusByRequest[row.id] || row.status}
                        onValueChange={(value) =>
                          setStatusByRequest((prev) => ({ ...prev, [row.id]: value }))
                        }
                        disabled={isTerminal}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {!isTerminal ? <SelectItem value="SUBMITTED">Submitted</SelectItem> : null}
                          {!isTerminal ? (
                            <SelectItem value="IN_REVIEW" disabled={blockInReview}>
                              In Review
                            </SelectItem>
                          ) : null}
                          {!isTerminal ? <SelectItem value="QUOTED" disabled={!effectiveManagerId}>Quoted</SelectItem> : null}
                          {!isTerminal ? <SelectItem value="APPROVED" disabled={!effectiveManagerId}>Approved</SelectItem> : null}
                          <SelectItem value="REJECTED">Rejected</SelectItem>
                          <SelectItem value="CLOSED">Closed</SelectItem>
                        </SelectContent>
                      </Select>
                        );
                      })()}
                    </div>
                    <div>
                      <label className="text-xs text-transparent block mb-1 select-none">Actions</label>
                      <div className="flex flex-wrap items-end gap-2 justify-start">
                        <Button
                          variant="outline"
                          onClick={() => assignManager(row.id)}
                          disabled={!!busyByRequest[row.id] || isTerminal}
                          className="h-10"
                        >
                          Assign
                        </Button>
                        <Button onClick={() => updateStatus(row.id)} disabled={!!busyByRequest[row.id] || isTerminal} className="h-10">
                          Update Status
                        </Button>
                        {isTerminal ? (
                          <Button
                            variant="outline"
                            onClick={() => reopenRequest(row.id)}
                            disabled={!!busyByRequest[row.id]}
                            className="h-10"
                          >
                            Reopen
                          </Button>
                        ) : null}
                        {(shouldCollapse && expanded) ? (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              setExpandedByRequest((prev) => ({ ...prev, [row.id]: false }))
                            }
                            disabled={!!busyByRequest[row.id]}
                            className="h-10"
                          >
                            Collapse
                          </Button>
                        ) : null}
                        {(row.status === "QUOTED" || row.status === "APPROVED") ? (
                          <Button
                            variant="outline"
                            onClick={() => openTenderBuilder(row.id)}
                            disabled={!!busyByRequest[row.id]}
                            className="h-10"
                          >
                            Create Tender
                          </Button>
                        ) : null}
                        {(row.status === "QUOTED" || row.status === "APPROVED") ? (
                          <Button
                            variant="secondary"
                            onClick={() => openDraftOrder(row.id)}
                            disabled={!!busyByRequest[row.id]}
                            className="h-10 max-w-full"
                          >
                            Draft Order
                          </Button>
                        ) : null}
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
                    />
                    {isTerminal ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {REOPEN_REASON_TEMPLATES.map((reason) => (
                          <Button
                            key={`${row.id}-reopen-${reason}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setNoteByRequest((prev) => ({ ...prev, [row.id]: reason }))
                            }
                          >
                            {reason}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {row.itemsText ? (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Requested items</label>
                      <Textarea rows={4} readOnly value={row.itemsText} />
                    </div>
                  ) : null}

                  {row.poDocumentUrl ? (
                    <a href={row.poDocumentUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                      Open uploaded PO document
                    </a>
                  ) : null}
                    </>
                  ) : null}
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Page {page} of {totalPages} ({total} request{total === 1 ? "" : "s"})
            </span>
            <div className="flex items-center gap-2">
              <select
                className="h-8 w-full sm:w-[110px] rounded border bg-background px-2 text-xs"
                value={String(pageSize)}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
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
