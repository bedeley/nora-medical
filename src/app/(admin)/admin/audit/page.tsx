"use client";

export const dynamic = "force-dynamic";

import { memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatIdReadable } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { evaluateAuditRisk, type AuditRiskMode, type AuditRiskSeverity } from "@/lib/audit-risk";
import { getMissingTaskRequirement, requiresReviewTask } from "@/lib/audit-review-policy";
import type { AuditRiskSettings, AuditSettingsMode } from "@/lib/audit-risk-config";

type AuditRow = {
  id: string;
  actor?: { id: string; email: string | null; name: string | null; role: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  meta: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  outcome?: string | null;
  createdAt: string;
};

type AuditFilters = {
  actions: string[];
  entityTypes: string[];
  actors: { id: string; name: string | null; email: string | null; role: string }[];
};
type AuditPageResponse = {
  items: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary?: {
    needsReview: number;
    critical: number;
    reviewedToday: number;
    overdueCritical?: number;
    overdueHigh?: number;
    overdueMedium?: number;
    archiveReminder?: number;
    archiveEscalation?: number;
    archiveNeedsAssignment?: number;
    eligibleForArchiveUnreviewed?: number;
    openTasks?: number;
    inProgressTasks?: number;
    overdueTasks?: number;
  } | null;
  riskSettings?: AuditRiskSettings;
  settingsMode?: AuditSettingsMode;
  settingsEditable?: boolean;
};

type AuditSavedFilter = {
  id: string;
  name: string;
  state: {
    logId?: string;
    entityType: string;
    entityId: string;
    employeeId?: string;
    payrollRunId?: string;
    correlationId?: string;
    customerId: string;
    customerSearch: string;
    action: string;
    outcome?: string;
    actorId: string;
    actorType: string;
    start: string;
    end: string;
    metaStatus: string;
    sourcePage?: string;
    riskMode?: AuditRiskMode;
    queueMode?: AuditQueueMode;
    pageSize: number;
  };
  isShared?: boolean;
  canEdit?: boolean;
  owner?: { id: string; name: string | null; email: string | null };
};

type PendingReviewDialog = {
  ids: string[];
  actionSamples: string[];
  nextReviewed: boolean;
};

type ReviewTaskStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";
type AuditQueueMode =
  | "all"
  | "critical_unreviewed"
  | "archive_soon_unreviewed"
  | "needs_assignment"
  | "overdue_tasks"
  | "overdue_reviews_critical"
  | "overdue_reviews_high"
  | "overdue_reviews_medium";
type ReviewTaskDraft = {
  status: ReviewTaskStatus;
  assigneeId: string;
  dueAt: string;
  note: string;
};
type TaskEvidenceItem = {
  url: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
};
type AuditHistoryItem = {
  id: string;
  createdAt: string;
  action: string;
  actor: { id: string; name: string | null; email: string | null; role: string } | null;
  summary: string;
};
type AuditNotificationItem = {
  id: string;
  type: "overdue_review" | "overdue_task" | "archive_escalation";
  severity: "MEDIUM" | "HIGH" | "CRITICAL";
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  message: string;
};
type AuditPerformanceItem = {
  reviewerId: string;
  reviewerName: string;
  reviewedCount: number;
  avgHoursToReview: number;
  assignedOpen: number;
  assignedInProgress: number;
  assignedOverdue: number;
};
type CustomerSuggestItem = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  source: "REGISTERED" | "WALK_IN_HISTORY";
};

const HR_SOURCE_PAGE_OPTIONS = [
  { value: "", label: "All pages" },
  { value: "admin/accounting/settings", label: "Accounting Settings" },
  { value: "admin/accounting/periods", label: "Accounting Periods" },
  { value: "admin/accounting/journal", label: "Accounting Journal" },
  { value: "admin/accounting/reports/pl", label: "Accounting P&L Report" },
  { value: "admin/accounting/reports/trial-balance", label: "Accounting Trial Balance" },
  { value: "admin/accounting/reports/balance-sheet", label: "Accounting Balance Sheet" },
  { value: "admin/accounting/reports/scheduled", label: "Accounting Scheduled Reports" },
  { value: "admin/b2b/procurement", label: "B2B Procurement" },
  { value: "admin/b2b/procurement/analytics", label: "B2B Procurement Analytics" },
  { value: "admin/b2b/tenders", label: "B2B Tenders" },
  { value: "admin/expenses", label: "Expenses" },
  { value: "admin/orders", label: "Orders" },
  { value: "admin/orders/otc", label: "OTC Orders" },
  { value: "admin/otc/shift-close", label: "OTC Shift Close" },
  { value: "admin/users", label: "Users & Roles" },
  { value: "admin/movements", label: "Inventory Movements" },
  { value: "admin/health/incidents", label: "Health Incidents" },
  { value: "admin/hr/hiring", label: "HR Hiring" },
  { value: "admin/hr/reviews", label: "HR Reviews" },
  { value: "admin/hr/compensation", label: "HR Compensation" },
  { value: "admin/hr/payroll", label: "HR Payroll" },
  { value: "admin/hr/payroll/cron", label: "HR Payroll Cron" },
  { value: "admin/hr/leave", label: "HR Leave" },
  { value: "admin/hr/staff", label: "HR Staff Directory" },
  { value: "admin/hr/issues", label: "HR Issues" },
  { value: "admin/hr/settings", label: "HR Settings" },
] as const;

const FILTERABLE_SOURCE_PAGE_OPTIONS = HR_SOURCE_PAGE_OPTIONS.map((item) => item).filter(
  (item) => !item.value.includes("[") && !item.value.includes("]"),
);

const KNOWN_SECURITY_AUDIT_ACTIONS = [
  "USER_LOGIN",
  "USER_LOGIN_FAILED",
  "USER_PASSWORD_CHANGED",
  "USER_PASSWORD_CHANGE_FAILED",
  "USER_PASSWORD_RESET",
  "USER_PASSWORD_RESET_FAILED",
  "USER_2FA_ENABLED",
  "USER_2FA_ENABLE_FAILED",
  "USER_2FA_DISABLED",
  "USER_2FA_DISABLE_FAILED",
  "USER_FORCE_LOGOUT",
  "USER_SESSION_INVALIDATED",
] as const;

function normalizeSourcePage(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

function humanizeAuditLabel(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "Not provided";
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function humanizeSourcePageLabel(value: string): string {
  const normalized = normalizeSourcePage(value);
  if (!normalized) return "All pages";
  const matched = HR_SOURCE_PAGE_OPTIONS.find((item) => item.value === normalized);
  if (matched) return matched.label;
  return humanizeAuditLabel(normalized.replace(/\//g, " "));
}

function humanizeQueueModeLabel(value: AuditQueueMode | string): string {
  switch (value) {
    case "critical_unreviewed":
      return "Critical unreviewed";
    case "archive_soon_unreviewed":
      return "Archive soon unreviewed";
    case "needs_assignment":
      return "Needs assignment";
    case "overdue_tasks":
      return "Overdue tasks";
    case "overdue_reviews_critical":
      return "Overdue critical reviews";
    case "overdue_reviews_high":
      return "Overdue high reviews";
    case "overdue_reviews_medium":
      return "Overdue medium reviews";
    default:
      return "All queues";
  }
}

function formatPlainEnglishDate(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const exactDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (exactDate) {
    const date = new Date(Date.UTC(Number(exactDate[1]), Number(exactDate[2]) - 1, Number(exactDate[3])));
    return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  }
  const isoDate = /^\d{4}-\d{2}-\d{2}T/.test(text) ? new Date(text) : null;
  if (isoDate && Number.isFinite(isoDate.getTime())) {
    return isoDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }
  return text;
}

function humanizeScopeSnapshot(value: string): string {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (match) => formatPlainEnglishDate(match))
    .replace(/\s*\|\s*/g, "; ");
}

function humanizeExportFileName(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = /^([^.]+)(\.[A-Za-z0-9]+)?$/.exec(raw);
  if (!match) return raw;
  const stem = match[1] || "";
  const ext = match[2] || "";
  const stemMatch = /^(.*?)-(\d{4}-\d{2}-\d{2})$/.exec(stem);
  if (stemMatch) {
    return `${humanizeAuditLabel(stemMatch[1])} (${formatPlainEnglishDate(stemMatch[2])})${ext.toLowerCase()}`;
  }
  const normalizedStem = stem.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) => formatPlainEnglishDate(date));
  if (/[() ]/.test(normalizedStem)) {
    return `${normalizedStem}${ext.toLowerCase()}`;
  }
  return `${humanizeAuditLabel(normalizedStem)}${ext.toLowerCase()}`;
}

function replaceAuditBrowserUrl(params: URLSearchParams) {
  if (typeof window === "undefined") return;
  const next = new URLSearchParams(params.toString());
  next.delete("paginate");
  next.delete("includeSummary");
  next.delete("page");
  next.delete("pageSize");
  const query = next.toString();
  window.history.replaceState({}, "", query ? `/admin/audit?${query}` : "/admin/audit");
}

function resolveSourcePageHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^\/+/, "");
  if (!normalized) return null;
  // App Router does not allow template href values such as /admin/hr/staff/[id].
  if (normalized.includes("[") || normalized.includes("]")) return null;
  return `/${normalized}`;
}

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as AuditPageResponse;
};

type AdvancedAuditFiltersDialogProps = {
  advancedFilterCount: number;
  action: string;
  setAction: (value: string) => void;
  setEntityType: (value: string) => void;
  setEmployeeId: (value: string) => void;
  setPayrollRunId: (value: string) => void;
  customerId: string;
  setCustomerId: (value: string) => void;
  setCustomerSearch: (value: string) => void;
  setCustomerOptions: (value: CustomerSuggestItem[]) => void;
  setRiskMode: (value: AuditRiskMode) => void;
  setQueueMode: (value: AuditQueueMode) => void;
  logId: string;
  setLogId: (value: string) => void;
  entityId: string;
  setEntityId: (value: string) => void;
  correlationId: string;
  setCorrelationId: (value: string) => void;
  metaStatus: string;
  setMetaStatus: (value: string) => void;
  outcome: string;
  setOutcome: (value: string) => void;
  actorId: string;
  setActorId: (value: string) => void;
  filterActors: AuditFilters["actors"];
  actorType: string;
  setActorType: (value: string) => void;
  sourcePage: string;
  sourcePageOptions: Array<{ value: string; label: string }>;
  setSourcePage: (value: string) => void;
  employeeStatus: string;
  applyEmployeeStatus: (value: string) => void;
  jobStatus: string;
  applyJobStatus: (value: string) => void;
  issueStatus: string;
  applyIssueStatus: (value: string) => void;
  savedFilterName: string;
  setSavedFilterName: (value: string) => void;
  savedFilterError: string;
  setSavedFilterError: (value: string) => void;
  shareSavedFilter: boolean;
  setShareSavedFilter: (value: boolean) => void;
  savedFiltersSource: "loading" | "server" | "local";
  dateRangeError: string;
  saveCurrentFilter: () => void | Promise<void>;
  clearAll: () => void;
};

const AdvancedAuditFiltersDialog = memo(function AdvancedAuditFiltersDialog({
  advancedFilterCount,
  action,
  setAction,
  setEntityType,
  setEmployeeId,
  setPayrollRunId,
  customerId,
  setCustomerId,
  setCustomerSearch,
  setCustomerOptions,
  setRiskMode,
  setQueueMode,
  logId,
  setLogId,
  entityId,
  setEntityId,
  correlationId,
  setCorrelationId,
  metaStatus,
  setMetaStatus,
  outcome,
  setOutcome,
  actorId,
  setActorId,
  filterActors,
  actorType,
  setActorType,
  sourcePage,
  sourcePageOptions,
  setSourcePage,
  employeeStatus,
  applyEmployeeStatus,
  jobStatus,
  applyJobStatus,
  issueStatus,
  applyIssueStatus,
  savedFilterName,
  setSavedFilterName,
  savedFilterError,
  setSavedFilterError,
  shareSavedFilter,
  setShareSavedFilter,
  savedFiltersSource,
  dateRangeError,
  saveCurrentFilter,
  clearAll,
}: AdvancedAuditFiltersDialogProps) {
  const [open, setOpen] = useState(false);
  const applySecurityPreset = (nextAction: string, nextOutcome = "") => {
    setEntityType("");
    setEmployeeId("");
    setPayrollRunId("");
    setLogId("");
    setEntityId("");
    setCorrelationId("");
    if (customerId) setCustomerId("");
    setCustomerSearch("");
    setCustomerOptions([]);
    setMetaStatus("");
    setActorId("");
    setActorType("");
    setSourcePage("");
    setRiskMode("all");
    setQueueMode("all");
    setAction(nextAction);
    setOutcome(nextOutcome);
  };

  return (
    <>
      <Button
        variant={open ? "default" : "outline"}
        size="sm"
        className="w-full sm:w-auto"
        onClick={() => setOpen(true)}
      >
        {advancedFilterCount > 0 ? `Advanced filters (${advancedFilterCount})` : "Advanced filters"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="inset-y-0 left-auto right-0 top-0 h-[100dvh] max-h-[100dvh] w-full max-w-[min(100vw,42rem)] translate-x-0 translate-y-0 overflow-hidden rounded-none border-b-0 border-l border-r-0 border-t-0 p-0 sm:max-w-[42rem]">
          <div className="flex h-full min-h-0 flex-col">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle>Advanced filters</DialogTitle>
              <DialogDescription>
                Use targeted lookup filters, HR scopes, and saved filters without pushing the audit table down the page.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4 pb-6">
              <section className="space-y-3">
                <div>
                  <div className="text-sm font-medium">Lookup filters</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    IDs, actor filters, source page, status, and outcome for deep investigations.
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Log ID</span>
                    <Input placeholder="Exact audit log ID" value={logId} onChange={(e) => setLogId(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Entity ID</span>
                    <Input placeholder="Order, payment, user, or document ID" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Correlation ID</span>
                    <Input placeholder="Export or workflow correlation ID" value={correlationId} onChange={(e) => setCorrelationId(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Meta status</span>
                    <Input placeholder="APPROVED, FAILED, PAID..." value={metaStatus} onChange={(e) => setMetaStatus(e.target.value.toUpperCase())} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Outcome</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={outcome} onChange={(e) => setOutcome(e.target.value.toUpperCase())}>
                      <option value="">All outcomes</option>
                      <option value="SUCCESS">Success</option>
                      <option value="FAILED">Failed</option>
                      <option value="PARTIAL">Partial</option>
                    </select>
                    <span className="block text-[11px] text-muted-foreground">
                      Best for auth and security rows when you need success vs failure.
                    </span>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Actor ID</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={actorId} onChange={(e) => setActorId(e.target.value)}>
                      <option value="">All actors</option>
                      <option value="system">System</option>
                      {filterActors.map((actor) => (
                        <option key={actor.id} value={actor.id}>
                          {actor.name || actor.email || actor.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Actor type</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={actorType} onChange={(e) => setActorType(e.target.value.toUpperCase())}>
                      <option value="">All actor types</option>
                      <option value="CUSTOMER">Customer</option>
                      <option value="ADMIN">Admin</option>
                      <option value="STAFF">Staff</option>
                      <option value="ACCOUNTANT">Accountant</option>
                      <option value="SYSTEM">System</option>
                    </select>
                  </label>
                  <div className="space-y-1 text-sm md:col-span-2">
                    <label className="text-xs text-muted-foreground">Source page</label>
                    <select
                      aria-label="Source page"
                      className="h-9 w-full rounded border bg-background px-3 text-sm"
                      value={sourcePage}
                      onChange={(e) => setSourcePage(normalizeSourcePage(e.target.value))}
                    >
                      {sourcePageOptions.map((item) => (
                        <option key={item.value || "all"} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Login, password, 2FA, and session logs are already available from the main Action filter.
                </p>
              </section>

              <section className="space-y-3 border-t pt-4">
                <div>
                  <div className="text-sm font-medium">Security presets</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    One-click slices for the auth and session audit rows added in this release. Date range and other visible filters stay in place.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={action === "USER_LOGIN" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_LOGIN", "SUCCESS")}
                  >
                    Successful logins
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_LOGIN_FAILED" && outcome === "FAILED" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_LOGIN_FAILED", "FAILED")}
                  >
                    Failed logins
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_PASSWORD_CHANGED" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_PASSWORD_CHANGED", "SUCCESS")}
                  >
                    Password changes
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_PASSWORD_RESET" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_PASSWORD_RESET", "SUCCESS")}
                  >
                    Password resets
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_2FA_ENABLED" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_2FA_ENABLED", "SUCCESS")}
                  >
                    2FA enabled
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_2FA_DISABLED" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_2FA_DISABLED", "SUCCESS")}
                  >
                    2FA disabled
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_SESSION_INVALIDATED" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_SESSION_INVALIDATED", "SUCCESS")}
                  >
                    Session invalidations
                  </Button>
                  <Button
                    type="button"
                    variant={action === "USER_FORCE_LOGOUT" && outcome === "SUCCESS" ? "default" : "outline"}
                    size="sm"
                    onClick={() => applySecurityPreset("USER_FORCE_LOGOUT", "SUCCESS")}
                  >
                    Force logout actions
                  </Button>
                </div>
              </section>

              <section className="space-y-3 border-t pt-4">
                <div>
                  <div className="text-sm font-medium">HR-specific filters</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Narrow the table to employee, hiring, and issue-management audit flows.
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Employee status</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={employeeStatus} onChange={(e) => applyEmployeeStatus(e.target.value)}>
                      <option value="">All</option>
                      <option value="ACTIVE">Active</option>
                      <option value="ON_LEAVE">On leave</option>
                      <option value="SUSPENDED">Suspended</option>
                      <option value="TERMINATED">Terminated</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Job opening status</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={jobStatus} onChange={(e) => applyJobStatus(e.target.value)}>
                      <option value="">All</option>
                      <option value="OPEN">Open</option>
                      <option value="PAUSED">Paused</option>
                      <option value="CLOSED">Closed</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Issue status</span>
                    <select className="h-9 w-full rounded border bg-background px-3 text-sm" value={issueStatus} onChange={(e) => applyIssueStatus(e.target.value)}>
                      <option value="">All</option>
                      <option value="OPEN">Open</option>
                      <option value="IN_PROGRESS">In progress</option>
                      <option value="RESOLVED">Resolved</option>
                      <option value="CLOSED">Closed</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="space-y-3 border-t pt-4">
                <div>
                  <div className="text-sm font-medium">Save current filter</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Save the current audit filter state so you can restore or share it later.
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Save current filter as</label>
                    <Input
                      placeholder="Ex: Refund checks - last 30 days"
                      value={savedFilterName}
                      onChange={(event) => {
                        setSavedFilterName(event.target.value);
                        if (savedFilterError) setSavedFilterError("");
                      }}
                    />
                    {savedFilterError ? (
                      <p className="text-xs text-red-600">{savedFilterError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">Use names your team can recognize quickly.</p>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={shareSavedFilter}
                      onChange={(event) => setShareSavedFilter(event.target.checked)}
                    />
                    Share this filter with admin/accounting team
                  </label>
                  <p className="text-[11px] text-muted-foreground">
                    Save mode: {savedFiltersSource === "server" ? "Server (shared across devices)" : savedFiltersSource === "local" ? "Local browser fallback" : "Loading..."}
                  </p>
                  <Button type="button" variant="outline" size="sm" disabled={!!dateRangeError} onClick={saveCurrentFilter}>
                    Save filter
                  </Button>
                </div>
              </section>
            </div>
            <DialogFooter className="shrink-0 border-t px-6 py-4">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  clearAll();
                  setOpen(false);
                }}
              >
                Clear filters
              </Button>
              <Button size="sm" onClick={() => setOpen(false)}>Close</Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

function AdminAuditContent() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const currentRole = String((session?.user as { role?: string } | undefined)?.role || "");
  const isAdmin = currentRole === "ADMIN";
  const canManageTasks = isAdmin;
  const searchParams = useSearchParams();
  const scopedView = (() => {
    const raw = (searchParams.get("scope") || "").toLowerCase();
    return raw === "accounting_periods" || raw === "accounting_settings" ? raw : "";
  })();
  const initialized = useRef(false);
  const [filtersReady, setFiltersReady] = useState(false);
  const [logId, setLogId] = useState("");
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [payrollRunId, setPayrollRunId] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [sourcePage, setSourcePage] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState<CustomerSuggestItem[]>([]);
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false);
  const [showCustomerOptions, setShowCustomerOptions] = useState(false);
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [actorId, setActorId] = useState("");
  const [actorType, setActorType] = useState("");
  const [metaStatus, setMetaStatus] = useState("");
  const [employeeStatus, setEmployeeStatus] = useState("");
  const [jobStatus, setJobStatus] = useState("");
  const [issueStatus, setIssueStatus] = useState("");
  const [riskMode, setRiskMode] = useState<AuditRiskMode>("all");
  const [queueMode, setQueueMode] = useState<AuditQueueMode>("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [savedFilters, setSavedFilters] = useState<AuditSavedFilter[]>([]);
  const [savedFilterName, setSavedFilterName] = useState("");
  const [savedFilterError, setSavedFilterError] = useState("");
  const [savedFiltersSource, setSavedFiltersSource] = useState<"loading" | "server" | "local">("loading");
  const [shareSavedFilter, setShareSavedFilter] = useState(false);
  const [removeFilterDialogOpen, setRemoveFilterDialogOpen] = useState(false);
  const [pendingRemoveFilter, setPendingRemoveFilter] = useState<AuditSavedFilter | null>(null);
  const [removeAllFiltersDialogOpen, setRemoveAllFiltersDialogOpen] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [pendingReviewDialog, setPendingReviewDialog] = useState<PendingReviewDialog | null>(null);
  const [reviewNoteInput, setReviewNoteInput] = useState("");
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [pendingTaskRow, setPendingTaskRow] = useState<AuditRow | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<string[]>([]);
  const [taskDraft, setTaskDraft] = useState<ReviewTaskDraft>({
    status: "OPEN",
    assigneeId: "",
    dueAt: "",
    note: "",
  });
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [taskEvidence, setTaskEvidence] = useState<TaskEvidenceItem[]>([]);
  const [taskEvidenceUploading, setTaskEvidenceUploading] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<AuditRow | null>(null);
  const [historyItems, setHistoryItems] = useState<AuditHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationItems, setNotificationItems] = useState<AuditNotificationItem[]>([]);
  const [notificationCounts, setNotificationCounts] = useState<{
    overdueReview: number;
    overdueTask: number;
    archiveEscalation: number;
  }>({ overdueReview: 0, overdueTask: 0, archiveEscalation: 0 });
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false);
  const [notifySubmitting, setNotifySubmitting] = useState(false);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const savedFiltersHydrated = useRef(false);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    when: 180,
    aging: 170,
    actor: 240,
    action: 180,
    entity: 180,
    risk: 170,
    meta: 360,
  });
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const [tableClientWidth, setTableClientWidth] = useState(0);
  const [expandedMetaRows, setExpandedMetaRows] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);

  useEffect(() => {
    if (initialized.current) return;
    const lid = searchParams.get("logId") || "";
    const et = searchParams.get("entityType") || "";
    const ei = searchParams.get("entityId") || "";
    const employee = searchParams.get("employeeId") || "";
    const payrollRun = searchParams.get("payrollRunId") || "";
    const cid = searchParams.get("correlationId") || "";
    const ci = searchParams.get("customerId") || "";
    const cq = searchParams.get("customerQuery") || "";
    const act = searchParams.get("action") || "";
    const out = (searchParams.get("outcome") || "").toUpperCase();
    const actor = searchParams.get("actorId") || "";
    const at = searchParams.get("actorType") || "";
    const s = searchParams.get("start") || "";
    const e = searchParams.get("end") || "";
    const ms = searchParams.get("metaStatus") || "";
    const sp = searchParams.get("sourcePage") || "";
    const rm = (searchParams.get("riskMode") || "all").toLowerCase() as AuditRiskMode;
    const qm = (searchParams.get("queueMode") || "all").toLowerCase() as AuditQueueMode;
    setLogId(lid);
    setEntityType(et.toUpperCase());
    setEntityId(ei);
    setEmployeeId(employee);
    setPayrollRunId(payrollRun);
    setCorrelationId(cid);
    setCustomerId(ci);
    setCustomerSearch(cq || ci);
    setAction(act);
    setOutcome(["SUCCESS", "FAILED", "PARTIAL"].includes(out) ? out : "");
    setActorId(actor);
    setActorType(at.toUpperCase());
    setStart(s);
    setEnd(e);
    setMetaStatus(ms.toUpperCase());
    setSourcePage(normalizeSourcePage(sp));
    setRiskMode(["all", "exceptions", "critical", "needs_review"].includes(rm) ? rm : "all");
    setQueueMode(
      [
        "all",
        "critical_unreviewed",
        "archive_soon_unreviewed",
        "needs_assignment",
        "overdue_tasks",
        "overdue_reviews_critical",
        "overdue_reviews_high",
        "overdue_reviews_medium",
      ].includes(qm)
        ? qm
        : "all",
    );
    initialized.current = true;
    setFiltersReady(true);
  }, [searchParams]);

  useEffect(() => {
    const term = customerSearch.trim();
    if (term.length < 2) {
      setCustomerOptions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        setCustomerLookupLoading(true);
        const sp = new URLSearchParams();
        sp.set("name", term);
        sp.set("limit", "8");
        const res = await fetch(`/api/admin/customers/suggest?${sp.toString()}`);
        const payload = await res.json().catch(() => ({ items: [] }));
        if (!cancelled) {
          setCustomerOptions(Array.isArray(payload?.items) ? payload.items : []);
        }
      } catch {
        if (!cancelled) setCustomerOptions([]);
      } finally {
        if (!cancelled) setCustomerLookupLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [customerSearch]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/admin/audit/saved-filters");
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to load saved filters.");
        if (cancelled) return;
        setSavedFilters(Array.isArray(payload?.items) ? payload.items : []);
        setSavedFiltersSource("server");
        savedFiltersHydrated.current = true;
      } catch {
        const raw = window.localStorage.getItem("admin-audit-saved-filters");
        if (!raw) {
          if (!cancelled) {
            setSavedFiltersSource("local");
            savedFiltersHydrated.current = true;
          }
          return;
        }
        try {
          const parsed = JSON.parse(raw) as AuditSavedFilter[];
          if (!cancelled && Array.isArray(parsed)) {
            setSavedFilters(parsed);
          }
        } catch {
          // ignore
        } finally {
          if (!cancelled) {
            setSavedFiltersSource("local");
            savedFiltersHydrated.current = true;
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!savedFiltersHydrated.current) return;
    if (savedFiltersSource !== "local") return;
    window.localStorage.setItem(
      "admin-audit-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters, savedFiltersSource]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-audit-column-widths");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setColumnWidths((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-audit-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(120, startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [key]: next }));
    };
    const handleUp = () => {
      if (!resizing.current) return;
      resizing.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 160,
    };
    document.body.style.cursor = "col-resize";
  };

  const dateRangeError = useMemo(() => {
    if (!start || !end) return "";
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T00:00:00`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return "Enter valid start and end dates.";
    }
    if (startDate.getTime() > endDate.getTime()) {
      return "From date must be on or before To date.";
    }
    return "";
  }, [start, end]);

  const safeStart = dateRangeError ? "" : start;
  const safeEnd = dateRangeError ? "" : end;

  const params = new URLSearchParams();
  if (logId) params.set("logId", logId);
  if (entityType) params.set("entityType", entityType);
  if (entityId) params.set("entityId", entityId);
  if (employeeId) params.set("employeeId", employeeId);
  if (payrollRunId) params.set("payrollRunId", payrollRunId);
  if (correlationId) params.set("correlationId", correlationId);
  if (customerId) params.set("customerId", customerId);
  if (!customerId && customerSearch.trim().length >= 2) {
    params.set("customerQuery", customerSearch.trim());
  }
  if (action) params.set("action", action);
  if (outcome) params.set("outcome", outcome);
  if (actorId) params.set("actorId", actorId);
  if (actorType) params.set("actorType", actorType);
  if (safeStart) params.set("start", safeStart);
  if (safeEnd) params.set("end", safeEnd);
  if (metaStatus) params.set("metaStatus", metaStatus);
  if (sourcePage) params.set("sourcePage", sourcePage);
  if (riskMode !== "all") params.set("riskMode", riskMode);
  if (queueMode !== "all") params.set("queueMode", queueMode);
  if (scopedView) params.set("scope", scopedView);
  params.set("paginate", "1");
  params.set("includeSummary", "1");
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  const queryKey = [
    "admin",
    "audit",
    logId,
    entityType,
    entityId,
    employeeId,
    payrollRunId,
    correlationId,
    customerId,
    customerSearch,
    action,
    outcome,
    actorId,
    actorType,
    safeStart,
    safeEnd,
    metaStatus,
    sourcePage,
    riskMode,
    queueMode,
    scopedView,
    page,
    pageSize,
  ];

  const { data: filterData } = useClientQuery({
    queryKey: ["admin", "audit", "filters"],
    queryFn: async () => {
      const r = await fetch("/api/admin/audit/filters");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
      return j as AuditFilters;
    },
    refetchInterval: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const filterActions = useMemo(
    () =>
      Array.from(new Set([...(filterData?.actions ?? []), ...KNOWN_SECURITY_AUDIT_ACTIONS])).sort((left, right) =>
        humanizeAuditLabel(left).localeCompare(humanizeAuditLabel(right)),
      ),
    [filterData],
  );
  const filterEntityTypes = useMemo(() => filterData?.entityTypes ?? [], [filterData]);
  const filterActors = useMemo(() => filterData?.actors ?? [], [filterData]);

  const { data, error, isPending } = useClientQuery({
    queryKey,
    queryFn: () => fetcher(`/api/admin/audit?${params.toString()}`),
    enabled: filtersReady,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const rows = useMemo(() => data?.items ?? [], [data]);
  const riskSettings = data?.riskSettings;
  const assigneeOptions = useMemo(
    () => filterActors.filter((actor) => actor.role === "ADMIN"),
    [filterActors],
  );
  const parseRowTask = (row: AuditRow) => {
    const meta = (row.meta || {}) as Record<string, unknown>;
    const statusRaw = String(meta.reviewTaskStatus || "OPEN").toUpperCase();
    const status: ReviewTaskStatus =
      statusRaw === "IN_PROGRESS" || statusRaw === "RESOLVED" ? statusRaw : "OPEN";
    const evidence = Array.isArray(meta.reviewTaskEvidence)
      ? (meta.reviewTaskEvidence as Array<Record<string, unknown>>)
          .map((item) => ({
            url: String(item?.url || "").trim(),
            name: String(item?.name || "").trim() || "Evidence",
            type: String(item?.type || "").trim() || "image/*",
            size: Number(item?.size || 0),
            uploadedAt: String(item?.uploadedAt || "").trim() || new Date().toISOString(),
          }))
          .filter((item) => item.url)
      : [];
    return {
      status,
      assigneeId: String(meta.reviewTaskAssigneeId || "").trim(),
      assigneeName: String(meta.reviewTaskAssigneeName || "").trim(),
      dueAt: String(meta.reviewTaskDueAt || "").trim(),
      note: String(meta.reviewTaskNote || "").trim(),
      evidence,
    };
  };
  const riskById = useMemo(() => {
    const map = new Map<
      string,
      ReturnType<typeof evaluateAuditRisk>
    >();
    rows.forEach((row) => {
      map.set(
        row.id,
        evaluateAuditRisk({
          action: row.action,
          entityType: row.entityType,
          meta: row.meta,
          settings: riskSettings,
        }),
      );
    });
    return map;
  }, [rows, riskSettings]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, data?.totalPages ?? 1);
  const currentPage = Math.min(page, totalPages);
  const paginatedRows = rows;
  const reviewableRowIds = useMemo(
    () =>
      rows
        .filter((row) => {
          const risk = riskById.get(row.id);
          return Boolean(risk && risk.severity !== "LOW");
        })
        .map((row) => row.id),
    [rows, riskById],
  );
  const allReviewableSelected =
    reviewableRowIds.length > 0 &&
    reviewableRowIds.every((id) => selectedRowIds.has(id));
  const queueSummary = useMemo(() => {
    if (data?.summary) return data.summary;
    const now = new Date();
    let needsReview = 0;
    let critical = 0;
    let reviewedToday = 0;
    rows.forEach((row) => {
      const risk = riskById.get(row.id);
      if (!risk || risk.severity === "LOW") return;
      if (!risk.reviewed) needsReview += 1;
      if (risk.severity === "CRITICAL") critical += 1;
      if (risk.reviewedAt) {
        const reviewedAt = new Date(risk.reviewedAt);
        if (
          reviewedAt.getFullYear() === now.getFullYear() &&
          reviewedAt.getMonth() === now.getMonth() &&
          reviewedAt.getDate() === now.getDate()
        ) {
          reviewedToday += 1;
        }
      }
    });
    return {
      needsReview,
      critical,
      reviewedToday,
      overdueCritical: 0,
      overdueHigh: 0,
      overdueMedium: 0,
      archiveReminder: 0,
      archiveEscalation: 0,
      archiveNeedsAssignment: 0,
      eligibleForArchiveUnreviewed: 0,
      openTasks: 0,
      inProgressTasks: 0,
      overdueTasks: 0,
    };
  }, [rows, riskById, data?.summary]);

  const severityBadge = (severity: AuditRiskSeverity) => {
    if (severity === "CRITICAL") return { label: "Critical", className: "border-red-300 bg-red-50 text-red-700" };
    if (severity === "HIGH") return { label: "High", className: "border-amber-300 bg-amber-50 text-amber-800" };
    if (severity === "MEDIUM") return { label: "Medium", className: "border-orange-300 bg-orange-50 text-orange-800" };
    return { label: "Low", className: "border-emerald-300 bg-emerald-50 text-emerald-700" };
  };

  useEffect(() => {
    setSelectedRowIds((prev) => {
      const allowed = new Set(rows.map((row) => row.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (allowed.has(id)) next.add(id);
      });
      return next;
    });
  }, [rows]);

  useEffect(() => {
    setPage((prev) => (prev === 1 ? prev : 1));
    // Reset to first page when filters change.
  }, [
    logId,
    entityType,
    entityId,
    employeeId,
    payrollRunId,
    correlationId,
    customerId,
    customerSearch,
    action,
    outcome,
    actorId,
    actorType,
    safeStart,
    safeEnd,
    metaStatus,
    sourcePage,
    riskMode,
    queueMode,
    scopedView,
  ]);

  useEffect(() => {
    const updateWidths = () => {
      const container = tableWrapRef.current?.querySelector<HTMLDivElement>(
        '[data-slot="table-container"]',
      );
      if (!container) return;
      setTableScrollWidth(container.scrollWidth);
      setTableClientWidth(container.clientWidth);
    };
    const raf = window.requestAnimationFrame(updateWidths);
    window.addEventListener("resize", updateWidths);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateWidths);
    };
  }, [columnWidths, data]);

  useEffect(() => {
    const top = topScrollRef.current;
    const container = tableWrapRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="table-container"]',
    );
    if (!top || !container) return;
    const syncTop = () => {
      if (container.scrollLeft !== top.scrollLeft) {
        container.scrollLeft = top.scrollLeft;
      }
    };
    const syncBottom = () => {
      if (top.scrollLeft !== container.scrollLeft) {
        top.scrollLeft = container.scrollLeft;
      }
    };
    top.addEventListener("scroll", syncTop);
    container.addEventListener("scroll", syncBottom);
    return () => {
      top.removeEventListener("scroll", syncTop);
      container.removeEventListener("scroll", syncBottom);
    };
  }, [tableScrollWidth]);

  const clearFilters = () => {
    setLogId("");
    setEntityType("");
    setEntityId("");
    setEmployeeId("");
    setPayrollRunId("");
    setCorrelationId("");
    setCustomerId("");
    setCustomerSearch("");
    setCustomerOptions([]);
    setShowCustomerOptions(false);
    setAction("");
    setOutcome("");
    setActorId("");
    setActorType("");
    setMetaStatus("");
    setSourcePage("");
    setRiskMode("all");
    setQueueMode("all");
    setEmployeeStatus("");
    setJobStatus("");
    setIssueStatus("");
    setSelectedRowIds(new Set());
    setPage(1);
    const nextParams = new URLSearchParams();
    if (scopedView) nextParams.set("scope", scopedView);
    replaceAuditBrowserUrl(nextParams);
  };

  const refreshAuditQueries = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin", "audit"] });
  };

  const clearAll = () => {
    clearFilters();
    setStart("");
    setEnd("");
    setPage(1);
  };

  const buildCurrentFilterState = () => ({
    logId,
    entityType,
    entityId,
    employeeId,
    payrollRunId,
    correlationId,
    customerId,
    customerSearch,
    action,
    outcome,
    actorId,
    actorType,
    start,
    end,
    metaStatus,
    sourcePage,
    riskMode,
    queueMode,
    pageSize,
  });
  const { data: performanceData } = useClientQuery<{ days: number; items: AuditPerformanceItem[] }>({
    queryKey: ["admin", "audit", "reviewer-performance", 30],
    queryFn: async () => {
      const response = await fetch("/api/admin/audit/reviewer-performance?days=30");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load reviewer performance.");
      return payload as { days: number; items: AuditPerformanceItem[] };
    },
    enabled: !sourcePage.trim(),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: 60_000,
  });
  const { data: notificationCountsData } = useClientQuery<{
    counts?: { overdueReview?: number; overdueTask?: number; archiveEscalation?: number };
  }>({
    queryKey: ["admin", "audit", "notifications-counts"],
    queryFn: async () => {
      const response = await fetch("/api/admin/audit/notifications?limit=1");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load notifications.");
      return payload as { counts?: { overdueReview?: number; overdueTask?: number; archiveEscalation?: number } };
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    if (!notificationCountsData?.counts) return;
    const payload = notificationCountsData;
      setNotificationCounts({
        overdueReview: Number(payload?.counts?.overdueReview || 0),
        overdueTask: Number(payload?.counts?.overdueTask || 0),
        archiveEscalation: Number(payload?.counts?.archiveEscalation || 0),
      });
  }, [notificationCountsData]);

  const saveCurrentFilter = async () => {
    if (dateRangeError) {
      setSavedFilterError("Fix the date range before saving this filter.");
      return;
    }
    const normalizedName = savedFilterName.trim();
    if (normalizedName.length < 3) {
      setSavedFilterError("Filter name must be at least 3 characters.");
      return;
    }
    if (normalizedName.length > 60) {
      setSavedFilterError("Filter name must be 60 characters or fewer.");
      return;
    }
    const existing = savedFilters.find(
      (item) =>
        (item.canEdit ?? true) &&
        item.name.trim().toLowerCase() === normalizedName.toLowerCase(),
    );
    if (
      existing &&
      !window.confirm(`Replace saved filter "${existing.name}" with current filters?`)
    ) {
      return;
    }
    try {
      if (savedFiltersSource === "server") {
        const response = await fetch("/api/admin/audit/saved-filters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: normalizedName,
            isShared: shareSavedFilter,
            state: buildCurrentFilterState(),
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to save filter.");
        const row = payload as AuditSavedFilter;
        setSavedFilters((prev) => [row, ...prev.filter((item) => item.id !== row.id)]);
      } else {
        const entry: AuditSavedFilter = {
          id: existing?.id || `${Date.now()}`,
          name: normalizedName,
          state: buildCurrentFilterState(),
          canEdit: true,
          isShared: shareSavedFilter,
        };
        setSavedFilters((prev) => [entry, ...prev.filter((item) => item.id !== entry.id)]);
      }
      setSavedFilterName("");
      setSavedFilterError("");
      toast.success(`Saved filter "${normalizedName}".`);
    } catch (error) {
      setSavedFilterError(error instanceof Error ? error.message : "Failed to save filter.");
    }
  };

  const applySavedFilter = (entry: AuditSavedFilter) => {
    const s = entry.state;
    setLogId(s.logId || "");
    setEntityType(s.entityType);
    setEntityId(s.entityId);
    setEmployeeId(s.employeeId || "");
    setPayrollRunId(s.payrollRunId || "");
    setCorrelationId(s.correlationId || "");
    setCustomerId(s.customerId);
    setCustomerSearch(s.customerSearch || s.customerId);
    setAction(s.action);
    setOutcome(s.outcome || "");
    setActorId(s.actorId);
    setActorType((s.actorType || "").toUpperCase());
    setStart(s.start);
    setEnd(s.end);
    setMetaStatus(s.metaStatus || "");
    setSourcePage(normalizeSourcePage(s.sourcePage || ""));
    const nextRiskMode = (s.riskMode || "all") as AuditRiskMode;
    const nextQueueMode = (s.queueMode || "all") as AuditQueueMode;
    setRiskMode(
      ["all", "exceptions", "critical", "needs_review"].includes(nextRiskMode)
        ? nextRiskMode
        : "all",
    );
    setQueueMode(
      [
        "all",
        "critical_unreviewed",
        "archive_soon_unreviewed",
        "needs_assignment",
        "overdue_tasks",
        "overdue_reviews_critical",
        "overdue_reviews_high",
        "overdue_reviews_medium",
      ].includes(nextQueueMode)
        ? nextQueueMode
        : "all",
    );
    setPageSize(s.pageSize);
    setPage(1);
  };

  const removeSavedFilter = (id: string) => {
    const target = savedFilters.find((entry) => entry.id === id);
    if (target && target.canEdit === false) return;
    if (!target) return;
    setPendingRemoveFilter(target);
    setRemoveFilterDialogOpen(true);
  };
  const confirmRemoveSavedFilter = async () => {
    if (!pendingRemoveFilter) return;
    try {
      if (savedFiltersSource === "server") {
        const response = await fetch(
          `/api/admin/audit/saved-filters/${encodeURIComponent(pendingRemoveFilter.id)}`,
          { method: "DELETE" },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to remove filter.");
      }
      setSavedFilters((prev) => prev.filter((f) => f.id !== pendingRemoveFilter.id));
      setRemoveFilterDialogOpen(false);
      setPendingRemoveFilter(null);
      toast.success("Saved filter removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove filter.");
    }
  };
  const clearSavedFilters = () => {
    const removableCount = savedFilters.filter((item) => item.canEdit !== false).length;
    if (!removableCount) return;
    setRemoveAllFiltersDialogOpen(true);
  };
  const confirmClearSavedFilters = async () => {
    try {
      if (savedFiltersSource === "server") {
        const response = await fetch("/api/admin/audit/saved-filters?scope=mine", {
          method: "DELETE",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.error || "Failed to remove filters.");
        setSavedFilters((prev) => prev.filter((item) => item.canEdit === false));
      } else {
        setSavedFilters([]);
      }
      setRemoveAllFiltersDialogOpen(false);
      toast.success("All saved filters removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove filters.");
    }
  };
  const customerOptionLabel = (item: CustomerSuggestItem) => {
    const name = item.name?.trim() || "Unknown";
    const email = item.email?.trim() || "";
    const phone = item.phone?.trim() || "";
    const secondary = [email, phone].filter(Boolean).join(" -- ");
    return secondary ? `${name} (${secondary})` : name;
  };

  const getColWidth = (id: string) => columnWidths[id] ?? 160;

  const toDateInput = (value: Date) => value.toISOString().slice(0, 10);
  const applyPreset = (preset: {
    entityType?: string;
    action?: string;
    actorType?: string;
    days?: number;
  }) => {
    const today = new Date();
    const startDate = preset.days ? new Date(today.getTime() - preset.days * 24 * 60 * 60 * 1000) : null;
    clearAll();
    setEntityType(preset.entityType ?? "");
    setAction(preset.action ?? "");
    setActorType((preset.actorType || "").toUpperCase());
    setStart(startDate ? toDateInput(startDate) : "");
    setEnd(toDateInput(today));
    setPage(1);
  };

  const applyEmployeeStatus = (value: string) => {
    setEmployeeStatus(value);
    setJobStatus("");
    setIssueStatus("");
    setMetaStatus(value);
    setEntityType("EMPLOYEE");
    setAction("");
    setPage(1);
  };

  const applyJobStatus = (value: string) => {
    setEmployeeStatus("");
    setJobStatus(value);
    setIssueStatus("");
    setMetaStatus(value);
    setEntityType("JOB_POSTING");
    setAction("");
    setPage(1);
  };

  const applyIssueStatus = (value: string) => {
    setEmployeeStatus("");
    setJobStatus("");
    setIssueStatus(value);
    setMetaStatus(value);
    setEntityType("STAFF_ISSUE");
    setAction("");
    setPage(1);
  };
  const resolveAuditEntityHref = (row: Pick<AuditRow, "entityType" | "entityId" | "meta">) => {
    const type = String(row.entityType || "").toUpperCase();
    const id = String(row.entityId || "").trim();
    const meta = (row.meta || {}) as Record<string, unknown>;
    if (!id) return null;
    const sourcePageHref = resolveSourcePageHref(meta.sourcePage);
    switch (type) {
      case "ACCOUNTINGREPORT":
        if (id.toLowerCase() === "balance-sheet") return "/admin/accounting/reports/balance-sheet";
        if (id.toLowerCase() === "reporting-pack") return "/admin/accounting/reports/pl";
        if (sourcePageHref) return sourcePageHref;
        return "/admin/accounting/reports/balance-sheet";
      case "ACCOUNTINGREPORTEXPORTJOB":
        if (sourcePageHref) return sourcePageHref;
        return "/admin/accounting/reports/balance-sheet";
      case "EMPLOYEE":
        return id.toLowerCase() === "staff_export"
          ? "/admin/hr/staff"
          : `/admin/hr/staff/${encodeURIComponent(id)}`;
      case "ORDER":
        return `/admin/orders/${id}`;
      case "PAYMENT":
        return `/admin/orders?paymentId=${encodeURIComponent(id)}`;
      case "PURCHASE":
        return `/admin/purchases?purchaseId=${encodeURIComponent(id)}`;
      case "EXPENSE":
        return `/admin/expenses/${id}`;
      case "PAYROLL_RUN":
        return `/admin/hr/payroll/${id}`;
      case "PAYROLLRUNREPORT":
        return `/admin/hr/payroll/${id}`;
      case "PAYSLIP":
        return `/admin/hr/paystubs/${id}`;
      case "SUPPLIER_PAYMENT":
        return `/admin/supplier-payments`;
      case "SUPPLIER":
        return `/admin/suppliers?focus=${encodeURIComponent(id)}`;
      case "PRODUCT":
        return `/admin/products?q=${encodeURIComponent(id)}`;
      case "PRODUCT_IMAGE":
        return meta.productId
          ? `/admin/products?q=${encodeURIComponent(String(meta.productId))}`
          : `/admin/products`;
      case "JOURNALENTRY":
        return `/admin/accounting/journal?entryId=${encodeURIComponent(id)}`;
      case "INVENTORY_LOT":
        return `/admin/inventory-lots?focus=${encodeURIComponent(id)}`;
      case "REPORT":
        return `/admin/audit?entityType=REPORT&entityId=${encodeURIComponent(id)}`;
      case "APPSETTING":
        return id === "audit.risk.settings" ? "/admin/audit/settings" : `/admin/settings/features`;
      case "AUDIT_LOG":
        return `/admin/audit?entityType=AUDIT_LOG&entityId=${encodeURIComponent(id)}`;
      default:
        if (sourcePageHref) return sourcePageHref;
        return null;
    }
  };
  const renderActorSummary = (row: AuditRow) => {
    const meta = (row.meta || {}) as Record<string, unknown>;
    const actorType = String(meta.actorType || "").toUpperCase();
    const customerName = String(meta.customerName || "").trim();
    const customerId = String(meta.customerId || "").trim();
    const affectedCustomer = customerName || (customerId ? formatIdReadable(customerId) : "");

    if (row.actor) {
      const actorLabel = row.actor.name || row.actor.email || row.actor.id;
      const sameAsActor =
        customerName &&
        String(actorLabel || "").trim().toLowerCase() === customerName.toLowerCase();
      return (
        <div className="min-w-0 space-y-0.5">
          <div className="font-medium text-xs truncate">{actorLabel}</div>
          <div className="text-[11px] text-muted-foreground truncate">
            {row.actor.email}
            {row.actor.role ? ` - ${row.actor.role}` : ""}
          </div>
          {!sameAsActor && affectedCustomer ? (
            <div className="text-[11px] text-muted-foreground truncate">
              For: {affectedCustomer}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium text-xs truncate">
          {actorType === "CUSTOMER" ? customerName || "Customer" : "System"}
        </div>
        <div className="text-[11px] text-muted-foreground truncate">
          {actorType || "SYSTEM"}
        </div>
        {affectedCustomer ? (
          <div className="text-[11px] text-muted-foreground truncate">
            For: {affectedCustomer}
          </div>
        ) : null}
      </div>
    );
  };
  const resolveAuditActionLabel = (row: Pick<AuditRow, "action" | "meta">) => {
    const meta = (row.meta || {}) as Record<string, unknown>;
    const exportLabel = String(meta.exportLabel || "").trim();
    if (exportLabel) return exportLabel;
    return humanizeAuditLabel(row.action);
  };
  const resolveAuditEntityLabel = (row: Pick<AuditRow, "entityType" | "entityId" | "meta">) => {
    const type = String(row.entityType || "").toUpperCase();
    const meta = (row.meta || {}) as Record<string, unknown>;
    const preferred =
      String(meta.reportLabel || meta.entityLabel || meta.report || "").trim();
    if (
      type === "ACCOUNTINGREPORT" ||
      type === "ACCOUNTINGREPORTEXPORTJOB" ||
      type === "REPORT" ||
      type === "PAYROLLRUNREPORT"
    ) {
      return preferred ? humanizeAuditLabel(preferred) : humanizeAuditLabel(row.entityId);
    }
    return formatIdReadable(row.entityId);
  };
  const renderEntitySummary = (row: AuditRow) => {
    const href = resolveAuditEntityHref(row);
    return (
      <div className="min-w-0 space-y-0.5">
        <span className="block font-mono text-[11px] truncate">{row.entityType}</span>
        <div className="text-[11px] text-muted-foreground truncate">
          {resolveAuditEntityLabel(row)}
        </div>
        {href ? (
          <Link
            href={href}
            className="text-[11px] underline text-muted-foreground"
          >
            View record
          </Link>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            No linked page
          </span>
        )}
      </div>
    );
  };
  const savedFiltersMine = useMemo(
    () => savedFilters.filter((entry) => entry.canEdit !== false),
    [savedFilters],
  );
  const savedFiltersShared = useMemo(
    () => savedFilters.filter((entry) => entry.canEdit === false),
    [savedFilters],
  );
  const copyFilterLink = async () => {
    if (dateRangeError) {
      toast.error("Fix the date range before copying a filter link.");
      return;
    }
    const query = params.toString();
    const base = `${window.location.origin}/admin/audit`;
    const link = query ? `${base}?${query}` : base;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Filter link copied.");
    } catch {
      toast.error("Could not copy link.");
    }
  };

  const getReviewTaskRequirementError = (row: AuditRow) => {
    const meta = (row.meta || {}) as Record<string, unknown>;
    if (!requiresReviewTask({ action: row.action, entityType: row.entityType, meta, settings: riskSettings })) return "";
    return getMissingTaskRequirement(meta);
  };

  const openReviewDialog = (row: AuditRow, nextReviewed: boolean) => {
    if (!nextReviewed && !isAdmin) {
      const risk = riskById.get(row.id);
      if (!(risk && risk.severity === "CRITICAL" && risk.reviewed)) {
        toast.error("Only ADMIN can clear a review mark.");
        return;
      }
    }
    if (nextReviewed) {
      const requirementError = getReviewTaskRequirementError(row);
      if (requirementError) {
        toast.error(requirementError);
        openTaskDialogForRow(row);
        return;
      }
    }
    setPendingReviewDialog({
      ids: [row.id],
      actionSamples: [row.action],
      nextReviewed,
    });
    setReviewNoteInput("");
    setReviewDialogOpen(true);
  };

  const openBulkReviewDialog = (nextReviewed: boolean) => {
    if (!nextReviewed && !isAdmin) {
      toast.error("Only ADMIN can clear review marks.");
      return;
    }
    const selectedRows = rows.filter((row) => selectedRowIds.has(row.id));
    if (!selectedRows.length) return;
    if (nextReviewed) {
      const blocked = selectedRows.find((row) => Boolean(getReviewTaskRequirementError(row)));
      if (blocked) {
        toast.error(`${getReviewTaskRequirementError(blocked)} (blocked: ${blocked.action})`);
        openTaskDialogForRow(blocked);
        return;
      }
    }
    const actionSamples = [...new Set(selectedRows.map((row) => row.action))].slice(0, 5);
    setPendingReviewDialog({
      ids: selectedRows.map((row) => row.id),
      actionSamples,
      nextReviewed,
    });
    setReviewNoteInput("");
    setReviewDialogOpen(true);
  };

  const submitReviewChange = async () => {
    if (!pendingReviewDialog) return;
    if (clearReasonError) {
      toast.error(clearReasonError);
      return;
    }
    try {
      setReviewSubmitting(true);
      const response =
        pendingReviewDialog.ids.length === 1
          ? await fetch(
              `/api/admin/audit/${encodeURIComponent(pendingReviewDialog.ids[0] || "")}/review`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  reviewed: pendingReviewDialog.nextReviewed,
                  note: reviewNoteInput.trim() || undefined,
                }),
              },
            )
          : await fetch("/api/admin/audit/review/bulk", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ids: pendingReviewDialog.ids,
                reviewed: pendingReviewDialog.nextReviewed,
                note: reviewNoteInput.trim() || undefined,
              }),
            });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to update review status.");
      setReviewDialogOpen(false);
      setPendingReviewDialog(null);
      setReviewNoteInput("");
      setSelectedRowIds(new Set());
      if (payload?.pendingApproval) {
        toast.success("Critical clear request submitted for admin approval.");
        await refreshAuditQueries();
        return;
      }
      toast.success(
        pendingReviewDialog.nextReviewed
          ? `Marked ${pendingReviewDialog.ids.length} row(s) reviewed.`
          : `Cleared review for ${pendingReviewDialog.ids.length} row(s).`,
      );
      await refreshAuditQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update review status.");
    } finally {
      setReviewSubmitting(false);
    }
  };

  const toggleSelectedRow = (rowId: string, checked: boolean) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  };

  const setSelectAllReviewable = (checked: boolean) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      reviewableRowIds.forEach((id) => {
        if (checked) next.add(id);
        else next.delete(id);
      });
      return next;
    });
  };

  const openTaskDialogForRow = (row: AuditRow) => {
    if (!canManageTasks) {
      toast.error("Only ADMIN can manage review tasks.");
      return;
    }
    const task = parseRowTask(row);
    setPendingTaskRow(row);
    setPendingTaskIds([row.id]);
    setTaskDraft({
      status: task.status,
      assigneeId: task.assigneeId,
      dueAt: task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : "",
      note: task.note,
    });
    setTaskEvidence(task.evidence || []);
    setTaskDialogOpen(true);
  };
  const openBulkTaskDialog = () => {
    if (!canManageTasks) {
      toast.error("Only ADMIN can manage review tasks.");
      return;
    }
    const selectedRows = rows.filter((row) => selectedRowIds.has(row.id));
    if (!selectedRows.length) {
      toast.error("Select at least one row first.");
      return;
    }
    const firstTask = parseRowTask(selectedRows[0]);
    setPendingTaskRow(null);
    setPendingTaskIds(selectedRows.map((row) => row.id));
    setTaskDraft({
      status: firstTask.status,
      assigneeId: "",
      dueAt: "",
      note: "",
    });
    setTaskEvidence([]);
    setTaskDialogOpen(true);
  };

  const uploadTaskEvidence = async (file: File) => {
    if (!file) return;
    try {
      setTaskEvidenceUploading(true);
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body: formData });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to upload evidence.");
      const url = String(payload?.url || "").trim();
      if (!url) throw new Error("Upload succeeded but no URL was returned.");
      setTaskEvidence((prev) => [
        ...prev,
        {
          url,
          name: file.name || "Evidence",
          type: file.type || "image/*",
          size: file.size || 0,
          uploadedAt: new Date().toISOString(),
        },
      ]);
      toast.success("Evidence uploaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload evidence.");
    } finally {
      setTaskEvidenceUploading(false);
    }
  };

  const openHistoryDialog = async (row: AuditRow) => {
    setHistoryRow(row);
    setHistoryItems([]);
    setHistoryError("");
    setHistoryDialogOpen(true);
    try {
      setHistoryLoading(true);
      const response = await fetch(`/api/admin/audit/${encodeURIComponent(row.id)}/history`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load review history.");
      setHistoryItems(Array.isArray(payload?.items) ? payload.items : []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Failed to load review history.");
    } finally {
      setHistoryLoading(false);
    }
  };

  const openNotificationCenter = async () => {
    setNotificationOpen(true);
    setNotificationLoading(true);
    setNotificationError("");
    try {
      const response = await fetch("/api/admin/audit/notifications?limit=40");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to load notifications.");
      setNotificationItems(Array.isArray(payload?.items) ? payload.items : []);
      setNotificationCounts({
        overdueReview: Number(payload?.counts?.overdueReview || 0),
        overdueTask: Number(payload?.counts?.overdueTask || 0),
        archiveEscalation: Number(payload?.counts?.archiveEscalation || 0),
      });
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "Failed to load notifications.");
    } finally {
      setNotificationLoading(false);
    }
  };

  const approveOrRejectClearRequest = async (row: AuditRow, approved: boolean) => {
    try {
      const response = await fetch(
        `/api/admin/audit/${encodeURIComponent(row.id)}/review-clear-approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to process approval.");
      toast.success(approved ? "Clear request approved." : "Clear request rejected.");
      await refreshAuditQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to process approval.");
    }
  };

  const taskValidationError = useMemo(() => {
    if (taskDraft.status !== "OPEN" && !taskDraft.assigneeId) {
      return "Assign an owner before using In progress or Resolved.";
    }
    if (taskDraft.dueAt) {
      const due = new Date(`${taskDraft.dueAt}T23:59:59`);
      if (Number.isNaN(due.getTime())) return "Enter a valid due date.";
    }
    return "";
  }, [taskDraft]);

  const submitTaskUpdate = async () => {
    if (!pendingTaskRow && pendingTaskIds.length === 0) return;
    if (taskValidationError) {
      toast.error(taskValidationError);
      return;
    }
    try {
      setTaskSubmitting(true);
      const response =
        pendingTaskIds.length > 1
          ? await fetch("/api/admin/audit/task/bulk", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ids: pendingTaskIds,
                status: taskDraft.status,
                assigneeId: taskDraft.assigneeId || "",
                dueAt: taskDraft.dueAt || "",
                note: taskDraft.note.trim() || undefined,
                evidence: taskEvidence,
              }),
            })
          : await fetch(
              `/api/admin/audit/${encodeURIComponent(pendingTaskRow?.id || pendingTaskIds[0] || "")}/task`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  status: taskDraft.status,
                  assigneeId: taskDraft.assigneeId || "",
                  dueAt: taskDraft.dueAt || "",
                  note: taskDraft.note.trim() || undefined,
                  evidence: taskEvidence,
                }),
              },
            );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to update review task.");
      toast.success(
        pendingTaskIds.length > 1
          ? `Updated review task for ${pendingTaskIds.length} rows.`
          : "Review task updated.",
      );
      setTaskDialogOpen(false);
      setPendingTaskRow(null);
      setPendingTaskIds([]);
      await refreshAuditQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update review task.");
    } finally {
      setTaskSubmitting(false);
    }
  };

  const sendEscalationNotification = async () => {
    try {
      setNotifySubmitting(true);
      const response = await fetch("/api/admin/audit/notify/escalations", {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to send escalation notification.");
      toast.success(
        payload?.simulated
          ? `Escalation notification simulated for ${Number(payload?.recipientCount || 0)} recipient(s).`
          : `Escalation notification sent to ${Number(payload?.recipientCount || 0)} recipient(s).`,
      );
      setNotifyDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send escalation notification.");
    } finally {
      setNotifySubmitting(false);
    }
  };

  const renderRiskSummary = (row: AuditRow) => {
    const risk = riskById.get(row.id);
    if (!risk) return null;
    const meta = (row.meta || {}) as Record<string, unknown>;
    const clearRequestStatus = String(meta.reviewClearRequestStatus || "").toUpperCase();
    const tone = severityBadge(risk.severity);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={tone.className}>{tone.label}</Badge>
        {risk.reviewed ? (
          <Badge variant="outline" className="border-sky-300 bg-sky-50 text-sky-700">
            Reviewed
          </Badge>
        ) : (
          <Badge variant="outline" className="border-zinc-300 bg-zinc-50 text-zinc-700">
            Not reviewed
          </Badge>
        )}
        {clearRequestStatus === "PENDING_APPROVAL" ? (
          <Badge variant="outline" className="border-violet-300 bg-violet-50 text-violet-700">
            Clear pending approval
          </Badge>
        ) : null}
      </div>
    );
  };
  const formatDurationFromMs = (ms: number) => {
    const abs = Math.abs(ms);
    const mins = Math.floor(abs / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };
  const getSlaHoursForSeverity = (severity: AuditRiskSeverity) => {
    if (severity === "CRITICAL") return riskSettings?.reviewSlaHours.critical ?? 24;
    if (severity === "HIGH") return riskSettings?.reviewSlaHours.high ?? 72;
    return riskSettings?.reviewSlaHours.medium ?? 168;
  };
  const renderAgingSummary = (row: AuditRow) => {
    const createdAtMs = new Date(row.createdAt).getTime();
    if (!Number.isFinite(createdAtMs)) return "Age: -";
    const ageMs = Date.now() - createdAtMs;
    const ageLabel = `Age ${formatDurationFromMs(ageMs)}`;
    const risk = riskById.get(row.id);
    if (!risk || risk.severity === "LOW" || risk.reviewed) return ageLabel;
    const dueMs = createdAtMs + getSlaHoursForSeverity(risk.severity) * 60 * 60 * 1000;
    const delta = dueMs - Date.now();
    if (delta >= 0) return `${ageLabel} | SLA due in ${formatDurationFromMs(delta)}`;
    return `${ageLabel} | Overdue by ${formatDurationFromMs(delta)}`;
  };
  const clearReasonError =
    pendingReviewDialog && !pendingReviewDialog.nextReviewed && reviewNoteInput.trim().length < 8
      ? "Clear reason is required (minimum 8 characters)."
      : "";

  const renderMetaCell = (row: AuditRow) => {
    const meta = (row.meta || {}) as Record<string, unknown>;
    const actorName = String(meta.actorName || row.actor?.name || row.actor?.email || "").trim();
    const actorEmail = String(meta.actorEmail || row.actor?.email || "").trim();
    const actorRole = String(meta.actorRole || row.actor?.role || "").trim();
    const initiatorText = actorName || actorEmail
      ? `${actorName || actorEmail} (${actorEmail || "email not provided"} | ${actorRole || "role not provided"})`
      : "System (no linked user account)";
    const initiatorLine = {
      key: "initiator",
      content: (
        <>
          <span className="font-medium">Initiated by:</span>{" "}
          {initiatorText}
        </>
      ),
    };
    const auditContextLines: Array<{ key: string; content: React.ReactNode }> = [
      ...(row.outcome
        ? [
            {
              key: "outcome",
              content: (
                <>
                  <span className="font-medium">Outcome:</span> {humanizeAuditLabel(row.outcome)}
                </>
              ),
            },
          ]
        : []),
      ...(row.requestId
        ? [
            {
              key: "requestId",
              content: (
                <>
                  <span className="font-medium">Request ID:</span> {row.requestId}
                </>
              ),
            },
          ]
        : []),
      ...(row.ipAddress
        ? [
            {
              key: "ipAddress",
              content: (
                <>
                  <span className="font-medium">IP:</span> {row.ipAddress}
                </>
              ),
            },
          ]
        : []),
    ];
    if (!row.meta) {
      return (
        <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">
          <div>{initiatorLine.content}</div>
          {auditContextLines.map((line) => (
            <div key={line.key}>{line.content}</div>
          ))}
        </div>
      );
    }
    const formatByteSize = (value: unknown) => {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return "Not provided";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    };
    const metaExpanded = expandedMetaRows.has(row.id);
    const toggleMetaExpanded = () => {
      setExpandedMetaRows((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    };
    const renderCollapsibleLines = (lines: Array<{ key: string; content: React.ReactNode }>) => {
      const linesWithInitiator = lines.some((line) => line.key === "initiator")
        ? lines
        : [initiatorLine, ...auditContextLines, ...lines];
      const hasMore = linesWithInitiator.length > 5;
      const visible = metaExpanded ? linesWithInitiator : linesWithInitiator.slice(0, 5);
      return (
        <div
          className={hasMore ? "cursor-pointer" : ""}
          onClick={() => {
            if (!hasMore) return;
            toggleMetaExpanded();
          }}
        >
          {visible.map((line) => (
            <div key={line.key}>{line.content}</div>
          ))}
          {hasMore ? (
            <button
              type="button"
              className="italic underline"
              onClick={(event) => {
                event.stopPropagation();
                toggleMetaExpanded();
              }}
            >
              {metaExpanded ? "Show less" : "Show more"}
            </button>
          ) : null}
        </div>
      );
    };

    if (String(row.entityType || "").toUpperCase() === "EMPLOYEE" && row.action === "HR_EMPLOYEE_UPDATE") {
      const before =
        meta.before && typeof meta.before === "object" && !Array.isArray(meta.before)
          ? (meta.before as Record<string, unknown>)
          : null;
      const after =
        meta.after && typeof meta.after === "object" && !Array.isArray(meta.after)
          ? (meta.after as Record<string, unknown>)
          : null;
      const section = String(meta.section || "").trim();
      const operation = String(meta.operation || "").trim();
      const summary = String(meta.resultSummary || "").trim();
      const employeeFirstName = String(after?.firstName ?? before?.firstName ?? "").trim();
      const employeeLastName = String(after?.lastName ?? before?.lastName ?? "").trim();
      const employeeName = `${employeeFirstName} ${employeeLastName}`.trim();
      const employeeId = String(
        after?.employeeId ?? before?.employeeId ?? row.entityId ?? "",
      ).trim();
      const labelByKey: Record<string, string> = {
        email: "Email",
        phone: "Phone",
        bankName: "Bank name",
        bankCode: "Bank code",
        bankBranch: "Bank branch",
        bankAccountName: "Account name",
        bankAccountNumber: "Account number",
      };
      const formatValue = (value: unknown) => {
        if (value === null || value === undefined) return "Not provided";
        if (typeof value === "string") {
          const text = value.trim();
          if (!text) return "Not provided";
          if (!Number.isNaN(new Date(text).getTime()) && /(T|\d{4}-\d{2}-\d{2})/.test(text)) {
            return new Date(text).toLocaleString();
          }
          return text;
        }
        if (typeof value === "boolean") return value ? "Yes" : "No";
        if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
        return String(value);
      };
      const preferredKeys = section === "contact-details"
        ? ["email", "phone"]
        : section === "payroll-details"
          ? [
              "bankName",
              "bankCode",
              "bankBranch",
              "bankAccountName",
              "bankAccountNumber",
            ]
          : [];
      const candidateKeys = preferredKeys.length > 0
        ? preferredKeys
        : Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
      const changes = candidateKeys
        .map((key) => {
          const from = before ? before[key] : undefined;
          const to = after ? after[key] : undefined;
          const same = JSON.stringify(from) === JSON.stringify(to);
          return { key, from, to, same };
        })
        .filter((item) => !item.same);
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "employee",
          content: (
            <>
              <span className="font-medium">Employee:</span>{" "}
              {employeeName || "Not provided"}
              {employeeId ? ` (${formatIdReadable(employeeId)})` : ""}
            </>
          ),
        },
        {
          key: "summary",
          content: (
            <>
              <span className="font-medium">Result:</span> {summary || "Employee profile updated."}
            </>
          ),
        },
        {
          key: "scope",
          content: (
            <>
              <span className="font-medium">Section / operation:</span>{" "}
              {humanizeAuditLabel(section)} / {humanizeAuditLabel(operation)}
            </>
          ),
        },
      ];
      if (changes.length === 0) {
        lines.push({
          key: "changed",
          content: (
            <>
              <span className="font-medium">Changed fields:</span> No field changes detected.
            </>
          ),
        });
      } else {
        lines.push({
          key: "changed-header",
          content: (
            <>
              <span className="font-medium">Changed fields:</span>
            </>
          ),
        });
        changes.forEach((change) => {
          lines.push({
            key: `changed-${change.key}`,
            content: (
              <>
                <span className="font-medium">{labelByKey[change.key] || change.key}:</span>{" "}
                {formatValue(change.from)} {"->"} {formatValue(change.to)}
              </>
            ),
          });
        });
      }
      return (
        <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">
          {renderCollapsibleLines(lines)}
        </div>
      );
    }

    if (
      String(row.entityType || "").toUpperCase() === "HRPAYROLLREMITTANCE" &&
      row.action === "PAYROLL_REMITTANCE_STATUS_UPDATE"
    ) {
      const before =
        meta.before && typeof meta.before === "object" && !Array.isArray(meta.before)
          ? (meta.before as Record<string, unknown>)
          : null;
      const after =
        meta.after && typeof meta.after === "object" && !Array.isArray(meta.after)
          ? (meta.after as Record<string, unknown>)
          : null;
      const operation = String(meta.operation || "").trim().toLowerCase();
      const inferredLiability =
        operation.includes("ssnit") ? "SSNIT" : operation.includes("paye") ? "PAYE tax" : "";
      const liability = String(meta.liability || "").trim() || inferredLiability || "Statutory remittance";
      const month = String(meta.month || row.entityId || "").trim() || "Not provided";
      const beforeStatus = String(
        before?.status ??
          (liability === "SSNIT" ? before?.ssnitStatus : liability === "PAYE tax" ? before?.payeStatus : undefined) ??
          "",
      ).trim();
      const afterStatus = String(
        after?.status ??
          (liability === "SSNIT" ? after?.ssnitStatus : liability === "PAYE tax" ? after?.payeStatus : undefined) ??
          "",
      ).trim();
      const statusChange =
        beforeStatus || afterStatus
          ? `${beforeStatus || "Not provided"} -> ${afterStatus || "Not provided"}`
          : "Not provided";
      const paymentMethod = String(
        after?.paymentMethod ??
          before?.paymentMethod ??
          (liability === "SSNIT" ? after?.ssnitPaymentMethod ?? before?.ssnitPaymentMethod : undefined) ??
          (liability === "PAYE tax" ? after?.payePaymentMethod ?? before?.payePaymentMethod : undefined) ??
          "",
      ).trim();
      const remittedAt = String(after?.remittedAt || "").trim();
      const reference = String(after?.reference || "").trim();
      const summary = String(meta.resultSummary || "").trim();
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "liability",
          content: (
            <>
              <span className="font-medium">Liability:</span> {liability}
            </>
          ),
        },
        {
          key: "month",
          content: (
            <>
              <span className="font-medium">Month:</span> {month}
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Status:</span> {statusChange}
            </>
          ),
        },
      ];
      if (paymentMethod) {
        lines.push({
          key: "method",
          content: (
            <>
              <span className="font-medium">Payment method:</span>{" "}
              {paymentMethod === "CASH" ? "Cash" : paymentMethod === "BANK" ? "Bank" : paymentMethod}
            </>
          ),
        });
      }
      if (remittedAt) {
        lines.push({
          key: "remittedAt",
          content: (
            <>
              <span className="font-medium">Remitted at:</span> {new Date(remittedAt).toLocaleString()}
            </>
          ),
        });
      }
      if (reference) {
        lines.push({
          key: "reference",
          content: (
            <>
              <span className="font-medium">Reference:</span> {reference}
            </>
          ),
        });
      }
      lines.push({
        key: "summary",
        content: (
          <>
            <span className="font-medium">Result:</span> {summary || "Remittance status updated."}
          </>
        ),
      });
      return (
        <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">
          {renderCollapsibleLines(lines)}
        </div>
      );
    }

    if (row.entityType === "AUDIT_LOG" && row.action === "AUDIT_REVIEW_MARKED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Review state:</span>{" "}
              {String(meta.reviewStatusFrom || "NOT_REVIEWED")} {"->"}{" "}
              {String(meta.reviewStatusTo || "REVIEWED")}
            </>
          ),
        },
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Reviewed event:</span>{" "}
              {String(meta.targetAction || "-")} on{" "}
              {String(meta.targetEntityType || "-")}{" "}
              {meta.targetEntityId ? formatIdReadable(String(meta.targetEntityId)) : "-"}
            </>
          ),
        },
        {
          key: "reviewedBy",
          content: (
            <>
              <span className="font-medium">Marked reviewed by:</span>{" "}
              {String(meta.appliedReviewedByName || row.actor?.name || row.actor?.email || "-")}
            </>
          ),
        },
        {
          key: "reviewedAt",
          content: (
            <>
              <span className="font-medium">Marked reviewed at:</span>{" "}
              {meta.appliedReviewedAt ? new Date(String(meta.appliedReviewedAt)).toLocaleString() : "-"}
            </>
          ),
        },
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Review note:</span>{" "}
              {String(meta.note || meta.reviewNote || "-")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }
    if (row.entityType === "AUDIT_LOG" && row.action === "AUDIT_REVIEW_CLEAR_REQUESTED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Requested clear for:</span>{" "}
              {String(meta.targetAction || "-")} on{" "}
              {String(meta.targetEntityType || "-")}{" "}
              {meta.targetEntityId ? formatIdReadable(String(meta.targetEntityId)) : "-"}
            </>
          ),
        },
        {
          key: "requestedAt",
          content: (
            <>
              <span className="font-medium">Requested at:</span>{" "}
              {meta.requestedAt ? new Date(String(meta.requestedAt)).toLocaleString() : "-"}
            </>
          ),
        },
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Reason:</span> {String(meta.note || "-")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }
    if (
      row.entityType === "AUDIT_LOG" &&
      (row.action === "AUDIT_REVIEW_CLEAR_APPROVED" || row.action === "AUDIT_REVIEW_CLEAR_REJECTED")
    ) {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Approval target:</span>{" "}
              {String(meta.targetAction || "-")} on{" "}
              {String(meta.targetEntityType || "-")}{" "}
              {meta.targetEntityId ? formatIdReadable(String(meta.targetEntityId)) : "-"}
            </>
          ),
        },
        {
          key: "requested",
          content: (
            <>
              <span className="font-medium">Requested by:</span>{" "}
              {String(meta.requestedByName || meta.requestedByEmail || "-")}
            </>
          ),
        },
        {
          key: "approvedBy",
          content: (
            <>
              <span className="font-medium">{row.action === "AUDIT_REVIEW_CLEAR_APPROVED" ? "Approved by" : "Rejected by"}:</span>{" "}
              {String(meta.approvedByName || row.actor?.name || row.actor?.email || "-")}
            </>
          ),
        },
        {
          key: "approvalNote",
          content: (
            <>
              <span className="font-medium">Approval note:</span> {String(meta.approvalNote || "-")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "AUDIT_LOG" && row.action === "AUDIT_REVIEW_CLEARED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Review state:</span>{" "}
              {String(meta.reviewStatusFrom || "REVIEWED")} {"->"}{" "}
              {String(meta.reviewStatusTo || "NOT_REVIEWED")}
            </>
          ),
        },
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Re-opened event:</span>{" "}
              {String(meta.targetAction || "-")} on{" "}
              {String(meta.targetEntityType || "-")}{" "}
              {meta.targetEntityId ? formatIdReadable(String(meta.targetEntityId)) : "-"}
            </>
          ),
        },
        {
          key: "previousReviewedBy",
          content: (
            <>
              <span className="font-medium">Previous reviewed by:</span>{" "}
              {String(meta.previousReviewedByName || "-")}
            </>
          ),
        },
        {
          key: "previousReviewedAt",
          content: (
            <>
              <span className="font-medium">Previous reviewed at:</span>{" "}
              {meta.previousReviewedAt ? new Date(String(meta.previousReviewedAt)).toLocaleString() : "-"}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Clear reason:</span>{" "}
              {String(meta.note || "-")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "AUDIT_LOG" && (row.action === "AUDIT_REVIEW_BULK_MARKED" || row.action === "AUDIT_REVIEW_BULK_CLEARED")) {
      const from = (meta.reviewStatusFrom || {}) as { reviewed?: number; notReviewed?: number };
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "summary",
          content: (
            <>
              <span className="font-medium">Bulk review update:</span>{" "}
              {Number(meta.count || 0)} row(s) {"->"} {String(meta.reviewStatusTo || "-")}
            </>
          ),
        },
        {
          key: "before",
          content: (
            <>
              <span className="font-medium">Before update:</span>{" "}
              Reviewed {Number(from.reviewed || 0)}, Not reviewed {Number(from.notReviewed || 0)}
            </>
          ),
        },
        {
          key: "applied",
          content: (
            <>
              <span className="font-medium">Applied by:</span>{" "}
              {String(meta.appliedReviewedByName || row.actor?.name || row.actor?.email || "-")}{" "}
              {meta.appliedReviewedAt ? `at ${new Date(String(meta.appliedReviewedAt)).toLocaleString()}` : ""}
            </>
          ),
        },
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Reason/Note:</span>{" "}
              {String(meta.note || "-")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "AUDIT_LOG" && row.action === "AUDIT_REVIEW_TASK_UPDATED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Task target:</span>{" "}
              {String(meta.targetAction || "-")} on {String(meta.targetEntityType || "-")}{" "}
              {meta.targetEntityId ? formatIdReadable(String(meta.targetEntityId)) : "-"}
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Task status:</span>{" "}
              {String(meta.taskStatusFrom || "OPEN")} {"->"} {String(meta.taskStatusTo || "OPEN")}
            </>
          ),
        },
        {
          key: "owner",
          content: (
            <>
              <span className="font-medium">Task owner:</span>{" "}
              {meta.taskAssigneeTo ? formatIdReadable(String(meta.taskAssigneeTo)) : "Unassigned"}
            </>
          ),
        },
        {
          key: "due",
          content: (
            <>
              <span className="font-medium">Task due date:</span>{" "}
              {meta.taskDueAtTo ? new Date(String(meta.taskDueAtTo)).toLocaleDateString() : "Not set"}
            </>
          ),
        },
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Task note:</span> {String(meta.taskNote || "Not provided")}
            </>
          ),
        },
        {
          key: "evidence",
          content: (
            <>
              <span className="font-medium">Evidence files:</span>{" "}
              {Number(meta.evidenceCount || 0)}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }
    if (row.entityType === "AUDIT_LOG" && row.action === "AUDIT_REVIEW_TASK_BULK_UPDATED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "count",
          content: (
            <>
              <span className="font-medium">Bulk task update:</span> {Number(meta.count || 0)} row(s)
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Task status set to:</span> {String(meta.taskStatusTo || "-")}
            </>
          ),
        },
        {
          key: "assignee",
          content: (
            <>
              <span className="font-medium">Task owner set to:</span>{" "}
              {meta.taskAssigneeTo ? formatIdReadable(String(meta.taskAssigneeTo)) : "Unassigned"}
            </>
          ),
        },
        {
          key: "due",
          content: (
            <>
              <span className="font-medium">Task due date set to:</span>{" "}
              {meta.taskDueAtTo ? new Date(String(meta.taskDueAtTo)).toLocaleDateString() : "Not set"}
            </>
          ),
        },
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Task note:</span> {String(meta.taskNote || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "EXPENSE" && row.action === "EXPENSE_CREATE") {
      const reason = String(meta.reason || "").trim();
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "category",
          content: (
            <>
              <span className="font-medium">Category:</span> {String(meta.category || "-")}
            </>
          ),
        },
        {
          key: "amount",
          content: (
            <>
              <span className="font-medium">Amount:</span>{" "}
              {formatCurrency(Number(meta.amount || 0))}
            </>
          ),
        },
        {
          key: "vendor",
          content: (
            <>
              <span className="font-medium">Vendor:</span> {String(meta.vendor || "-")}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Reason:</span> {reason || "Not provided"}
            </>
          ),
        },
        {
          key: "reversal",
          content: (
            <>
              <span className="font-medium">Is reversal:</span>{" "}
              {Boolean(meta.isReversal) ? "Yes" : "No"}
            </>
          ),
        },
        {
          key: "reversalOf",
          content: (
            <>
              <span className="font-medium">Reversal of:</span>{" "}
              {meta.reversalOfId ? formatIdReadable(String(meta.reversalOfId)) : "None"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "SUPPLIER" && row.action === "SUPPLIER_PRICE_CHANGE") {
      const oldUnitCost = Number(meta.oldUnitCost ?? meta.oldCost ?? NaN);
      const newUnitCost = Number(meta.newUnitCost ?? meta.newCost ?? NaN);
      const changeAmount = Number(meta.changeAmount ?? (Number.isFinite(oldUnitCost) && Number.isFinite(newUnitCost) ? newUnitCost - oldUnitCost : NaN));
      const changePct = Number(meta.changePct ?? meta.changePercent ?? NaN);
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "supplier",
          content: (
            <>
              <span className="font-medium">Supplier:</span> {String(meta.supplier || "-")}{" "}
              ({meta.supplierId ? formatIdReadable(String(meta.supplierId)) : "-"})
            </>
          ),
        },
        {
          key: "product",
          content: (
            <>
              <span className="font-medium">Product:</span> {String(meta.product || meta.productName || "-")}{" "}
              ({meta.productId ? formatIdReadable(String(meta.productId)) : "-"})
            </>
          ),
        },
        {
          key: "unitCost",
          content: (
            <>
              <span className="font-medium">Unit cost change:</span>{" "}
              {Number.isFinite(oldUnitCost) ? formatCurrency(oldUnitCost) : "-"} {"->"}{" "}
              {Number.isFinite(newUnitCost) ? formatCurrency(newUnitCost) : "-"}
            </>
          ),
        },
        {
          key: "delta",
          content: (
            <>
              <span className="font-medium">Change amount:</span>{" "}
              {Number.isFinite(changeAmount) ? formatCurrency(changeAmount) : "-"}{" "}
              <span className="font-medium">Change %:</span>{" "}
              {Number.isFinite(changePct) ? `${changePct.toFixed(2)}%` : "-"}
            </>
          ),
        },
        {
          key: "purchaseId",
          content: (
            <>
              <span className="font-medium">Purchase reference:</span>{" "}
              {meta.purchaseId ? formatIdReadable(String(meta.purchaseId)) : "Not linked"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "OTC_SHIFT" && row.action === "OTC_SHIFT_CLOSE") {
      const range = (meta.range || {}) as { from?: string; to?: string };
      const expected = (meta.expected || {}) as { cash?: number; bank?: number; total?: number };
      const actual = (meta.actual || {}) as { cash?: number; bank?: number; total?: number };
      const variance = (meta.variance || {}) as { cash?: number; bank?: number; total?: number };
      const closedBy = (meta.closedBy || {}) as { name?: string; email?: string };
      const reconciliationIds = Array.isArray(meta.reconciliationIds)
        ? (meta.reconciliationIds as string[])
        : [];
      const overrideUsed = Boolean(meta.overrideUsed);
      const overrideReason = String(meta.overrideReason || "");

      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "shiftDay",
          content: (
            <>
              <span className="font-medium">Shift day:</span> {String(meta.day || "-")}
            </>
          ),
        },
        {
          key: "expected",
          content: (
            <>
              <span className="font-medium">Expected takings:</span>{" "}
              Cash {formatCurrency(Number(expected.cash || 0))}, Bank{" "}
              {formatCurrency(Number(expected.bank || 0))}, Total{" "}
              {formatCurrency(Number(expected.total || 0))}
            </>
          ),
        },
        {
          key: "actual",
          content: (
            <>
              <span className="font-medium">Counted takings:</span>{" "}
              Cash {formatCurrency(Number(actual.cash || 0))}, Bank{" "}
              {formatCurrency(Number(actual.bank || 0))}, Total{" "}
              {formatCurrency(Number(actual.total || 0))}
            </>
          ),
        },
        {
          key: "variance",
          content: (
            <>
              <span className="font-medium">Difference:</span>{" "}
              Cash {formatCurrency(Number(variance.cash || 0))}, Bank{" "}
              {formatCurrency(Number(variance.bank || 0))}, Total{" "}
              {formatCurrency(Number(variance.total || 0))}
            </>
          ),
        },
        {
          key: "paymentsOrders",
          content: (
            <>
              <span className="font-medium">Payments recorded / Orders handled:</span>{" "}
              {Number(meta.paymentCount || 0)} / {Number(meta.walkInOrderCount || 0)}
            </>
          ),
        },
        {
          key: "unpostedPayments",
          content: (
            <>
              <span className="font-medium">Payments not yet posted to accounts:</span>{" "}
              {Number(meta.unpostedPaymentCount || 0)}
            </>
          ),
        },
      ];
      if (meta.note) {
        lines.push({
          key: "note",
          content: (
            <>
              <span className="font-medium">Note:</span> {String(meta.note)}
            </>
          ),
        });
      }
      lines.push({
        key: "details",
        content: (
          <details>
            <summary className="cursor-pointer select-none text-[10px] underline">
              View details
            </summary>
            <div className="mt-1 space-y-1 rounded border bg-background/60 p-2 text-[10px]">
              <div>
                <span className="font-medium">Range:</span>{" "}
                {range.from ? new Date(range.from).toLocaleString() : "-"} to{" "}
                {range.to ? new Date(range.to).toLocaleString() : "-"}
              </div>
              <div>
                <span className="font-medium">Remaining OTC customer balance:</span>{" "}
                {formatCurrency(Number(meta.outstandingWalkInBalance || 0))}
              </div>
              <div>
                <span className="font-medium">Manual close override:</span>{" "}
                {overrideUsed ? "Used" : "Not used"}
              </div>
              {overrideUsed ? (
                <div>
                  <span className="font-medium">Why override was used:</span>{" "}
                  {overrideReason || "-"}
                </div>
              ) : null}
              {reconciliationIds.length > 0 ? (
                <div>
                  <span className="font-medium">Cash reconciliation references:</span>{" "}
                  {reconciliationIds.map((id) => formatIdReadable(id)).join(", ")}
                </div>
              ) : null}
              {closedBy.name || closedBy.email ? (
                <div>
                  <span className="font-medium">Closed by:</span>{" "}
                  {closedBy.name || closedBy.email}
                </div>
              ) : null}
            </div>
          </details>
        ),
      });

      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "OTC_SHIFT" && row.action === "OTC_SHIFT_OPEN") {
      const handover = (meta.handover || {}) as {
        fromShiftCloseId?: string | null;
        fromActorName?: string | null;
        fromActorEmail?: string | null;
        toActorName?: string | null;
        toActorEmail?: string | null;
        checklist?: {
          cashCountVerified?: boolean;
          paymentSummaryVerified?: boolean;
          pendingItemsReviewed?: boolean;
          notes?: string | null;
        } | null;
      };
      const checklist = handover.checklist || {};
      const openedBy =
        handover.toActorName ||
        handover.toActorEmail ||
        row.actor?.name ||
        row.actor?.email ||
        "-";
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "shiftDay",
          content: (
            <>
              <span className="font-medium">Shift day:</span> {String(meta.day || "-")}
            </>
          ),
        },
        {
          key: "openedAt",
          content: (
            <>
              <span className="font-medium">Opened at:</span>{" "}
              {meta.openedAt ? new Date(String(meta.openedAt)).toLocaleString() : "-"}
              {meta.openedAtTimezoneOffset ? ` (UTC${String(meta.openedAtTimezoneOffset)})` : ""}
            </>
          ),
        },
        {
          key: "openingFloat",
          content: (
            <>
              <span className="font-medium">Opening float:</span>{" "}
              {formatCurrency(Number(meta.openingCashFloat || 0))}
            </>
          ),
        },
        {
          key: "openedBy",
          content: (
            <>
              <span className="font-medium">Opened by:</span> {openedBy}
            </>
          ),
        },
        {
          key: "handoverFrom",
          content: (
            <>
              <span className="font-medium">Handover from:</span>{" "}
              {handover.fromActorName || handover.fromActorEmail || "-"}
            </>
          ),
        },
        {
          key: "handoverAck",
          content: (
            <>
              <span className="font-medium">Handover acknowledged:</span>{" "}
              {Boolean(meta.handoverAcknowledged) ? "Yes" : "No"}
            </>
          ),
        },
        {
          key: "checklist",
          content: (
            <>
              <span className="font-medium">Checklist:</span>{" "}
              cash {checklist.cashCountVerified ? "yes" : "no"}, payments{" "}
              {checklist.paymentSummaryVerified ? "yes" : "no"}, pending items{" "}
              {checklist.pendingItemsReviewed ? "yes" : "no"}
            </>
          ),
        },
      ];
      if (checklist.notes) {
        lines.push({
          key: "handoverNotes",
          content: (
            <>
              <span className="font-medium">Handover notes:</span> {checklist.notes}
            </>
          ),
        });
      }
      if (meta.note) {
        lines.push({
          key: "openNote",
          content: (
            <>
              <span className="font-medium">Open note:</span> {String(meta.note)}
            </>
          ),
        });
      }
      lines.push({
        key: "details",
        content: (
          <details>
            <summary className="cursor-pointer select-none text-[10px] underline">
              View details
            </summary>
            <div className="mt-1 space-y-1 rounded border bg-background/60 p-2 text-[10px]">
              <div>
                <span className="font-medium">From shift close:</span>{" "}
                {handover.fromShiftCloseId ? formatIdReadable(handover.fromShiftCloseId) : "-"}
              </div>
              <div>
                <span className="font-medium">Previous shift close:</span>{" "}
                {meta.previousShiftCloseId
                  ? formatIdReadable(String(meta.previousShiftCloseId))
                  : "-"}
              </div>
            </div>
          </details>
        ),
      });

      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (
      row.entityType === "B2B_PROCUREMENT_REQUEST" &&
      row.action === "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED"
    ) {
      const humanize = (value: unknown) =>
        String(value || "-")
          .replace(/_/g, " ")
          .toLowerCase()
          .replace(/\b\w/g, (ch) => ch.toUpperCase());
      const statusUpdate = (meta.statusUpdate || {}) as {
        from?: string;
        to?: string;
        reopen?: boolean;
        note?: string | null;
      };
      const notification = (meta.notification || {}) as {
        attempted?: boolean;
        channel?: string;
        ok?: boolean;
        detail?: string;
      };
      const snapshot = (meta.snapshot || {}) as {
        id?: string;
        requestType?: string;
        clinicName?: string;
        contactName?: string;
        contactPhone?: string | null;
        contactEmail?: string | null;
        poDocumentUrl?: string | null;
        accountManagerId?: string | null;
        updatedAt?: string;
        status?: string;
      };
      const detailRows: Array<[string, string]> = [
        ["Request ID", snapshot.id ? formatIdReadable(snapshot.id) : "-"],
        ["Clinic", snapshot.clinicName || "-"],
        ["Request Type", humanize(snapshot.requestType || "-")],
        ["Current Status", humanize(snapshot.status || statusUpdate.to || "-")],
        ["Contact", snapshot.contactName || "-"],
        ["Phone", snapshot.contactPhone || "-"],
        ["Email", snapshot.contactEmail || "-"],
        ["Assigned Manager", snapshot.accountManagerId ? formatIdReadable(snapshot.accountManagerId) : "-"],
        ["PO Document", snapshot.poDocumentUrl ? "Attached" : "None"],
        ["Last Updated", snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleString() : "-"],
      ];

      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Status change:</span>{" "}
              {humanize(statusUpdate.from || "-")} {"->"} {humanize(statusUpdate.to || snapshot.status || "-")}
              {statusUpdate.reopen ? " (reopened)" : ""}
            </>
          ),
        },
        {
          key: "clinicType",
          content: (
            <>
              <span className="font-medium">Clinic:</span> {snapshot.clinicName || "-"}{" "}
              <span className="font-medium">Request type:</span> {humanize(snapshot.requestType || "-")}
            </>
          ),
        },
        {
          key: "notification",
          content: (
            <>
              <span className="font-medium">Customer notification:</span>{" "}
              {notification.attempted ? (notification.ok ? "Sent" : "Failed") : "Not sent"}
              {notification.channel ? ` via ${notification.channel}` : ""}
              {notification.detail ? ` (${notification.detail})` : ""}
            </>
          ),
        },
      ];
      if (statusUpdate.note) {
        lines.push({
          key: "note",
          content: (
            <>
              <span className="font-medium">Note:</span> {statusUpdate.note}
            </>
          ),
        });
      }
      lines.push({
        key: "details",
        content: (
          <details>
            <summary className="cursor-pointer select-none text-[10px] underline">
              View details
            </summary>
            <div className="mt-1 space-y-1 rounded border bg-background/60 p-2 text-[10px]">
              {detailRows.map(([label, value]) => (
                <div key={label}>
                  <span className="font-medium">{label}:</span> {value}
                </div>
              ))}
            </div>
          </details>
        ),
      });

      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (
      row.entityType === "PAYMENT" &&
      (row.action === "PAYMENT_CREATE" ||
        row.action === "PAYMENT_REFUND" ||
        row.action === "PAYMENT_VOID")
    ) {
      const humanize = (value: unknown) =>
        String(value || "-")
          .replace(/_/g, " ")
          .toLowerCase()
          .replace(/\b\w/g, (ch) => ch.toUpperCase());
      const amount = Number(meta.amount || 0);
      const method = String(meta.paymentMethodLabel || meta.method || "-");
      const status = humanize(meta.status || "-");
      const customerName = String(meta.customerName || "").trim();
      const customerEmail = String(meta.customerEmail || "").trim();
      const customerPhone = String(meta.customerPhone || "").trim();
      const recordedByName = String(meta.recordedByName || "").trim();
      const recordedByRole = String(meta.recordedByRole || "").trim();
      const orderId = String(meta.orderId || "").trim();
      const invoiceNumber = String(meta.invoiceNumber || "").trim();
      const postingStatus = String(meta.postingStatus || "").trim();
      const journalEntryId = String(meta.journalEntryId || "").trim();
      const reference = String(meta.reference || meta.initialPaymentReference || "").trim();
      const externalReference = String(meta.externalReference || "").trim();
      const captureType = humanize(meta.captureType || "").trim();
      const orderStatusBefore = humanize(meta.orderStatusBefore || "").trim();
      const orderStatusAfter = humanize(meta.orderStatusAfter || "").trim();
      const isPendingPayment = status.toUpperCase() === "PENDING";
      const allocationScope = humanize(meta.allocationScope || "").trim();
      const ordersAffectedList = Array.isArray(meta.ordersAffected)
        ? (meta.ordersAffected as Array<unknown>)
            .map((value) => String(value || "").trim())
            .filter(Boolean)
        : [];
      const remainingBalanceBefore = Number(meta.remainingBalanceBefore ?? NaN);
      const remainingBalanceAfter = Number(meta.remainingBalanceAfter ?? NaN);
      const allocationsRaw = Array.isArray(meta.appliedAllocations)
        ? (meta.appliedAllocations as Array<Record<string, unknown>>)
        : [];
      const allocations = allocationsRaw
        .map((row) => {
          const orderId = String(row.orderId || "").trim();
          const applied = Number(row.amount || 0);
          const remainingAfter = Number(row.remainingAfter);
          if (!orderId || !Number.isFinite(applied) || applied <= 0) return null;
          return {
            orderId,
            applied,
            remainingAfter: Number.isFinite(remainingAfter) ? remainingAfter : null,
          };
        })
        .filter((row): row is { orderId: string; applied: number; remainingAfter: number | null } => Boolean(row));
      const appliedTotal = Number(meta.appliedTotal || 0);
      const rawPaymentCount = Number(meta.paymentCount || 0);
      const paymentCount = rawPaymentCount > 0 ? rawPaymentCount : 1;
      const rawOrderCount = Number(meta.orderCount || 0);
      const orderCount = rawOrderCount > 0 ? rawOrderCount : allocations.length;
      const batchId = String(meta.batchId || "").trim();
      const paymentLines: Array<{ key: string; content: React.ReactNode }> = [];

      if (customerName || customerEmail || customerPhone) {
        paymentLines.push({
          key: "customer",
          content: (
            <>
              <span className="font-medium">Customer:</span>{" "}
              {customerName || "-"}
              {customerEmail ? ` (${customerEmail})` : ""}
              {customerPhone ? ` | ${customerPhone}` : ""}
            </>
          ),
        });
      }
      if (recordedByName || recordedByRole) {
        paymentLines.push({
          key: "recordedBy",
          content: (
            <>
              <span className="font-medium">Recorded by:</span> {recordedByName || "-"}
              {recordedByRole ? ` (${recordedByRole})` : ""}
            </>
          ),
        });
      }
      paymentLines.push({
        key: "amountMethod",
        content: (
          <>
            <span className="font-medium">Amount:</span> {formatCurrency(amount)}{" "}
            <span className="font-medium">Method:</span> {method}
          </>
        ),
      });
      paymentLines.push({
        key: "statusRows",
        content: (
          <>
              <span className="font-medium">Status:</span> {status}{" "}
              <span className="font-medium">Payments in this event:</span> {paymentCount}
            </>
          ),
        });
      if (orderCount > 1 || batchId) {
        paymentLines.push({
          key: "batchContext",
          content: (
            <>
              {orderCount > 1 ? (
                <>
                  <span className="font-medium">Orders affected:</span> {orderCount}
                </>
              ) : null}
              {batchId ? (
                <>
                  {orderCount > 1 ? " " : ""}
                  <span className="font-medium">Group reference:</span> {formatIdReadable(batchId)}
                </>
              ) : null}
            </>
          ),
        });
      }
      if (allocationScope) {
        paymentLines.push({
          key: "allocationScope",
          content: (
            <>
              <span className="font-medium">How payment was allocated:</span> {allocationScope}
            </>
          ),
        });
      }
      if (orderId) {
        paymentLines.push({
          key: "orderInvoice",
          content: (
            <>
              <span className="font-medium">Order:</span> {formatIdReadable(orderId)}
              {invoiceNumber ? (
                <>
                  {" "}
                  <span className="font-medium">Invoice:</span> {invoiceNumber}
                </>
              ) : null}
            </>
          ),
        });
      }
      if (orderStatusBefore || orderStatusAfter) {
        const statusAfterDisplay =
          orderStatusAfter ||
          (isPendingPayment
            ? `${orderStatusBefore || "UNPAID"} (pending payment)`
            : "-");
        paymentLines.push({
          key: "statusTransition",
          content: (
            <>
              <span className="font-medium">Order status:</span>{" "}
              {orderStatusBefore || "-"} {"->"} {statusAfterDisplay}
            </>
          ),
        });
      }
      if (Number.isFinite(remainingBalanceAfter)) {
        paymentLines.push({
          key: "remaining",
          content: (
            <>
              <span className="font-medium">
                {orderId ? "Remaining after:" : "Customer balance after:"}
              </span>{" "}
              {formatCurrency(remainingBalanceAfter)}
            </>
          ),
        });
      }
      if (!orderId && Number.isFinite(remainingBalanceBefore)) {
        paymentLines.push({
          key: "remainingBefore",
          content: (
            <>
              <span className="font-medium">Customer balance before:</span>{" "}
              {formatCurrency(remainingBalanceBefore)}
            </>
          ),
        });
      }
      if (reference) {
        paymentLines.push({
          key: "reference",
          content: (
            <>
              <span className="font-medium">Reference:</span> {reference}
            </>
          ),
        });
      }
      if (externalReference) {
        paymentLines.push({
          key: "externalReference",
          content: (
            <>
              <span className="font-medium">External reference:</span> {externalReference}
            </>
          ),
        });
      }
      if (captureType) {
        paymentLines.push({
          key: "captureType",
          content: (
            <>
              <span className="font-medium">Payment capture mode:</span> {captureType}
            </>
          ),
        });
      }
      if (postingStatus || journalEntryId) {
        paymentLines.push({
          key: "posting",
          content: (
            <>
              {postingStatus ? (
                <>
                  <span className="font-medium">Accounting entry status:</span> {humanize(postingStatus)}
                </>
              ) : null}
              {journalEntryId ? (
                <>
                  {" "}
                  <span className="font-medium">Journal entry:</span> {formatIdReadable(journalEntryId)}
                </>
              ) : null}
            </>
          ),
        });
      }
      if (allocations.length > 0) {
        paymentLines.push({
          key: "allocations",
          content: (
            <>
              <span className="font-medium">Allocation details:</span>{" "}
              {allocations
                .map((entry) =>
                  `${formatIdReadable(entry.orderId)} (${formatCurrency(entry.applied)}${
                    entry.remainingAfter == null ? "" : `, remaining ${formatCurrency(entry.remainingAfter)}`
                  })`,
                )
                .join(", ")}
            </>
          ),
        });
      }
      if (allocations.length === 0 && ordersAffectedList.length > 0) {
        paymentLines.push({
          key: "ordersAffectedList",
          content: (
            <>
              <span className="font-medium">Orders affected:</span>{" "}
              {ordersAffectedList.map((id) => formatIdReadable(id)).join(", ")}
            </>
          ),
        });
      }
      if (appliedTotal > 0) {
        paymentLines.push({
          key: "appliedTotal",
          content: (
            <>
              <span className="font-medium">Applied total:</span> {formatCurrency(appliedTotal)}
            </>
          ),
        });
      }
      return (
        <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">
          {renderCollapsibleLines(paymentLines)}
        </div>
      );
    }

    if (row.entityType === "PAYMENT" && row.action === "PAYMENT_SUCCESS") {
      const amount = Number(meta.amount || 0);
      const method = String(meta.paymentMethodLabel || meta.method || "-");
      const source = String(meta.source || meta.channel || "-");
      const customer = String(meta.customerName || "").trim() || "Customer";
      const orderId = String(meta.orderId || "").trim();
      const paymentId = String(meta.paymentId || "").trim();
      const resolvedBy = String(meta.resolvedBy || "").trim();
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "customer",
          content: (
            <>
              <span className="font-medium">Customer:</span> {customer}
            </>
          ),
        },
        {
          key: "amount",
          content: (
            <>
              <span className="font-medium">Amount received:</span> {formatCurrency(amount)}{" "}
              <span className="font-medium">Method:</span> {method}
            </>
          ),
        },
        {
          key: "refs",
          content: (
            <>
              <span className="font-medium">Order / Payment:</span>{" "}
              {orderId ? formatIdReadable(orderId) : "-"} /{" "}
              {paymentId ? formatIdReadable(paymentId) : "-"}
            </>
          ),
        },
        {
          key: "source",
          content: (
            <>
              <span className="font-medium">Source:</span> {source}
              {resolvedBy ? ` (${resolvedBy})` : ""}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "ORDER" && (row.action === "ORDER_CREATE" || row.action === "ORDER_CREATE_ADMIN")) {
      const amount = Number(meta.amount || 0);
      const customer = String(meta.customerName || meta.walkInName || "").trim() || "Customer";
      const customerType = String(meta.customerType || meta.actorType || "").trim();
      const source = String(meta.sourceRoute || meta.createdFrom || meta.channel || "-");
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "customer",
          content: (
            <>
              <span className="font-medium">Customer:</span> {customer}
              {customerType ? ` (${customerType})` : ""}
            </>
          ),
        },
        {
          key: "items",
          content: (
            <>
              <span className="font-medium">Items / Quantity:</span>{" "}
              {Number(meta.itemCount || 0)} / {Number(meta.totalQuantity || meta.itemQuantityTotal || 0)}
            </>
          ),
        },
        {
          key: "amount",
          content: (
            <>
              <span className="font-medium">Order amount:</span> {formatCurrency(amount)}
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Status:</span> {String(meta.status || "Not provided")}{" "}
              <span className="font-medium">Delivery:</span>{" "}
              {String(meta.deliveryStatus || "Not provided")}
            </>
          ),
        },
        {
          key: "source",
          content: (
            <>
              <span className="font-medium">Created from:</span> {source}
            </>
          ),
        },
      ];
      if (meta.adminNote) {
        lines.push({
          key: "adminNote",
          content: (
            <>
              <span className="font-medium">Admin note:</span> {String(meta.adminNote)}
            </>
          ),
        });
      }
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "PURCHASE" && (row.action === "PURCHASE_CREATE" || row.action === "PURCHASE_RECEIVE" || row.action === "PURCHASE_APPROVE")) {
      const lines: Array<{ key: string; content: React.ReactNode }> = [];
      lines.push({
        key: "purchaseRef",
        content: (
          <>
            <span className="font-medium">Purchase reference:</span> {formatIdReadable(row.entityId)}
          </>
        ),
      });
      if (meta.productName || meta.name) {
        lines.push({
          key: "product",
          content: (
            <>
              <span className="font-medium">Product:</span> {String(meta.productName || meta.name)}{" "}
              {meta.productId ? `(${formatIdReadable(String(meta.productId))})` : ""}
            </>
          ),
        });
      }
      if (meta.supplier || meta.supplierId) {
        lines.push({
          key: "supplier",
          content: (
            <>
              <span className="font-medium">Supplier:</span> {String(meta.supplier || "-")}{" "}
              {meta.supplierId ? `(${formatIdReadable(String(meta.supplierId))})` : ""}
            </>
          ),
        });
      }
      if (meta.quantity || meta.orderedQuantity || meta.receivedQuantity) {
        const orderedQty = Number(meta.quantity || meta.orderedQuantity || 0);
        const receivedQty = Number(meta.receivedQuantity || 0);
        const remainingQty = Number(
          meta.remainingQuantity ?? Math.max(0, orderedQty - receivedQty),
        );
        lines.push({
          key: "qty",
          content: (
            <>
              <span className="font-medium">Ordered / Received / Remaining:</span>{" "}
              {orderedQty} / {receivedQty} / {remainingQty}
            </>
          ),
        });
      }
      if (row.action === "PURCHASE_RECEIVE" && (meta.delta || meta.from !== undefined || meta.to !== undefined)) {
        lines.push({
          key: "receipt",
          content: (
            <>
              <span className="font-medium">Receipt quantity / Stock change:</span>{" "}
              {Number(meta.delta || 0)} unit(s),{" "}
              {meta.from !== undefined ? Number(meta.from) : "Not provided"} {"->"}{" "}
              {meta.to !== undefined ? Number(meta.to) : "Not provided"}
            </>
          ),
        });
      }
      if (meta.unitCost || meta.amount) {
        lines.push({
          key: "cost",
          content: (
            <>
              <span className="font-medium">Unit cost:</span> {formatCurrency(Number(meta.unitCost || 0))}{" "}
              <span className="font-medium">Total:</span> {formatCurrency(Number(meta.amount || 0))}
            </>
          ),
        });
      }
      const statusFrom =
        meta.previousStatus || meta.statusFrom || meta.fromStatus || meta.statusBefore || null;
      const statusTo = meta.status || meta.nextStatus || meta.statusTo || meta.toStatus || null;
      lines.push({
        key: "status",
        content: (
          <>
            <span className="font-medium">Status:</span>{" "}
            {statusFrom && statusTo
              ? `${String(statusFrom)} -> ${String(statusTo)}`
              : statusTo
              ? String(statusTo)
              : "Not provided"}
          </>
        ),
      });
      if (row.action === "PURCHASE_APPROVE") {
        lines.push({
          key: "approvedContext",
          content: (
            <>
              <span className="font-medium">Approved by:</span>{" "}
              {String(meta.approvedByName || row.actor?.name || row.actor?.email || "Not provided")}{" "}
              <span className="font-medium">at:</span>{" "}
              {meta.approvedAt
                ? new Date(String(meta.approvedAt)).toLocaleString()
                : new Date(row.createdAt).toLocaleString()}
            </>
          ),
        });
      }
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "EXPENSE" && row.action === "EXPENSE_SETTLE") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "amount",
          content: (
            <>
              <span className="font-medium">Settlement amount:</span>{" "}
              {formatCurrency(Number(meta.amount || 0))}
            </>
          ),
        },
        {
          key: "totals",
          content: (
            <>
              <span className="font-medium">Paid so far / Outstanding / Expense total:</span>{" "}
              {formatCurrency(Number(meta.paidSoFar || 0))} / {formatCurrency(Number(meta.outstanding || 0))} /{" "}
              {formatCurrency(Number(meta.totalExpenseAmount || 0))}
            </>
          ),
        },
        {
          key: "mode",
          content: (
            <>
              <span className="font-medium">Payment mode:</span>{" "}
              {String(meta.paymentModeLabel || meta.paymentMode || "Not provided")}
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Settlement status:</span>{" "}
              {String(meta.settlementStatusAfter || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "ORDER" && row.action === "ORDER_ITEM_DELIVERY_UPDATE") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "item",
          content: (
            <>
              <span className="font-medium">Item:</span> {String(meta.productName || "-")}{" "}
              {meta.productSku ? `(SKU ${String(meta.productSku)})` : ""}
            </>
          ),
        },
        {
          key: "qty",
          content: (
            <>
              <span className="font-medium">Delivery change:</span>{" "}
              {Number(meta.deliveredBefore || 0)} {"->"} {Number(meta.deliveredAfter || 0)}{" "}
              (ordered {Number(meta.orderedQty || 0)}, delivered now {Number(meta.quantity || 0)})
            </>
          ),
        },
        {
          key: "remaining",
          content: (
            <>
              <span className="font-medium">Remaining:</span>{" "}
              {Number(meta.remainingBefore || 0)} {"->"} {Number(meta.remainingAfter || 0)}
            </>
          ),
        },
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Order delivery status:</span>{" "}
              {String(meta.orderDeliveryStatusBefore || "Not provided")} {"->"}{" "}
              {String(meta.orderDeliveryStatusAfter || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "PRODUCT_IMAGE" && row.action === "IMAGE_UPLOAD") {
      const size = Number(meta.size || 0);
      const sizeKb = size > 0 ? `${(size / 1024).toFixed(1)} KB` : "Not provided";
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "file",
          content: (
            <>
              <span className="font-medium">File name:</span> {String(meta.filename || "Not provided")}
            </>
          ),
        },
        {
          key: "type",
          content: (
            <>
              <span className="font-medium">File type:</span> {String(meta.mime || meta.ext || "Not provided")}
            </>
          ),
        },
        {
          key: "size",
          content: (
            <>
              <span className="font-medium">File size:</span> {sizeKb}
            </>
          ),
        },
        {
          key: "target",
          content: (
            <>
              <span className="font-medium">Storage / URL:</span>{" "}
              {String(meta.storage || "Not provided")}{" "}
              {meta.url ? `(${String(meta.url)})` : ""}
            </>
          ),
        },
        {
          key: "uploadedAt",
          content: (
            <>
              <span className="font-medium">Uploaded at:</span>{" "}
              {meta.uploadedAt
                ? new Date(String(meta.uploadedAt)).toLocaleString()
                : new Date(row.createdAt).toLocaleString()}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "PRODUCT" && row.action === "PRODUCT_CREATE") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "product",
          content: (
            <>
              <span className="font-medium">Product:</span> {String(meta.name || "-")}{" "}
              {meta.sku ? `(SKU ${String(meta.sku)})` : ""}
            </>
          ),
        },
        {
          key: "category",
          content: (
            <>
              <span className="font-medium">Category / Brand:</span>{" "}
              {String(meta.category || "Not provided")} / {String(meta.brand || "Not provided")}
            </>
          ),
        },
        {
          key: "costPrice",
          content: (
            <>
              <span className="font-medium">Cost / Selling price:</span>{" "}
              {formatCurrency(Number(meta.cost || 0))} / {formatCurrency(Number(meta.price || 0))}
            </>
          ),
        },
        {
          key: "stock",
          content: (
            <>
              <span className="font-medium">Initial stock:</span> {Number(meta.stock || 0)}
            </>
          ),
        },
        {
          key: "supplier",
          content: (
            <>
              <span className="font-medium">Supplier:</span>{" "}
              {String(meta.supplier || "Not provided")}{" "}
              {meta.supplierId ? `(${formatIdReadable(String(meta.supplierId))})` : ""}
            </>
          ),
        },
        {
          key: "flow",
          content: (
            <>
              <span className="font-medium">Initial purchase flow:</span>{" "}
              Receive now {Boolean(meta.effectiveReceiveNow ?? meta.receiveNow) ? "Yes" : "No"},{" "}
              paid on receipt {Boolean(meta.effectivePaidOnReceipt ?? meta.paidOnReceipt) ? "Yes" : "No"},{" "}
              approval required {Boolean(meta.requiresPurchaseApproval) ? "Yes" : "No"}
            </>
          ),
        },
        {
          key: "initialPurchase",
          content: (
            <>
              <span className="font-medium">Initial purchase:</span>{" "}
              {meta.initialPurchase && typeof meta.initialPurchase === "object"
                ? `${String((meta.initialPurchase as Record<string, unknown>).status || "Not provided")} (${Number((meta.initialPurchase as Record<string, unknown>).quantity || 0)} unit(s))`
                : "Not created"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "PRODUCT" && row.action === "PRODUCT_STOCK_UPDATE") {
      const from = Number(meta.from || 0);
      const to = Number(meta.to || 0);
      const delta = Number(meta.delta || to - from);
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "product",
          content: (
            <>
              <span className="font-medium">Product:</span> {String(meta.name || "-")}
            </>
          ),
        },
        {
          key: "stock",
          content: (
            <>
              <span className="font-medium">Stock change:</span> {from} {"->"} {to}{" "}
              ({delta >= 0 ? `+${delta}` : `${delta}`})
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Reason:</span> {String(meta.reason || "Not provided")}
            </>
          ),
        },
        {
          key: "cost",
          content: (
            <>
              <span className="font-medium">Unit cost / New avg cost:</span>{" "}
              {meta.unitCost !== undefined ? formatCurrency(Number(meta.unitCost)) : "Not provided"} /{" "}
              {meta.newCost !== undefined ? formatCurrency(Number(meta.newCost)) : "Not provided"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "PRODUCT" && row.action === "PRODUCT_DELETE") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "product",
          content: (
            <>
              <span className="font-medium">Deleted product:</span> {String(meta.name || "-")}
              {meta.sku ? ` (SKU ${String(meta.sku)})` : ""}
            </>
          ),
        },
        {
          key: "classification",
          content: (
            <>
              <span className="font-medium">Category / Brand:</span>{" "}
              {String(meta.category || "Not provided")} / {String(meta.brand || "Not provided")}
            </>
          ),
        },
        {
          key: "supplier",
          content: (
            <>
              <span className="font-medium">Supplier:</span> {String(meta.supplier || "Not provided")}{" "}
              {meta.supplierId ? `(${formatIdReadable(String(meta.supplierId))})` : ""}
            </>
          ),
        },
        {
          key: "price",
          content: (
            <>
              <span className="font-medium">Last selling / cost:</span>{" "}
              {meta.price !== undefined ? formatCurrency(Number(meta.price)) : "Not provided"}
              {" / "}
              {meta.cost !== undefined ? formatCurrency(Number(meta.cost)) : "Not provided"}
            </>
          ),
        },
        {
          key: "stock",
          content: (
            <>
              <span className="font-medium">Stock at deletion:</span> {Number(meta.stock || 0)}{" "}
              <span className="font-medium">Order history count:</span>{" "}
              {Number(meta.orderHistoryCount || 0)}
            </>
          ),
        },
        {
          key: "cleanup",
          content: (
            <>
              <span className="font-medium">Cleanup:</span>{" "}
              Removed {Number(meta.removedCartItems || 0)} cart item(s), updated{" "}
              {Number(meta.updatedStockAlerts || 0)} stock alert(s), soft-deleted{" "}
              {Number(meta.softDeletedDraftPurchases || 0)} draft purchase(s)
            </>
          ),
        },
        {
          key: "timestamps",
          content: (
            <>
              <span className="font-medium">Deleted at:</span>{" "}
              {meta.deletedAt ? new Date(String(meta.deletedAt)).toLocaleString() : "Not provided"}{" "}
              <span className="font-medium">Last product update:</span>{" "}
              {meta.productUpdatedAt ? new Date(String(meta.productUpdatedAt)).toLocaleString() : "Not provided"}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Delete reason:</span>{" "}
              {String(meta.deleteReason || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "JOURNALENTRY" && (row.action === "journal.archive.run" || row.action === "journal.archive.dry_run" || row.action === "journal.archive.cron.run" || row.action === "journal.archive.cron.dry_run")) {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "mode",
          content: (
            <>
              <span className="font-medium">Archive mode:</span>{" "}
              {Boolean(meta.dryRun) ? "Dry run" : "Run"}
            </>
          ),
        },
        {
          key: "window",
          content: (
            <>
              <span className="font-medium">Policy window:</span>{" "}
              {Number(meta.months || 0)} month(s), cutoff{" "}
              {meta.cutoffDate ? new Date(String(meta.cutoffDate)).toLocaleString() : "Not provided"}
            </>
          ),
        },
        {
          key: "counts",
          content: (
            <>
              <span className="font-medium">Candidates / Archived:</span>{" "}
              {Number(meta.candidateCount || 0)} / {Number(meta.archivedCount || 0)}
            </>
          ),
        },
        {
          key: "trigger",
          content: (
            <>
              <span className="font-medium">Triggered by:</span>{" "}
              {String(meta.trigger || "Not provided")}{" "}
              {meta.actorName ? `(${String(meta.actorName)})` : ""}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "SUPPLIER_PAYMENT" && row.action === "SUPPLIER_PAYABLES_EXPORT_BUNDLE") {
      const manifest = Array.isArray(meta.fileManifest)
        ? (meta.fileManifest as Array<{ name?: unknown; bytes?: unknown }>)
            .map((entry) => {
              const name = String(entry?.name || "").trim();
              const bytes = Number(entry?.bytes);
              if (!name) return null;
              return {
                name,
                size: Number.isFinite(bytes) && bytes >= 0 ? formatByteSize(bytes) : "Not provided",
              };
            })
            .filter((entry): entry is { name: string; size: string } => Boolean(entry))
        : [];
      const manifestSummary =
        manifest.length > 0
          ? manifest.map((entry) => `${entry.name} (${entry.size})`).join(", ")
          : "Not provided";
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Export result:</span>{" "}
              {String(meta.resultSummary || "Not provided")}
            </>
          ),
        },
        {
          key: "bundle",
          content: (
            <>
              <span className="font-medium">Bundle name / Generated at:</span>{" "}
              {String(meta.baseName || "Not provided")} /{" "}
              {meta.generatedAt ? new Date(String(meta.generatedAt)).toLocaleString() : "Not provided"}
            </>
          ),
        },
        {
          key: "size",
          content: (
            <>
              <span className="font-medium">Files / Total size:</span>{" "}
              {Number(meta.fileCount || manifest.length || 0)} / {formatByteSize(meta.byteSize)}
            </>
          ),
        },
        {
          key: "scope",
          content: (
            <>
              <span className="font-medium">Scope snapshot:</span>{" "}
              {String(meta.scopeSnapshot || "Not provided")}
            </>
          ),
        },
        {
          key: "rows",
          content: (
            <>
              <span className="font-medium">Current view rows/columns:</span>{" "}
              {Number(meta.currentViewRows || 0)} / {Number(meta.currentViewColumns || 0)}{" "}
              <span className="font-medium">Summary rows/columns:</span>{" "}
              {Number(meta.summaryRows || 0)} / {Number(meta.summaryColumns || 0)}
            </>
          ),
        },
        {
          key: "text",
          content: (
            <>
              <span className="font-medium">Email summary chars:</span>{" "}
              {Number(meta.emailSummaryChars || 0)}{" "}
              <span className="font-medium">Notes included:</span>{" "}
              {Boolean(meta.notesIncluded) ? "Yes" : "No"}
            </>
          ),
        },
        {
          key: "manifest",
          content: (
            <>
              <span className="font-medium">File manifest:</span>{" "}
              {manifestSummary}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.action === "ACCOUNTING_POST_BACKFILL") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Backfill result:</span>{" "}
              {meta.journalEntryId
                ? `Posted journal ${formatIdReadable(String(meta.journalEntryId))}`
                : "No journal entry linked"}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Reason:</span>{" "}
              {String(meta.reason || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (String(row.entityType || "").toUpperCase() === "APPSETTING" && row.action === "app-setting.update") {
      const hasMeta = Object.keys(meta).length > 0;
      const changes = Array.isArray(meta.changes)
        ? (meta.changes as Array<Record<string, unknown>>)
        : [];
      const primaryChange =
        changes.find((change) => String(change.key || "") === row.entityId) || changes[0] || null;
      const settingKey = String((primaryChange?.key as string | undefined) || row.entityId || "");
      const formatVarianceNotesPreview = (raw: string) => {
        if (!raw || raw === "Not provided" || raw === "[hidden]") return raw || "Not provided";
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
          const entries = Object.entries(parsed as Record<string, unknown>)
            .map(([periodKey, note]) => {
              const [start, end] = String(periodKey || "").split("|");
              const startLabel = start ? new Date(`${start}T00:00:00`).toLocaleDateString() : "Unknown start";
              const endLabel = end ? new Date(`${end}T00:00:00`).toLocaleDateString() : "Unknown end";
              const noteText = String(note ?? "").trim() || "No note";
              return `${startLabel} to ${endLabel}: ${noteText}`;
            })
            .filter(Boolean);
          if (entries.length === 0) return "No variance notes saved.";
          return entries.join(" | ");
        } catch {
          return raw;
        }
      };
      const parsePreview = (value: unknown) => {
        const text = String(value ?? "").trim();
        if (!text) return "Not provided";
        if (text === "[hidden]") return text;
        if (settingKey === "accounting.reports.pl.varianceNotes") {
          return formatVarianceNotesPreview(text);
        }
        try {
          return JSON.stringify(JSON.parse(text));
        } catch {
          return text;
        }
      };
      const beforeType = String(
        (primaryChange?.effectivePreviousType as string | undefined) ||
          (primaryChange?.previousType as string | undefined) ||
          meta.previousType ||
          "Not provided",
      );
      const afterType = String(
        (primaryChange?.newType as string | undefined) || meta.newType || "Not provided",
      );
      const beforePreview = parsePreview(
        primaryChange?.effectivePreviousValuePreview ??
          primaryChange?.previousValuePreview ??
          meta.previousValuePreview,
      );
      const afterPreview = parsePreview(
        primaryChange?.newValuePreview ?? meta.newValuePreview,
      );
      const changedFieldNames = Array.isArray(primaryChange?.changedFields)
        ? (primaryChange?.changedFields as unknown[])
            .map((name) => String(name || "").trim())
            .filter(Boolean)
        : Array.isArray(meta.changedFields)
          ? (meta.changedFields as unknown[])
              .map((name) => String(name || "").trim())
              .filter(Boolean)
          : [];
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "key",
          content: (
            <>
              <span className="font-medium">Setting key:</span>{" "}
              {String((primaryChange?.key as string | undefined) || row.entityId || "Not provided")}
            </>
          ),
        },
        {
          key: "source",
          content: (
            <>
              <span className="font-medium">Source page / section / operation:</span>{" "}
              {String(meta.sourcePage || "Not provided")} / {humanizeAuditLabel(meta.section)} /{" "}
              {humanizeAuditLabel(meta.operation)}
            </>
          ),
        },
        {
          key: "changed",
          content: (
            <>
              <span className="font-medium">Changed:</span>{" "}
              {hasMeta ? (Boolean(meta.changed) ? "Yes" : "No") : "Unknown (legacy entry)"}
            </>
          ),
        },
        {
          key: "types",
          content: (
            <>
              <span className="font-medium">Value type (before to after):</span>{" "}
              {hasMeta ? `${beforeType} -> ${afterType}` : "Unknown (legacy entry)"}
            </>
          ),
        },
        {
          key: "value",
          content: (
            <>
              <span className="font-medium">Value (before to after):</span>{" "}
              {hasMeta ? `${beforePreview} -> ${afterPreview}` : "Unknown (legacy entry)"}
            </>
          ),
        },
        ...(Boolean(primaryChange?.baselineDerivedFromDefault)
          ? [
              {
                key: "baseline",
                content: (
                  <>
                    <span className="font-medium">Baseline source:</span> Default value (no prior saved setting row)
                  </>
                ),
              },
            ]
          : []),
        {
          key: "fields",
          content: (
            <>
              <span className="font-medium">Changed fields:</span>{" "}
              {changedFieldNames.length > 0 ? changedFieldNames.join(", ") : "None listed"}
            </>
          ),
        },
        {
          key: "sensitive",
          content: (
            <>
              <span className="font-medium">Sensitive value:</span>{" "}
              {Boolean(meta.isSensitive) ? "Yes (value masked)" : "No"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_ACKNOWLEDGED") {
      const issueCount = Number(meta.issueCount || 0);
      const workflowBefore =
        meta.workflowBefore && typeof meta.workflowBefore === "object"
          ? (meta.workflowBefore as Record<string, unknown>)
          : {};
      const workflowAfter =
        meta.workflowAfter && typeof meta.workflowAfter === "object"
          ? (meta.workflowAfter as Record<string, unknown>)
          : {};
      const issueBreakdown =
        meta.issueBreakdown && typeof meta.issueBreakdown === "object"
          ? (meta.issueBreakdown as Record<string, unknown>)
          : {};
      const postingBreakdown =
        issueBreakdown.missingPostings && typeof issueBreakdown.missingPostings === "object"
          ? (issueBreakdown.missingPostings as Record<string, unknown>)
          : {};
      const issueBreakdownHasSignal =
        Object.entries(issueBreakdown).some(([k, v]) => {
          if (k === "missingPostings") return false;
          if (typeof v === "boolean") return v;
          return Number(v || 0) > 0;
        }) || Object.values(postingBreakdown).some((v) => Number(v || 0) > 0);

      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "summary",
          content: (
            <>
              <span className="font-medium">Acknowledgement result:</span>{" "}
              {String(meta.changeSummary || "Workflow updated")}
            </>
          ),
        },
        {
          key: "issues",
          content: (
            <>
              <span className="font-medium">Issue count / summary:</span>{" "}
              {issueCount} / {String(meta.issueSummary || "Not provided")}
            </>
          ),
        },
        {
          key: "beforeAfter",
          content: (
            <>
              <span className="font-medium">Workflow before {"->"} after:</span>{" "}
              {`${String(workflowBefore.status || "Open")} (${String(workflowBefore.owner || "Unassigned")}, due ${
                workflowBefore.dueAt ? new Date(String(workflowBefore.dueAt)).toLocaleString() : "Not set"
              }) -> ${String(workflowAfter.status || "Open")} (${String(workflowAfter.owner || "Unassigned")}, due ${
                workflowAfter.dueAt ? new Date(String(workflowAfter.dueAt)).toLocaleString() : "Not set"
              })`}
            </>
          ),
        },
      ];
      if (issueBreakdownHasSignal) {
        lines.push({
          key: "breakdown",
          content: (
            <>
              <span className="font-medium">Issue breakdown:</span>{" "}
              {String(meta.issueSummary || "Issues detected")}
            </>
          ),
        });
      }
      if (meta.followUpGuidance && Boolean(meta.requiresFollowUp)) {
        lines.push({
          key: "followUp",
          content: (
            <>
              <span className="font-medium">Follow-up:</span>{" "}
              {String(meta.followUpGuidance)}
            </>
          ),
        });
      }
      if (meta.acknowledgementAt) {
        lines.push({
          key: "at",
          content: (
            <>
              <span className="font-medium">Acknowledged at:</span>{" "}
              {new Date(String(meta.acknowledgementAt)).toLocaleString()}
            </>
          ),
        });
      }
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_DIAGNOSTICS_RUN") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Diagnostics result:</span>{" "}
              {String(meta.result || "Not provided")}
            </>
          ),
        },
        {
          key: "issueSummary",
          content: (
            <>
              <span className="font-medium">Issue count / summary:</span>{" "}
              {Number(meta.issueCount || 0)} / {String(meta.issueSummary || "Not provided")}
            </>
          ),
        },
      ];
      if (meta.diagnosticsRunAt) {
        lines.push({
          key: "runAt",
          content: (
            <>
              <span className="font-medium">Run at:</span>{" "}
              {new Date(String(meta.diagnosticsRunAt)).toLocaleString()}
            </>
          ),
        });
      }
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_AUTO_HEAL_RUN") {
      const beforeCount = Number(meta.beforeIssueCount || 0);
      const afterCount = Number(meta.afterIssueCount || 0);
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Auto-heal result:</span>{" "}
              {String(meta.result || "Not provided")}
            </>
          ),
        },
        {
          key: "delta",
          content: (
            <>
              <span className="font-medium">Issue count before {"->"} after:</span>{" "}
              {beforeCount} {"->"} {afterCount}
            </>
          ),
        },
      ];
      if (meta.autoHealRunAt) {
        lines.push({
          key: "runAt",
          content: (
            <>
              <span className="font-medium">Run at:</span>{" "}
              {new Date(String(meta.autoHealRunAt)).toLocaleString()}
            </>
          ),
        });
      }
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_INCIDENT_NOTE_ADDED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "note",
          content: (
            <>
              <span className="font-medium">Incident note:</span>{" "}
              {String(meta.note || "Not provided")}
            </>
          ),
        },
        {
          key: "at",
          content: (
            <>
              <span className="font-medium">Added at:</span>{" "}
              {meta.addedAt ? new Date(String(meta.addedAt)).toLocaleString() : "-"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_ALERT_FORCE_SEND_SKIPPED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Force-send result:</span>{" "}
              {String(meta.result || "Not provided")}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Force reason:</span>{" "}
              {String(meta.forceReason || "Not provided")}
            </>
          ),
        },
        {
          key: "hasIssues",
          content: (
            <>
              <span className="font-medium">Had active issues:</span>{" "}
              {Boolean(meta.hasIssues) ? "Yes" : "No"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.entityType === "HEALTH_ALERT" && row.action === "HEALTH_ALERT_SEND_SKIPPED") {
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Send result:</span>{" "}
              {String(meta.result || "Not provided")}
            </>
          ),
        },
        {
          key: "reason",
          content: (
            <>
              <span className="font-medium">Reason:</span>{" "}
              {String(meta.reason || "Not provided")}
            </>
          ),
        },
        {
          key: "hasIssues",
          content: (
            <>
              <span className="font-medium">Had active issues:</span>{" "}
              {Boolean(meta.hasIssues) ? "Yes" : "No"}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (row.action.toUpperCase().includes("EXPORT")) {
      const afterMeta =
        meta.after && typeof meta.after === "object" && !Array.isArray(meta.after)
          ? (meta.after as Record<string, unknown>)
          : null;
      const integrity = (meta.integrity && typeof meta.integrity === "object")
        ? (meta.integrity as Record<string, unknown>)
        : null;
      const normalizedRowCount =
        Number(meta.rowCount || meta.totalRowCount || afterMeta?.rowCount || integrity?.rowCount || 0) || 0;
      const normalizedColumnCount = Number(meta.columnCount || afterMeta?.columnCount || 0) || 0;
      const normalizedByteSize = Number(meta.byteSize || afterMeta?.byteSize || 0) || 0;
      const derivedFileName =
        String(meta.displayFileName || "").trim() ||
        String(meta.fileName || "").trim() ||
        String(afterMeta?.fileName || "").trim() ||
        (() => {
          const url = String(meta.downloadUrl || "").trim();
          const match = /filename="?([^"&]+)"?/i.exec(url);
          return match?.[1] ? decodeURIComponent(match[1]) : "";
        })();
      const inferredFormat =
        String(meta.format || "").trim() ||
        (() => {
          const name = derivedFileName.toLowerCase();
          const contentType = String(meta.contentType || "").toLowerCase();
          if (name.endsWith(".pdf") || contentType.includes("application/pdf")) return "pdf";
          if (name.endsWith(".csv") || contentType.includes("text/csv")) return "csv";
          return "";
        })();
      const normalizedScope =
        humanizeScopeSnapshot(String(meta.scopeSnapshot || "").trim()) ||
        (() => {
          const before = (meta.before && typeof meta.before === "object") ? (meta.before as Record<string, unknown>) : null;
          const after = (meta.after && typeof meta.after === "object") ? (meta.after as Record<string, unknown>) : null;
          const asOf = String(after?.asOf || before?.asOf || meta.asOf || "").trim();
          const start = String(after?.start || before?.start || meta.start || "").trim();
          const end = String(after?.end || before?.end || meta.end || "").trim();
          if (start || end) {
            const startLabel = start ? formatPlainEnglishDate(start) : "the beginning";
            const endLabel = end ? formatPlainEnglishDate(end) : "the selected end date";
            return `${startLabel} to ${endLabel}`;
          }
          if (asOf) return `As of ${formatPlainEnglishDate(asOf)}`;
          return "";
        })();
      const normalizedResult =
        String(meta.resultSummary || meta.failReason || "").trim() ||
        (String(meta.status || "").trim() ? `Status: ${String(meta.status)}` : "");
      if (!(derivedFileName || inferredFormat || normalizedByteSize || normalizedRowCount || normalizedColumnCount || normalizedScope || normalizedResult)) {
        return null;
      }
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        {
          key: "export",
          content: (
            <>
              <span className="font-medium">Export action:</span> {resolveAuditActionLabel(row)}
            </>
          ),
        },
        {
          key: "file",
          content: (
            <>
              <span className="font-medium">File / Format:</span>{" "}
              {String(humanizeExportFileName(derivedFileName) || "Not provided")} / {String(inferredFormat || "Not provided")}
            </>
          ),
        },
        {
          key: "shape",
          content: (
            <>
              <span className="font-medium">Rows / Columns / Size:</span>{" "}
              {normalizedRowCount} / {normalizedColumnCount} / {formatByteSize(normalizedByteSize)}
            </>
          ),
        },
        {
          key: "scope",
          content: (
            <>
              <span className="font-medium">Scope snapshot:</span> {String(normalizedScope || "Not provided")}
            </>
          ),
        },
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Result:</span> {String(normalizedResult || "Not provided")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    const entries = Object.entries(meta);
    const isExpanded = expandedMetaRows.has(row.id);

    const keyLabels: Record<string, string> = {
      supplierId: "Supplier ID",
      supplierName: "Supplier",
      supplier: "Supplier",
      productId: "Product ID",
      productName: "Product",
      product: "Product",
      productSku: "SKU",
      purchaseId: "Purchase ID",
      oldUnitCost: "Old unit cost",
      newUnitCost: "New unit cost",
      unitCost: "Unit cost",
      newCost: "New avg cost",
      deltaPct: "Change %",
      delta: "Change amount",
      deltaAmount: "Change amount",
      changeAmount: "Change amount",
      changePct: "Change %",
      changePercent: "Change %",
      changeReason: "Change reason",
      effectiveAt: "Effective at",
      source: "Source",
      currency: "Currency",
      purchaseReason: "Purchase reason",
      reason: "Reason",
      note: "Note",
      isReversal: "Is reversal",
      reversalOfId: "Reversal of",
      status: "Status",
      previousStatus: "Previous status",
      nextStatus: "After status",
      targetEmployeeIds: "Target employees",
      paymentMethod: "Payment method",
      paymentMethodLabel: "Payment method",
      invoiceNumber: "Invoice number",
      orderId: "Order ID",
      actorType: "Actor type",
      actorName: "Actor",
      actorEmail: "Actor email",
      reviewedAt: "Reviewed at",
      reviewedByName: "Reviewed by",
      reviewNote: "Review note",
      correlationId: "Correlation ID",
      due7Count: "Due In 7 Days Count",
      "0_30": "0-30",
      "31_60": "31-60",
      "61_90": "61-90",
      "90_plus": "90+",
    };
    const toFriendlyLabel = (key: string) =>
      keyLabels[key] ||
      key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
    const formatAuditReasonText = (value: string) => {
      const normalized = value.trim().toLowerCase();
      if (!normalized) return "Not provided";
      if (normalized === "user_not_found") {
        return "No account matched the supplied email address or username.";
      }
      if (normalized === "bad_password") {
        return "The password did not match the account.";
      }
      if (normalized === "user_archived") {
        return "Login was blocked because the user account is archived.";
      }
      if (normalized === "locked_out") {
        return "Login was blocked because too many failed attempts triggered a temporary lockout.";
      }
      if (normalized === "rate_limited") {
        return "Login was blocked by rate limiting because there were too many attempts.";
      }
      if (normalized === "invalid_payload") {
        return "Login request failed validation.";
      }
      return humanizeAuditLabel(value);
    };
    const formatUnknownMetaValue = (value: unknown, depth = 0): string => {
      if (value === null || value === undefined) return "Not provided";
      if (typeof value === "boolean") return value ? "Yes" : "No";
      if (typeof value === "number") return Number.isFinite(value) ? String(value) : "-";
      if (typeof value === "string") {
        const text = value.trim();
        if (!text) return "Not provided";
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
          return text;
        }
        if (!Number.isNaN(new Date(text).getTime()) && /(T|\d{4}-\d{2}-\d{2})/.test(text)) {
          return new Date(text).toLocaleString();
        }
        if (/^[A-Z0-9_]{3,}$/.test(text) && text.includes("_")) {
          return text
            .toLowerCase()
            .replace(/_/g, " ")
            .replace(/\b\w/g, (ch) => ch.toUpperCase());
        }
        return text;
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return "Not provided";
        const rendered = value
          .slice(0, 6)
          .map((item) => formatUnknownMetaValue(item, depth + 1))
          .filter(Boolean);
        const suffix = value.length > 6 ? ` (+${value.length - 6} more)` : "";
        return `${rendered.join(", ")}${suffix}`;
      }
      if (typeof value === "object") {
        const row = value as Record<string, unknown>;
        const from = row.from;
        const to = row.to;
        if ((from !== undefined || to !== undefined) && Object.keys(row).length <= 3) {
          return `from ${formatUnknownMetaValue(from, depth + 1)} to ${formatUnknownMetaValue(to, depth + 1)}`;
        }
        const pairs = Object.entries(row)
          .slice(0, depth > 0 ? 4 : 6)
          .map(([k, v]) => `${toFriendlyLabel(k)}: ${formatUnknownMetaValue(v, depth + 1)}`);
        const suffix = Object.keys(row).length > pairs.length ? " (+more)" : "";
        return `${pairs.join("; ")}${suffix}` || "-";
      }
      return String(value);
    };
    const formatPrimitiveMetaValue = (key: string, value: unknown) => {
      let display = formatUnknownMetaValue(value);
      if (Array.isArray(value)) {
        const values = value
          .map((item) => formatUnknownMetaValue(item))
          .filter(Boolean);
        if (values.length === 0) {
          display = "-";
        } else if (/ids$/i.test(key)) {
          display = values.map((item) => formatIdReadable(item)).join(", ");
        } else {
          display = values.join(", ");
        }
      }
      if (typeof value === "string" && /id$/i.test(key)) {
        display = formatIdReadable(value);
      } else if (key === "reason" && typeof value === "string") {
        display = formatAuditReasonText(value);
      } else if (
        typeof value === "string" &&
        /status$/i.test(key)
      ) {
        display = value
          .trim()
          .replace(/_/g, " ")
          .toLowerCase()
          .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Not provided";
      } else if (
        /(At|Date)$/i.test(key) &&
        typeof value === "string" &&
        !Number.isNaN(new Date(value).getTime())
      ) {
        display = new Date(value).toLocaleString();
      } else if (
        /(pct|percent)$/i.test(key) &&
        (typeof value === "number" ||
          (typeof value === "string" && !Number.isNaN(Number(value))))
      ) {
        display = `${Number(value).toFixed(2)}%`;
      } else if (
        (key === "refundAmount" ||
          key === "0_30" ||
          key === "31_60" ||
          key === "61_90" ||
          key === "90_plus" ||
          /price$/i.test(key) ||
          /total$/i.test(key) ||
          /subtotal$/i.test(key) ||
          /tax$/i.test(key) ||
          /fee$/i.test(key) ||
          /discount$/i.test(key) ||
          /amount$/i.test(key) ||
          /cost$/i.test(key) ||
          /balance$/i.test(key)) &&
        (typeof value === "number" ||
          (typeof value === "string" && !Number.isNaN(Number(value))))
      ) {
        display = formatCurrency(Number(value));
      }
      return display;
    };
    const renderMetaObject = (key: string, value: Record<string, unknown>, path: string, depth: number) => {
      const nested = Object.entries(value);
      if (!nested.length) {
        return (
          <div key={path}>
            <span className="font-medium">{toFriendlyLabel(key)}:</span> <span>-</span>
          </div>
        );
      }
      return (
        <div key={path} className="space-y-0.5">
          <div>
            <span className="font-medium">{toFriendlyLabel(key)}:</span>
          </div>
          <div className={`${depth <= 0 ? "pl-3" : "pl-4"} space-y-0.5`}>
            {nested.map(([nestedKey, nestedValue]) => {
              const nestedPath = `${path}.${nestedKey}`;
              if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
                return renderMetaObject(
                  nestedKey,
                  nestedValue as Record<string, unknown>,
                  nestedPath,
                  depth + 1,
                );
              }
              return (
                <div key={nestedPath}>
                  <span className="font-medium">{toFriendlyLabel(nestedKey)}:</span>{" "}
                  <span>{formatPrimitiveMetaValue(nestedKey, nestedValue)}</span>
                </div>
              );
            })}
          </div>
        </div>
      );
    };

    const countMetaLines = (value: unknown, depth = 0): number => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = Object.entries(value as Record<string, unknown>);
        if (nested.length === 0) return 1;
        return 1 + nested.reduce((sum, [, child]) => sum + countMetaLines(child, depth + 1), 0);
      }
      if (Array.isArray(value)) {
        if (value.length === 0) return 1;
        const visibleCount = Math.min(value.length, 6);
        const nestedLines = value.slice(0, visibleCount).reduce((sum, child) => sum + countMetaLines(child, depth + 1), 0);
        return Math.max(1, nestedLines);
      }
      return 1;
    };

    if (String(row.action || "").toUpperCase() === "HR_SETTING_UPDATE" && String(row.entityType || "").toUpperCase() === "APPSETTING") {
      const beforeObj =
        meta.before && typeof meta.before === "object" ? (meta.before as Record<string, unknown>) : null;
      const afterObj =
        meta.after && typeof meta.after === "object" ? (meta.after as Record<string, unknown>) : null;
      const settingKey = String(row.entityId || afterObj?.key || beforeObj?.key || "").trim();
      const settingLabel =
        settingKey === "hr.reviewCadence"
          ? "Review cadence"
          : settingKey === "hr.workweekDays"
            ? "Workweek days"
            : settingKey === "hr.payroll.ghana.autoStatutoryCalc"
              ? "Automatic Ghana statutory calculation"
              : settingKey === "hr.payroll.ghana.enablePaye"
                ? "Collect PAYE"
                : settingKey === "hr.payroll.ghana.enableSsnitEmployee"
                  ? "Collect SSNIT (employee)"
                  : settingKey === "hr.payroll.ghana.enableSsnitEmployer"
                    ? "Track SSNIT (employer)"
                    : settingKey === "hr.payroll.ghana.ssnitEmployeeRate"
                      ? "SSNIT employee rate (%)"
                      : settingKey === "hr.payroll.ghana.ssnitEmployerRate"
                        ? "SSNIT employer rate (%)"
                        : settingKey === "hr.payroll.ghana.taxableAllowancePercent"
                          ? "Taxable allowance percent (%)"
                          : settingKey === "hr.payroll.ghana.payeBands"
                            ? "PAYE monthly bands"
            : settingKey || "HR setting";
      const operationRaw = String(meta.operation || "").trim().toLowerCase();
      const operationLabel =
        operationRaw === "update_review_cadence"
          ? "Updated review cadence"
          : operationRaw === "update_workweek_days"
            ? "Updated workweek days"
            : operationRaw === "update_ghana_auto_calculation_toggle"
              ? "Updated automatic Ghana statutory calculation"
              : operationRaw === "update_ghana_enable_paye"
                ? "Updated PAYE collection policy"
                : operationRaw === "update_ghana_enable_ssnit_employee"
                  ? "Updated SSNIT employee collection policy"
                  : operationRaw === "update_ghana_enable_ssnit_employer"
                    ? "Updated SSNIT employer tracking policy"
                    : operationRaw === "update_ghana_ssnit_rate"
                      ? "Updated SSNIT employee rate"
                      : operationRaw === "update_ghana_employer_ssnit_rate"
                        ? "Updated SSNIT employer rate"
                        : operationRaw === "update_ghana_taxable_allowance_percent"
                          ? "Updated taxable allowance percent"
                          : operationRaw === "update_ghana_paye_bands"
                            ? "Updated PAYE monthly bands"
            : operationRaw === "reset_review_cadence_default"
              ? "Reset review cadence to default"
              : operationRaw === "reset_workweek_days_default"
                ? "Reset workweek days to default"
                : "Updated HR setting";
      const beforeValue = beforeObj?.value;
      const afterValue = afterObj?.value;
      const hasValueSnapshot = beforeValue !== undefined || afterValue !== undefined;
      const hasValueChange = JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        { key: "initiator", content: initiatorLine.content },
        {
          key: "setting",
          content: (
            <>
              <span className="font-medium">Setting:</span> {settingLabel}
            </>
          ),
        },
        {
          key: "operation",
          content: (
            <>
              <span className="font-medium">Operation:</span> {operationLabel}
            </>
          ),
        },
        ...(hasValueSnapshot
          ? [
              {
                key: "change",
                content: (
                  <>
                    <span className="font-medium">{hasValueChange ? "Changed value:" : "Value:"}</span>{" "}
                    {formatUnknownMetaValue(beforeValue)} {"->"} {formatUnknownMetaValue(afterValue)}
                  </>
                ),
              },
              ...(hasValueChange
                ? [
                    {
                      key: "change-before",
                      content: (
                        <>
                          <span className="font-medium">Before:</span> {formatUnknownMetaValue(beforeValue)}
                        </>
                      ),
                    },
                    {
                      key: "change-after",
                      content: (
                        <>
                          <span className="font-medium">After:</span> {formatUnknownMetaValue(afterValue)}
                        </>
                      ),
                    },
                  ]
                : []),
            ]
          : []),
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Result:</span>{" "}
              {String(meta.resultSummary || "HR setting updated successfully.")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    const actionUpper = String(row.action || "").toUpperCase();
    if (
      (actionUpper === "PAYROLL_GENERATE_MONTHLY" || actionUpper === "PAYROLL_GENERATE") &&
      String(row.entityType || "").toUpperCase() === "PAYROLL_RUN"
    ) {
      const statutory = meta.statutory && typeof meta.statutory === "object"
        ? (meta.statutory as Record<string, unknown>)
        : null;
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        { key: "initiator", content: initiatorLine.content },
        {
          key: "run",
          content: (
            <>
              <span className="font-medium">Payroll run:</span>{" "}
              {String(meta.payrollRunId || row.entityId || "Not provided")}
            </>
          ),
        },
        ...(meta.year !== undefined || meta.month !== undefined
          ? [
              {
                key: "period",
                content: (
                  <>
                    <span className="font-medium">Period:</span>{" "}
                    {meta.year !== undefined && meta.month !== undefined
                      ? `${meta.year}-${String(meta.month).padStart(2, "0")}`
                      : "Not provided"}
                  </>
                ),
              },
            ]
          : []),
        {
          key: "counts",
          content: (
            <>
              <span className="font-medium">Generated / Updated / Skipped:</span>{" "}
              {Number(meta.created || 0)} / {Number(meta.updated || 0)} / {Number(meta.skipped || 0)}
            </>
          ),
        },
        {
          key: "policy",
          content: (
            <>
              <span className="font-medium">Policy:</span>{" "}
              Auto {statutory?.autoCalculation === false ? "Off" : "On"} | PAYE{" "}
              {statutory?.collectPaye === false ? "Off" : "On"} | SSNIT (employee){" "}
              {statutory?.collectSsnitEmployee === false ? "Off" : "On"} | SSNIT (employer){" "}
              {statutory?.trackSsnitEmployer === false ? "Off" : "On"}
            </>
          ),
        },
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Result:</span>{" "}
              {String(meta.resultSummary || "Payroll payslips generated.")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    if (actionUpper === "PAYROLL_STATUS_UPDATE" && String(row.entityType || "").toUpperCase() === "PAYROLL_RUN") {
      const beforeObj =
        meta.before && typeof meta.before === "object" ? (meta.before as Record<string, unknown>) : null;
      const afterObj =
        meta.after && typeof meta.after === "object" ? (meta.after as Record<string, unknown>) : null;
      const periodObj =
        meta.period && typeof meta.period === "object" ? (meta.period as Record<string, unknown>) : null;
      const operationRaw = String(meta.operation || "").trim().toLowerCase();
      const operationLabel =
        operationRaw === "finalize_run"
          ? "Finalized payroll run"
          : operationRaw === "mark_paid"
            ? "Marked payroll run as paid"
            : operationRaw === "cancel_run"
              ? "Cancelled payroll run"
              : "Updated payroll run status";
      const lines: Array<{ key: string; content: React.ReactNode }> = [
        { key: "initiator", content: initiatorLine.content },
        {
          key: "operation",
          content: (
            <>
              <span className="font-medium">Operation:</span> {operationLabel}
            </>
          ),
        },
        {
          key: "run",
          content: (
            <>
              <span className="font-medium">Payroll run:</span> {String(row.entityId || "Not provided")}
            </>
          ),
        },
        ...(periodObj
          ? [
              {
                key: "period",
                content: (
                  <>
                    <span className="font-medium">Period:</span>{" "}
                    {periodObj.periodStart
                      ? `${new Date(String(periodObj.periodStart)).toLocaleDateString()} - ${new Date(String(periodObj.periodEnd || periodObj.periodStart)).toLocaleDateString()}`
                      : "Not provided"}
                  </>
                ),
              },
            ]
          : []),
        {
          key: "status",
          content: (
            <>
              <span className="font-medium">Status:</span>{" "}
              {String(beforeObj?.status || "Not provided")} {"->"} {String(afterObj?.status || "Not provided")}
            </>
          ),
        },
        ...(afterObj?.totalGross !== undefined || afterObj?.totalNet !== undefined
          ? [
              {
                key: "totals",
                content: (
                  <>
                    <span className="font-medium">Totals:</span>{" "}
                    Gross {formatCurrency(Number(afterObj?.totalGross || 0))} | Net{" "}
                    {formatCurrency(Number(afterObj?.totalNet || 0))}
                  </>
                ),
              },
            ]
          : []),
        ...(meta.expenseId
          ? [
              {
                key: "expense",
                content: (
                  <>
                    <span className="font-medium">Expense link:</span> {String(meta.expenseId)}
                  </>
                ),
              },
            ]
          : []),
        {
          key: "result",
          content: (
            <>
              <span className="font-medium">Result:</span>{" "}
              {String(meta.resultSummary || "Payroll run status updated successfully.")}
            </>
          ),
        },
      ];
      return <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground space-y-1">{renderCollapsibleLines(lines)}</div>;
    }

    const diffRows: Array<{ label: string; from: unknown; to: unknown }> = [];
    const isAuditOutcomeStatus = (value: unknown) => {
      const normalized = String(value ?? "")
        .trim()
        .toUpperCase();
      return (
        normalized === "SUCCESS" ||
        normalized === "FAILED" ||
        normalized === "ERROR" ||
        normalized === "PARTIAL" ||
        normalized === "SKIPPED"
      );
    };
    if (meta.from !== undefined || meta.to !== undefined) {
      diffRows.push({ label: "Value", from: meta.from, to: meta.to });
    }
    if (
      meta.previousStatus !== undefined ||
      (meta.status !== undefined && !isAuditOutcomeStatus(meta.status))
    ) {
      diffRows.push({ label: "Status", from: meta.previousStatus, to: meta.status });
    }
    Object.keys(meta).forEach((key) => {
      if (!/^old[A-Z]/.test(key) && !/^previous[A-Z]/.test(key)) return;
      const suffix = key.replace(/^(old|previous)/, "");
      const newKey = `new${suffix}`;
      const nextKey = `next${suffix}`;
      const toVal = meta[newKey] ?? meta[nextKey];
      if (toVal === undefined) return;
      const label = toFriendlyLabel(suffix || key);
      diffRows.push({ label, from: meta[key], to: toVal });
    });
    const estimatedLineCount =
      1 +
      Math.min(diffRows.length + (diffRows.length > 0 ? 1 : 0), 6) +
      entries.reduce((sum, [, value]) => sum + countMetaLines(value), 0);
    const hasMore = estimatedLineCount > 6;

    return (
      <div
        className={`min-w-0 max-w-full break-words text-[11px] text-muted-foreground ${hasMore ? "cursor-pointer" : ""}`}
        onClick={() => {
          if (!hasMore) return;
          setExpandedMetaRows((prev) => {
            const next = new Set(prev);
            if (next.has(row.id)) next.delete(row.id);
            else next.add(row.id);
            return next;
          });
        }}
      >
        <div
          className="space-y-0.5"
          style={
            !isExpanded && hasMore
              ? {
                  display: "-webkit-box",
                  WebkitLineClamp: 6,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }
              : undefined
          }
        >
          <div>{initiatorLine.content}</div>
          {diffRows.length > 0 ? (
            <div className="space-y-0.5">
              <div className="font-medium">What changed:</div>
              {diffRows.slice(0, 5).map((row) => (
                <div key={`diff-${row.label}`}>
                  <span className="font-medium">{row.label}:</span>{" "}
                  {formatUnknownMetaValue(row.from)} {"->"} {formatUnknownMetaValue(row.to)}
                </div>
              ))}
            </div>
          ) : null}
          {entries.map(([k, v]) => {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              return renderMetaObject(k, v as Record<string, unknown>, k, 0);
            }
            const display = formatPrimitiveMetaValue(k, v);
            return (
              <div key={k}>
                <span className="font-medium">{toFriendlyLabel(k)}:</span>{" "}
                <span>{display}</span>
              </div>
            );
          })}
        </div>
        {hasMore ? (
          <button
            type="button"
            className="italic underline"
            onClick={(event) => {
              event.stopPropagation();
              setExpandedMetaRows((prev) => {
                const next = new Set(prev);
                if (next.has(row.id)) next.delete(row.id);
                else next.add(row.id);
                return next;
              });
            }}
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    );
  };

  const sourcePageOptions = useMemo(() => {
    const normalized = normalizeSourcePage(sourcePage);
    if (!normalized || (!normalized.includes("[") && !normalized.includes("]"))) {
      return FILTERABLE_SOURCE_PAGE_OPTIONS;
    }
    return [
      {
        value: normalized,
        label: `${humanizeSourcePageLabel(normalized)} (template route)`,
      },
      ...FILTERABLE_SOURCE_PAGE_OPTIONS,
    ];
  }, [sourcePage]);
  const actorLabel =
    actorId === "system"
      ? "System"
      : filterActors.find((entry) => entry.id === actorId)?.name ||
        filterActors.find((entry) => entry.id === actorId)?.email ||
        actorId;
  const advancedFilterKeys = new Set([
    "logId",
    "entityId",
    "correlationId",
    "outcome",
    "actorId",
    "actorType",
    "metaStatus",
    "sourcePage",
    "employeeStatus",
    "jobStatus",
    "issueStatus",
  ]);
  const activeFilterChips: Array<{ key: string; label: string; clear: () => void }> = [
    ...(logId ? [{ key: "logId", label: `Log ${formatIdReadable(logId)}`, clear: () => setLogId("") }] : []),
    ...(entityType
      ? [{ key: "entityType", label: `Entity ${humanizeAuditLabel(entityType)}`, clear: () => setEntityType("") }]
      : []),
    ...(entityId ? [{ key: "entityId", label: `Entity ID ${formatIdReadable(entityId)}`, clear: () => setEntityId("") }] : []),
    ...(employeeId
      ? [{ key: "employeeId", label: `Employee ${formatIdReadable(employeeId)}`, clear: () => setEmployeeId("") }]
      : []),
    ...(payrollRunId
      ? [{ key: "payrollRunId", label: `Payroll ${formatIdReadable(payrollRunId)}`, clear: () => setPayrollRunId("") }]
      : []),
    ...(correlationId
      ? [{ key: "correlationId", label: `Correlation ${correlationId}`, clear: () => setCorrelationId("") }]
      : []),
    ...(customerId || customerSearch.trim()
      ? [
          {
            key: "customer",
            label: `Customer ${customerSearch.trim() || formatIdReadable(customerId)}`,
            clear: () => {
              setCustomerId("");
              setCustomerSearch("");
              setCustomerOptions([]);
            },
          },
        ]
      : []),
    ...(action ? [{ key: "action", label: `Action ${humanizeAuditLabel(action)}`, clear: () => setAction("") }] : []),
    ...(outcome ? [{ key: "outcome", label: `Outcome ${humanizeAuditLabel(outcome)}`, clear: () => setOutcome("") }] : []),
    ...(actorId ? [{ key: "actorId", label: `Actor ${actorLabel}`, clear: () => setActorId("") }] : []),
    ...(actorType
      ? [{ key: "actorType", label: `Actor type ${humanizeAuditLabel(actorType)}`, clear: () => setActorType("") }]
      : []),
    ...(start ? [{ key: "start", label: `From ${formatPlainEnglishDate(start)}`, clear: () => setStart("") }] : []),
    ...(end ? [{ key: "end", label: `To ${formatPlainEnglishDate(end)}`, clear: () => setEnd("") }] : []),
    ...(metaStatus
      ? [{ key: "metaStatus", label: `Status ${humanizeAuditLabel(metaStatus)}`, clear: () => setMetaStatus("") }]
      : []),
    ...(sourcePage
      ? [{ key: "sourcePage", label: `Page ${humanizeSourcePageLabel(sourcePage)}`, clear: () => setSourcePage("") }]
      : []),
    ...(riskMode !== "all"
      ? [{ key: "riskMode", label: `Risk ${humanizeAuditLabel(riskMode)}`, clear: () => setRiskMode("all") }]
      : []),
    ...(queueMode !== "all"
      ? [{ key: "queueMode", label: `Queue ${humanizeQueueModeLabel(queueMode)}`, clear: () => setQueueMode("all") }]
      : []),
    ...(employeeStatus
      ? [{ key: "employeeStatus", label: `Employee status ${humanizeAuditLabel(employeeStatus)}`, clear: () => applyEmployeeStatus("") }]
      : []),
    ...(jobStatus ? [{ key: "jobStatus", label: `Job status ${humanizeAuditLabel(jobStatus)}`, clear: () => applyJobStatus("") }] : []),
    ...(issueStatus
      ? [{ key: "issueStatus", label: `Issue status ${humanizeAuditLabel(issueStatus)}`, clear: () => applyIssueStatus("") }]
      : []),
  ];
  const advancedFilterCount = activeFilterChips.filter((chip) => advancedFilterKeys.has(chip.key)).length;
  const applyRiskAndQueue = (nextRiskMode: AuditRiskMode, nextQueueMode: AuditQueueMode = "all") => {
    setRiskMode(nextRiskMode);
    setQueueMode(nextQueueMode);
    setPage(1);
  };

  return (
    <section className="container mx-auto py-6 max-w-5xl space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Recent admin, staff, and accountant activity across orders, payments, inventory, and expenses.
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={clearAll}>
            Clear filters
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={copyFilterLink}
          >
            Copy filter link
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            disabled={!!dateRangeError}
            onClick={() => {
              const exportParams = new URLSearchParams(params.toString());
              exportParams.delete("paginate");
              exportParams.delete("page");
              exportParams.delete("pageSize");
              exportParams.set("format", "csv");
              window.open(`/api/admin/audit?${exportParams.toString()}`, "_blank");
            }}
          >
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            disabled={!!dateRangeError}
            onClick={() => {
              const exportParams = new URLSearchParams(params.toString());
              exportParams.delete("paginate");
              exportParams.delete("page");
              exportParams.delete("pageSize");
              exportParams.set("format", "pdf");
              window.open(`/api/admin/audit?${exportParams.toString()}`, "_blank");
            }}
          >
            Export PDF
          </Button>
          <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
            <Link href="/admin/audit/retention">Retention</Link>
          </Button>
        </div>
      </header>

      <Card className="shadow-md !border-none">
        <CardHeader className="flex flex-col gap-2 space-y-0 py-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full sm:w-auto">
                  Saved filters
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {savedFiltersSource === "loading" ? (
                  <DropdownMenuItem disabled>Loading saved filters…</DropdownMenuItem>
                ) : savedFilters.length === 0 ? (
                  <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                ) : (
                  <>
                    {savedFiltersMine.length > 0 ? (
                      <DropdownMenuItem disabled>My filters</DropdownMenuItem>
                    ) : null}
                    {savedFiltersMine.map((entry) => (
                      <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-4">
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => applySavedFilter(entry)}
                        >
                          {entry.name}
                          {entry.isShared ? " (Shared)" : ""}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeSavedFilter(entry.id);
                          }}
                        >
                          Remove
                        </Button>
                      </DropdownMenuItem>
                    ))}
                    {savedFiltersShared.length > 0 ? (
                      <DropdownMenuItem disabled>Team filters</DropdownMenuItem>
                    ) : null}
                    {savedFiltersShared.map((entry) => (
                      <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-4">
                        <button
                          type="button"
                          className="text-left"
                          onClick={() => applySavedFilter(entry)}
                        >
                          {entry.name}
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {entry.owner?.name || entry.owner?.email || "Shared"}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                {savedFiltersMine.length > 0 ? (
                  <DropdownMenuItem onClick={clearSavedFilters}>
                    Remove all saved filters
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <AdvancedAuditFiltersDialog
              advancedFilterCount={advancedFilterCount}
              action={action}
              setAction={setAction}
              setEntityType={setEntityType}
              setEmployeeId={setEmployeeId}
              setPayrollRunId={setPayrollRunId}
              customerId={customerId}
              setCustomerId={setCustomerId}
              setCustomerSearch={setCustomerSearch}
              setCustomerOptions={setCustomerOptions}
              setRiskMode={setRiskMode}
              setQueueMode={setQueueMode}
              logId={logId}
              setLogId={setLogId}
              entityId={entityId}
              setEntityId={setEntityId}
              correlationId={correlationId}
              setCorrelationId={setCorrelationId}
              metaStatus={metaStatus}
              setMetaStatus={setMetaStatus}
              outcome={outcome}
              setOutcome={setOutcome}
              actorId={actorId}
              setActorId={setActorId}
              filterActors={filterActors}
              actorType={actorType}
              setActorType={setActorType}
              sourcePage={sourcePage}
              sourcePageOptions={sourcePageOptions}
              setSourcePage={setSourcePage}
              employeeStatus={employeeStatus}
              applyEmployeeStatus={applyEmployeeStatus}
              jobStatus={jobStatus}
              applyJobStatus={applyJobStatus}
              issueStatus={issueStatus}
              applyIssueStatus={applyIssueStatus}
              savedFilterName={savedFilterName}
              setSavedFilterName={setSavedFilterName}
              savedFilterError={savedFilterError}
              setSavedFilterError={setSavedFilterError}
              shareSavedFilter={shareSavedFilter}
              setShareSavedFilter={setShareSavedFilter}
              savedFiltersSource={savedFiltersSource}
              dateRangeError={dateRangeError}
              saveCurrentFilter={saveCurrentFilter}
              clearAll={clearAll}
            />
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={clearAll}
            >
              Clear all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeFilterChips.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Active filters</p>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearAll}>
                  Clear all filters
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {activeFilterChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                    onClick={() => {
                      chip.clear();
                      setPage(1);
                    }}
                  >
                    {chip.label} x
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No active filters. Apply a filter or quick preset to narrow the log.</p>
          )}

          {employeeId ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <div>
                Showing activity related to employee <span className="font-medium">{formatIdReadable(employeeId)}</span>.
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                onClick={() => {
                  setEmployeeId("");
                  setPage(1);
                }}
              >
                Clear employee filter
              </Button>
            </div>
          ) : null}

          {payrollRunId ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <div>
                Showing activity related to payroll run <span className="font-medium">{formatIdReadable(payrollRunId)}</span>.
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 border-blue-300 bg-white text-blue-800 hover:bg-blue-100"
                onClick={() => {
                  setPayrollRunId("");
                  setPage(1);
                }}
              >
                Clear payroll filter
              </Button>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-8">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Entity type</label>
              <select
                className="h-9 w-full min-w-0 rounded border bg-background px-2 text-sm"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value.toUpperCase())}
              >
                <option value="">All</option>
                {filterEntityTypes.map((item) => (
                  <option key={item} value={item}>
                    {humanizeAuditLabel(item)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Action</label>
              <select
                className="h-9 w-full min-w-0 rounded border bg-background px-2 text-sm"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                <option value="">All</option>
                {filterActions.map((item) => (
                  <option key={item} value={item}>
                    {humanizeAuditLabel(item)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2 xl:col-span-2">
              <label className="text-xs text-muted-foreground">Customer</label>
              <div className="relative">
                <Input
                  placeholder="Search customer (name/email/phone)"
                  value={customerSearch}
                  onFocus={() => setShowCustomerOptions(true)}
                  onBlur={() => {
                    window.setTimeout(() => setShowCustomerOptions(false), 120);
                  }}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomerSearch(value);
                    setCustomerId("");
                    setShowCustomerOptions(true);
                  }}
                />
                {showCustomerOptions && (customerLookupLoading || customerOptions.length > 0) ? (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-background p-1 shadow-lg">
                    {customerLookupLoading ? (
                      <div className="px-2 py-1 text-xs text-muted-foreground">Searching...</div>
                    ) : (
                      customerOptions.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="w-full rounded px-2 py-1 text-left text-xs hover:bg-muted"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setCustomerId(item.id);
                            setCustomerSearch(customerOptionLabel(item));
                            setShowCustomerOptions(false);
                          }}
                        >
                          {customerOptionLabel(item)}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
              {customerId ? (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground break-all">{formatIdReadable(customerId)}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCustomerId("");
                      setCustomerSearch("");
                      setCustomerOptions([]);
                    }}
                  >
                    Clear
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Risk mode</label>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={riskMode}
                onChange={(e) => setRiskMode((e.target.value || "all") as AuditRiskMode)}
              >
                <option value="all">All activity</option>
                <option value="exceptions">Exceptions only</option>
                <option value="critical">Critical only</option>
                <option value="needs_review">Needs review</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Queue preset</label>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={queueMode}
                onChange={(e) => setQueueMode((e.target.value || "all") as AuditQueueMode)}
              >
                <option value="all">All queues</option>
                <option value="critical_unreviewed">Critical unreviewed</option>
                <option value="archive_soon_unreviewed">Archive soon unreviewed</option>
                <option value="needs_assignment">Needs assignment</option>
                <option value="overdue_tasks">Overdue tasks</option>
                <option value="overdue_reviews_critical">Overdue critical reviews</option>
                <option value="overdue_reviews_high">Overdue high reviews</option>
                <option value="overdue_reviews_medium">Overdue medium reviews</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">From (date)</label>
              <Input
                type="date"
                value={start}
                max={end || undefined}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">To (date)</label>
              <Input
                type="date"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          {dateRangeError ? (
            <p className="text-xs text-red-600">{dateRangeError}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">Dates apply as an inclusive range.</p>
          )}

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Quick presets</p>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset({ days: 7 })}>All activity (7 days)</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset({ entityType: "EXPENSE", days: 7 })}>Expenses (7 days)</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset({ action: "PAYMENT_REFUND", days: 30 })}>Refunds (30 days)</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset({ action: "PRODUCT_STOCK_UPDATE", days: 7 })}>Stock updates (7 days)</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset({ entityType: "PAYMENT", actorType: "CUSTOMER", days: 30 })}>Customer payments (30 days)</Button>
              <Button
                type="button"
                variant={queueMode === "critical_unreviewed" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setQueueMode("critical_unreviewed");
                  setRiskMode("needs_review");
                }}
              >
                Critical unreviewed
              </Button>
              <Button
                type="button"
                variant={queueMode === "overdue_tasks" ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setQueueMode("overdue_tasks");
                  setRiskMode("needs_review");
                }}
              >
                Overdue tasks
              </Button>
            </div>
          </div>

        </CardContent>
      </Card>

      {error ? (
        <p className="text-sm text-red-600">
          Failed to load audit log: {(error as Error).message}
        </p>
      ) : null}

      <Card className="shadow-md !border-none">
        <CardContent className="py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 text-xs">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                  onClick={() => applyRiskAndQueue("needs_review", "all")}
                >
                  Needs review (all filtered): {queueSummary.needsReview}
                </Button>
                <Badge variant="outline" className="border-zinc-300 bg-zinc-50 text-zinc-700">
                  Queue preset: {humanizeQueueModeLabel(queueMode)}
                </Badge>
                <Badge variant="outline" className="border-slate-300 bg-slate-50 text-slate-700">
                  Settings mode: {data?.settingsMode || "editable"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700"
                  onClick={() => applyRiskAndQueue("critical", "all")}
                >
                  Critical (all filtered): {queueSummary.critical}
                </Button>
                <Badge variant="outline" className="border-sky-300 bg-sky-50 text-sky-700">
                  Reviewed today (all filtered): {queueSummary.reviewedToday}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-red-300 bg-red-100 px-2 py-1 text-xs text-red-800"
                  onClick={() => applyRiskAndQueue("needs_review", "overdue_reviews_critical")}
                >
                  Overdue critical reviews: {queueSummary.overdueCritical || 0}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-orange-300 bg-orange-50 px-2 py-1 text-xs text-orange-800"
                  onClick={() => applyRiskAndQueue("needs_review", "overdue_reviews_high")}
                >
                  Overdue high reviews: {queueSummary.overdueHigh || 0}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                  onClick={() => applyRiskAndQueue("needs_review", "overdue_reviews_medium")}
                >
                  Overdue medium reviews: {queueSummary.overdueMedium || 0}
                </Button>
                <Badge variant="outline" className="border-orange-300 bg-orange-50 text-orange-800">
                  Archive soon (14d): {queueSummary.archiveReminder || 0}
                </Badge>
                <Badge variant="outline" className="border-red-300 bg-red-50 text-red-700">
                  Archive escalation (3d): {queueSummary.archiveEscalation || 0}
                </Badge>
                <Badge variant="outline" className="border-red-300 bg-red-100 text-red-800">
                  Already archive-eligible unreviewed: {queueSummary.eligibleForArchiveUnreviewed || 0}
                </Badge>
                <Badge variant="outline" className="border-indigo-300 bg-indigo-50 text-indigo-700">
                  Open tasks: {queueSummary.openTasks || 0}
                </Badge>
                <Badge variant="outline" className="border-indigo-300 bg-indigo-100 text-indigo-800">
                  In-progress tasks: {queueSummary.inProgressTasks || 0}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-rose-300 bg-rose-100 px-2 py-1 text-xs text-rose-800"
                  onClick={() => applyRiskAndQueue("needs_review", "overdue_tasks")}
                >
                  Overdue tasks: {queueSummary.overdueTasks || 0}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-auto border-fuchsia-300 bg-fuchsia-50 px-2 py-1 text-xs text-fuchsia-800"
                  onClick={() => applyRiskAndQueue("needs_review", "needs_assignment")}
                >
                  Needs assignment (escalation window): {queueSummary.archiveNeedsAssignment || 0}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openNotificationCenter}
              >
                Notification center ({(notificationCounts.overdueReview || 0) + (notificationCounts.overdueTask || 0) + (notificationCounts.archiveEscalation || 0)})
              </Button>
              {isAdmin ? (
                <Button asChild type="button" variant="outline" size="sm">
                  <Link href="/admin/audit/settings">Audit settings</Link>
                </Button>
              ) : null}
              {isAdmin ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setNotifyDialogOpen(true)}
                >
                  Notify escalation owners
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelectAllReviewable(!allReviewableSelected)}
                disabled={reviewableRowIds.length === 0}
              >
                {allReviewableSelected ? "Unselect page exceptions" : "Select page exceptions"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openBulkReviewDialog(true)}
                disabled={selectedRowIds.size === 0}
              >
                Mark selected reviewed ({selectedRowIds.size})
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openBulkTaskDialog}
                disabled={selectedRowIds.size === 0 || !canManageTasks}
              >
                Assign selected task ({selectedRowIds.size})
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openBulkReviewDialog(false)}
                disabled={selectedRowIds.size === 0 || !isAdmin}
              >
                Clear selected review ({selectedRowIds.size})
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {!sourcePage.trim() && Boolean(performanceData?.items?.length) ? (
        <Card className="shadow-md !border-none">
          <CardHeader>
            <CardTitle className="text-base">Reviewer Performance (30 days)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="overflow-x-auto">
              <table className="min-w-[720px] w-full text-left text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="py-1 pr-3">Reviewer</th>
                    <th className="py-1 pr-3">Reviewed</th>
                    <th className="py-1 pr-3">Avg hours to review</th>
                    <th className="py-1 pr-3">Assigned open</th>
                    <th className="py-1 pr-3">Assigned in progress</th>
                    <th className="py-1 pr-3">Assigned overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {performanceData?.items?.slice(0, 8).map((item) => (
                    <tr key={item.reviewerId} className="border-b last:border-b-0">
                      <td className="py-1 pr-3">{item.reviewerName}</td>
                      <td className="py-1 pr-3">{item.reviewedCount}</td>
                      <td className="py-1 pr-3">{item.avgHoursToReview}</td>
                      <td className="py-1 pr-3">{item.assignedOpen}</td>
                      <td className="py-1 pr-3">{item.assignedInProgress}</td>
                      <td className="py-1 pr-3">{item.assignedOverdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-md !border-none">
        <CardContent className="p-0">
          {tableScrollWidth > tableClientWidth + 2 ? (
            <div className="hidden border-b px-4 py-2 md:block">
              <div ref={topScrollRef} className="overflow-x-auto">
                <div
                  className="h-2"
                  style={{ width: Math.max(tableScrollWidth, tableClientWidth) }}
                />
              </div>
            </div>
          ) : null}
          <div className="space-y-3 p-3 md:hidden">
            {rows.length === 0 ? (
              <div className="rounded border p-4 text-center text-sm text-muted-foreground">
                {isPending ? (
                  "Loading activity…"
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <span>No activity found for the current filters.</span>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" variant="outline" onClick={clearAll}>
                        Clear filters
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => applyPreset({ days: 7 })}
                      >
                        Last 7 days
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              paginatedRows.map((row) => (
                <div key={row.id} className="rounded border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </div>
                    {(() => {
                      const risk = riskById.get(row.id);
                      const selectable = Boolean(risk && risk.severity !== "LOW");
                      return (
                        <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={selectedRowIds.has(row.id)}
                            disabled={!selectable}
                            onChange={(event) => toggleSelectedRow(row.id, event.target.checked)}
                          />
                          Pick
                        </label>
                      );
                    })()}
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">{renderActorSummary(row)}</div>
                    <span className="shrink-0 rounded border px-2 py-0.5 font-mono text-[10px]">
                      {resolveAuditActionLabel(row)}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{renderAgingSummary(row)}</div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {renderRiskSummary(row)}
                    <div className="flex flex-wrap gap-2">
                      {(() => {
                        const risk = riskById.get(row.id);
                        if (!risk || risk.severity === "LOW") return null;
                        if (risk.reviewed && !isAdmin) return null;
                        return (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openReviewDialog(row, !risk.reviewed)}
                          >
                            {risk.reviewed
                              ? (!isAdmin && risk.severity === "CRITICAL" ? "Request clear review" : "Clear review")
                              : "Mark reviewed"}
                          </Button>
                        );
                      })()}
                      {(() => {
                        const risk = riskById.get(row.id);
                        if (!risk || risk.severity === "LOW" || !canManageTasks) return null;
                        return (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => openTaskDialogForRow(row)}
                          >
                            Task
                          </Button>
                        );
                      })()}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openHistoryDialog(row)}
                      >
                        History
                      </Button>
                      {(() => {
                        const meta = (row.meta || {}) as Record<string, unknown>;
                        const pending = String(meta.reviewClearRequestStatus || "").toUpperCase() === "PENDING_APPROVAL";
                        if (!isAdmin || !pending) return null;
                        return (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => approveOrRejectClearRequest(row, true)}
                            >
                              Approve clear
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => approveOrRejectClearRequest(row, false)}
                            >
                              Reject clear
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  {(() => {
                    const risk = riskById.get(row.id);
                    if (!risk || risk.severity === "LOW") return null;
                    const task = parseRowTask(row);
                    return (
                      <div className="text-[11px] text-muted-foreground">
                        Task: {task.status.replace("_", " ").toLowerCase()}
                        {task.assigneeName ? ` | Owner: ${task.assigneeName}` : " | Owner: Unassigned"}
                        {task.dueAt ? ` | Due: ${new Date(task.dueAt).toLocaleDateString()}` : ""}
                      </div>
                    );
                  })()}
                  <div>{renderEntitySummary(row)}</div>
                  <div className="rounded bg-muted/30 p-2 text-[11px]">
                    {renderMetaCell(row)}
                  </div>
                </div>
              ))
            )}
          </div>
          <div ref={tableWrapRef} className="hidden md:block">
            <Table className="min-w-[1520px] text-xs table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead style={{ width: 46 }}>
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={allReviewableSelected}
                      disabled={reviewableRowIds.length === 0}
                      onChange={(event) => setSelectAllReviewable(event.target.checked)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("when") }}>
                    When
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("when", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("aging") }}>
                    Aging
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("aging", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("actor") }}>
                    Actor
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("actor", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("action") }}>
                    Action
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("action", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("entity") }}>
                    Entity
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("entity", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("risk") }}>
                    Risk
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("risk", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("meta") }}>
                    Meta
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("meta", event)}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-4 text-muted-foreground">
                      {isPending ? (
                        "Loading activity…"
                      ) : (
                        <div className="flex flex-col items-center gap-3">
                          <span>No activity found for the current filters.</span>
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button size="sm" variant="outline" onClick={clearAll}>
                              Clear filters
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => applyPreset({ days: 7 })}
                            >
                              Last 7 days
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell style={{ width: 46 }}>
                        {(() => {
                          const risk = riskById.get(row.id);
                          const selectable = Boolean(risk && risk.severity !== "LOW");
                          return (
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={selectedRowIds.has(row.id)}
                              disabled={!selectable}
                              onChange={(event) => toggleSelectedRow(row.id, event.target.checked)}
                            />
                          );
                        })()}
                      </TableCell>
                      <TableCell style={{ width: getColWidth("when") }}>
                        <span className="block truncate">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell style={{ width: getColWidth("aging") }}>
                        <span className="block truncate">{renderAgingSummary(row)}</span>
                      </TableCell>
                      <TableCell style={{ width: getColWidth("actor") }}>
                        {renderActorSummary(row)}
                      </TableCell>
                      <TableCell style={{ width: getColWidth("action") }}>
                        <span className="block font-mono text-[11px] truncate">{resolveAuditActionLabel(row)}</span>
                      </TableCell>
                      <TableCell style={{ width: getColWidth("entity") }}>
                        {renderEntitySummary(row)}
                      </TableCell>
                      <TableCell style={{ width: getColWidth("risk") }} className="space-y-1">
                        {renderRiskSummary(row)}
                        <div className="flex flex-wrap gap-1">
                          {(() => {
                            const risk = riskById.get(row.id);
                            if (!risk || risk.severity === "LOW") return null;
                            if (risk.reviewed && !isAdmin) return null;
                            return (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => openReviewDialog(row, !risk.reviewed)}
                              >
                                {risk.reviewed
                                  ? (!isAdmin && risk.severity === "CRITICAL" ? "Request clear review" : "Clear review")
                                  : "Mark reviewed"}
                              </Button>
                            );
                          })()}
                          {(() => {
                            const risk = riskById.get(row.id);
                            if (!risk || risk.severity === "LOW" || !canManageTasks) return null;
                            return (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => openTaskDialogForRow(row)}
                              >
                                Task
                              </Button>
                            );
                          })()}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openHistoryDialog(row)}
                          >
                            History
                          </Button>
                          {(() => {
                            const meta = (row.meta || {}) as Record<string, unknown>;
                            const pending =
                              String(meta.reviewClearRequestStatus || "").toUpperCase() === "PENDING_APPROVAL";
                            if (!isAdmin || !pending) return null;
                            return (
                              <>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => approveOrRejectClearRequest(row, true)}
                                >
                                  Approve clear
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => approveOrRejectClearRequest(row, false)}
                                >
                                  Reject clear
                                </Button>
                              </>
                            );
                          })()}
                        </div>
                        {(() => {
                          const risk = riskById.get(row.id);
                          if (!risk || risk.severity === "LOW") return null;
                          const task = parseRowTask(row);
                          return (
                            <div className="text-[10px] text-muted-foreground">
                              {task.status.replace("_", " ").toLowerCase()}
                              {task.assigneeName ? ` | ${task.assigneeName}` : " | Unassigned"}
                              {task.dueAt ? ` | Due ${new Date(task.dueAt).toLocaleDateString()}` : ""}
                            </div>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="whitespace-normal break-words" style={{ width: getColWidth("meta") }}>
                        {renderMetaCell(row)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Page {currentPage} of {totalPages} ({total} event{total === 1 ? "" : "s"})
          </span>
          <div className="flex items-center gap-1">
            <span>Rows per page:</span>
            <select
              className="h-7 rounded border bg-background px-1 text-xs"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value) || 50;
                setPageSize(next);
                setPage(1);
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => {
              void refreshAuditQueries();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      <Dialog
        open={removeFilterDialogOpen}
        onOpenChange={(open) => {
          setRemoveFilterDialogOpen(open);
          if (!open) setPendingRemoveFilter(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove saved filter?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pendingRemoveFilter
              ? `This will delete "${pendingRemoveFilter.name}" from saved filters.`
              : "This will delete the selected saved filter."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRemoveFilterDialogOpen(false);
                setPendingRemoveFilter(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRemoveSavedFilter}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeAllFiltersDialogOpen}
        onOpenChange={setRemoveAllFiltersDialogOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove all saved filters?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {savedFiltersSource === "server"
              ? "This will delete all filters you own, including shared ones."
              : "This will delete all saved filters for your account on this browser."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveAllFiltersDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmClearSavedFilters}>
              Remove all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          setReviewDialogOpen(open);
          if (!open) {
            setPendingReviewDialog(null);
            setReviewNoteInput("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingReviewDialog?.nextReviewed ? "Mark as reviewed?" : "Clear review mark?"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Selected rows:{" "}
              <span className="font-medium text-foreground">
                {pendingReviewDialog?.ids.length || 0}
              </span>
            </p>
            {pendingReviewDialog?.actionSamples?.length ? (
              <p>
                Actions:{" "}
                <span className="font-mono text-xs text-foreground">
                  {pendingReviewDialog.actionSamples.join(", ")}
                </span>
              </p>
            ) : null}
            <label className="space-y-1 block">
              <span className="text-xs">
                {pendingReviewDialog?.nextReviewed
                  ? "Review note (optional)"
                  : "Clear reason (required, min 8 chars)"}
              </span>
              <Input
                value={reviewNoteInput}
                maxLength={600}
                onChange={(event) => setReviewNoteInput(event.target.value)}
                placeholder={
                  pendingReviewDialog?.nextReviewed
                    ? "Why this exception is acceptable"
                    : "Why the review mark is being removed"
                }
              />
            </label>
            {clearReasonError ? (
              <p className="text-xs text-red-600">{clearReasonError}</p>
            ) : null}
            {!pendingReviewDialog?.nextReviewed && !isAdmin ? (
              <p className="text-xs text-red-600">Only ADMIN can clear review marks.</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setReviewDialogOpen(false);
                setPendingReviewDialog(null);
                setReviewNoteInput("");
              }}
              disabled={reviewSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitReviewChange}
              disabled={
                reviewSubmitting ||
                !!clearReasonError ||
                (pendingReviewDialog?.nextReviewed === false && !isAdmin)
              }
            >
              {reviewSubmitting
                ? "Saving..."
                : pendingReviewDialog?.nextReviewed
                  ? "Mark reviewed"
                  : "Clear review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={taskDialogOpen}
        onOpenChange={(open) => {
          setTaskDialogOpen(open);
          if (!open) {
            setPendingTaskRow(null);
            setPendingTaskIds([]);
            setTaskEvidence([]);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Manage review task</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Target:{" "}
              <span className="font-mono text-xs text-foreground">
                {pendingTaskIds.length > 1
                  ? `${pendingTaskIds.length} selected rows`
                  : pendingTaskRow?.action || "-"}
              </span>
            </p>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Task status</span>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={taskDraft.status}
                onChange={(event) =>
                  setTaskDraft((prev) => ({ ...prev, status: event.target.value as ReviewTaskStatus }))
                }
              >
                <option value="OPEN">Open</option>
                <option value="IN_PROGRESS">In progress</option>
                <option value="RESOLVED">Resolved</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Assignee (Admin)</span>
              <select
                className="h-9 w-full rounded border bg-background px-2 text-sm"
                value={taskDraft.assigneeId}
                onChange={(event) => setTaskDraft((prev) => ({ ...prev, assigneeId: event.target.value }))}
              >
                <option value="">Unassigned</option>
                {assigneeOptions.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name || actor.email || actor.id} ({actor.role})
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Due date</span>
              <Input
                type="date"
                value={taskDraft.dueAt}
                onChange={(event) => setTaskDraft((prev) => ({ ...prev, dueAt: event.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Task note (optional)</span>
              <Input
                value={taskDraft.note}
                maxLength={300}
                onChange={(event) => setTaskDraft((prev) => ({ ...prev, note: event.target.value }))}
                placeholder="Who owns this and what is expected"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Attach evidence (image)</span>
              <Input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={taskEvidenceUploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  uploadTaskEvidence(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {taskEvidence.length > 0 ? (
              <div className="space-y-1">
                {taskEvidence.map((item, idx) => (
                  <div key={`${item.url}-${idx}`} className="flex items-center justify-between gap-2 text-xs">
                    <a href={item.url} target="_blank" rel="noreferrer" className="underline truncate">
                      {item.name}
                    </a>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setTaskEvidence((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {taskValidationError ? (
              <p className="text-xs text-red-600">{taskValidationError}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setTaskDialogOpen(false);
                setPendingTaskRow(null);
                setPendingTaskIds([]);
                setTaskEvidence([]);
              }}
              disabled={taskSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitTaskUpdate}
              disabled={taskSubmitting || !!taskValidationError}
            >
              {taskSubmitting ? "Saving..." : "Save task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={historyDialogOpen}
        onOpenChange={(open) => {
          setHistoryDialogOpen(open);
          if (!open) {
            setHistoryRow(null);
            setHistoryItems([]);
            setHistoryError("");
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Review history</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Target: <span className="font-mono text-xs text-foreground">{historyRow?.action || "-"}</span>
            </p>
            {historyLoading ? <p className="text-muted-foreground">Loading history...</p> : null}
            {historyError ? <p className="text-red-600">{historyError}</p> : null}
            {!historyLoading && !historyError && historyItems.length === 0 ? (
              <p className="text-muted-foreground">No review/task history found for this row.</p>
            ) : null}
            {!historyLoading && !historyError && historyItems.length > 0 ? (
              <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded border p-2">
                {historyItems.map((item) => (
                  <div key={item.id} className="rounded border px-2 py-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()} | {item.action}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {item.actor?.name || item.actor?.email || "System"}
                    </div>
                    <div>{item.summary}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setHistoryDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notificationOpen} onOpenChange={setNotificationOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>SLA Notification Center</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">
                Overdue reviews: {notificationCounts.overdueReview}
              </Badge>
              <Badge variant="outline" className="border-red-300 bg-red-50 text-red-700">
                Overdue tasks: {notificationCounts.overdueTask}
              </Badge>
              <Badge variant="outline" className="border-orange-300 bg-orange-50 text-orange-700">
                Archive escalation: {notificationCounts.archiveEscalation}
              </Badge>
            </div>
            {notificationLoading ? <p className="text-muted-foreground">Loading notifications...</p> : null}
            {notificationError ? <p className="text-red-600">{notificationError}</p> : null}
            {!notificationLoading && !notificationError && notificationItems.length === 0 ? (
              <p className="text-muted-foreground">No SLA breach notifications right now.</p>
            ) : null}
            {!notificationLoading && !notificationError && notificationItems.length > 0 ? (
              <div className="max-h-[55vh] space-y-2 overflow-y-auto rounded border p-2">
                {notificationItems.map((item) => (
                  <div key={item.id} className="rounded border px-2 py-1.5">
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(item.createdAt).toLocaleString()} | {item.action} | {item.severity}
                    </div>
                    <div>{item.message}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {item.entityType} {formatIdReadable(item.entityId)}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNotificationOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={notifyDialogOpen} onOpenChange={setNotifyDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send escalation notification?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>This sends an escalation digest to configured admin recipients.</p>
            <p>
              Snapshot: Critical {queueSummary.critical || 0}, Needs review {queueSummary.needsReview || 0},
              Overdue tasks {queueSummary.overdueTasks || 0}, Needs assignment {queueSummary.archiveNeedsAssignment || 0}.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setNotifyDialogOpen(false)} disabled={notifySubmitting}>
              Cancel
            </Button>
            <Button type="button" onClick={sendEscalationNotification} disabled={notifySubmitting}>
              {notifySubmitting ? "Sending..." : "Send notification"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function AdminAuditPage() {
  const { data: session, status } = useSession();
  const currentRole = String((session?.user as { role?: string } | undefined)?.role || "");
  const isAdmin = currentRole === "ADMIN";
  if (status === "loading") {
    return <div className="p-6 text-sm text-muted-foreground">Loading audit log...</div>;
  }
  if (!isAdmin) {
    return (
      <section className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            The audit log is restricted to admin users.
          </CardContent>
        </Card>
      </section>
    );
  }
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading audit log…</div>}>
      <AdminAuditContent />
    </Suspense>
  );
}
