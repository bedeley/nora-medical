"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
  LineChart,
  Line,
} from "recharts";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// ── Types ────────────────────────────────────────────────────────────────────

type ManagerWorkloadRow = {
  managerId: string;
  managerName: string | null;
  openCount: number;
  inReviewCount: number;
  quotedCount: number;
};

type TrendRow = {
  month: string;
  submitted: number;
  approved: number;
  rejected: number;
  closed: number;
};

type AnalyticsResponse = {
  summary: {
    totalRequests: number;
    openCount: number;
    unassignedOpenCount: number;
    draftEligibleCount: number;
    convertedToDraftCount: number;
    convertedToDraftRatePct: number;
    avgHoursToAssignment: number | null;
    avgHoursToQuoted: number | null;
    avgHoursToApproved: number | null;
    statusCounts: Record<string, number>;
    requestTypeCounts: Record<string, number>;
  };
  topRequested: Array<{ itemRef: string; count: number }>;
  oldestOpen: Array<{
    id: string;
    status: string;
    requestType: string;
    clinicName: string;
    ageDays: number;
    hasAssignment: boolean;
    accountManagerId: string | null;
  }>;
  managerWorkload: ManagerWorkloadRow[];
  trend: TrendRow[];
  truncated: boolean;
};

// ── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  SUBMITTED: "#94a3b8",
  IN_REVIEW: "#f59e0b",
  QUOTED: "#6366f1",
  APPROVED: "#22c55e",
  REJECTED: "#ef4444",
  CLOSED: "#64748b",
};

const TYPE_COLORS: Record<string, string> = {
  QUOTE: "#6366f1",
  PO_UPLOAD: "#0ea5e9",
  RECURRING_REORDER: "#10b981",
};

const TREND_COLORS = {
  submitted: "#94a3b8",
  approved: "#22c55e",
  rejected: "#ef4444",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  });

function statusLabel(status: string): string {
  switch (status) {
    case "SUBMITTED": return "Submitted";
    case "IN_REVIEW": return "In Review";
    case "QUOTED": return "Quoted";
    case "APPROVED": return "Approved";
    case "REJECTED": return "Rejected";
    case "CLOSED": return "Closed";
    default: return status;
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "QUOTE": return "Quote";
    case "PO_UPLOAD": return "PO Upload";
    case "RECURRING_REORDER": return "Recurring";
    default: return type;
  }
}

function formatHours(hours: number | null): string {
  if (hours === null || hours === undefined) return "n/a";
  if (hours < 1) return "< 1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const remaining = Math.round(hours % 24);
  return remaining > 0 ? `${days}d ${remaining}h` : `${days}d`;
}

function formatRelativeTime(date: Date | null): string {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 10) return "just now";
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  return `${diffHours}h ago`;
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <CardHeader>
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />
        ))}
      </CardContent>
    </Card>
  );
}

function SkeletonChartCard() {
  return (
    <Card>
      <CardHeader>
        <div className="h-4 w-36 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="h-[220px] w-full animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function B2BProcurementAnalyticsPage() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { role?: string } | undefined)?.role === "ADMIN";

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [relativeTime, setRelativeTime] = useState("");

  const dateError =
    startDate && endDate && startDate > endDate
      ? "Start date must be before end date."
      : null;

  const queryUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (startDate && !dateError) p.set("start", startDate);
    if (endDate && !dateError) p.set("end", endDate);
    const qs = p.toString();
    return `/api/admin/b2b/procurement/analytics${qs ? `?${qs}` : ""}`;
  }, [startDate, endDate, dateError]);

  const {
    data,
    isFetching,
    isLoading,
    error,
    refetch,
    dataUpdatedAt,
  } = useClientQuery<AnalyticsResponse>({
    queryKey: ["admin", "b2b-procurement-analytics", queryUrl],
    queryFn: () => fetcher(queryUrl),
    retry: false,
  });

  // Update last-refreshed timestamp whenever data lands
  useEffect(() => {
    if (dataUpdatedAt) setLastRefreshed(new Date(dataUpdatedAt));
  }, [dataUpdatedAt]);

  // Tick the relative-time string every 30 s
  useEffect(() => {
    const tick = () => setRelativeTime(formatRelativeTime(lastRefreshed));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [lastRefreshed]);

  const summary = data?.summary;

  const statusChartData = useMemo(() => {
    if (!summary?.statusCounts) return [];
    return Object.entries(summary.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({
        name: statusLabel(status),
        count,
        fill: STATUS_COLORS[status] ?? "#94a3b8",
      }));
  }, [summary?.statusCounts]);

  const typeChartData = useMemo(() => {
    if (!summary?.requestTypeCounts) return [];
    return Object.entries(summary.requestTypeCounts).map(([type, count]) => ({
      name: typeLabel(type),
      count,
      fill: TYPE_COLORS[type] ?? "#94a3b8",
    }));
  }, [summary?.requestTypeCounts]);

  const topRequestedMax = useMemo(
    () => Math.max(1, ...(data?.topRequested ?? []).map((r) => r.count)),
    [data?.topRequested],
  );

  const hasDateFilter = Boolean(startDate || endDate);

  // ── Audit link (scoped to this page's sourcePage) ────────────────────────
  const auditHref =
    "/admin/audit?entityType=B2B_PROCUREMENT_ANALYTICS&sourcePage=admin%2Fb2b%2Fprocurement%2Fanalytics";

  // ── Render helpers ───────────────────────────────────────────────────────

  const truncationWarning: ReactNode = Boolean(data?.truncated) ? (
    <div
      role="alert"
      className="rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <strong>Data may be incomplete.</strong> The audit log has exceeded the 10 000-row
      processing limit. Counts and cycle times reflect only the most recent records. Contact
      your administrator to archive older logs.
    </div>
  ) : null;

  const apiErrorWarning: ReactNode = Boolean(error) ? (
    <div
      role="alert"
      className="rounded border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
    >
      Failed to load analytics data. Please refresh or try again later.
    </div>
  ) : null;

  if (isLoading && !data && !hasDateFilter) {
    return (
      <section className="container mx-auto py-8 max-w-6xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="h-7 w-64 animate-pulse rounded bg-muted" />
            <div className="mt-1 h-4 w-48 animate-pulse rounded bg-muted" />
          </div>
        </div>
        <SkeletonCard rows={1} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonChartCard />
          <SkeletonChartCard />
        </div>
        <SkeletonCard rows={5} />
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 max-w-6xl space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">B2B Procurement Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Track workflow performance, aging, and demand trends.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastRefreshed && (
            <span className="text-xs text-muted-foreground">Updated {relativeTime}</span>
          )}
          <Link href="/admin/b2b/procurement">
            <Button variant="outline" size="sm">Back to Workflow</Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing..." : "Refresh"}
          </Button>
          {isAdmin && (
            <Link href={auditHref}>
              <Button variant="ghost" size="sm">View audit log</Button>
            </Link>
          )}
        </div>
      </div>

      {/* Truncation warning */}
      {truncationWarning}

      {/* API error */}
      {apiErrorWarning}

      {/* Date range filter */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="analytics-start" className="text-xs text-muted-foreground block mb-1">
                From date
              </label>
              <Input
                id="analytics-start"
                type="date"
                className="h-9 w-full sm:w-[160px]"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="analytics-end" className="text-xs text-muted-foreground block mb-1">
                To date
              </label>
              <Input
                id="analytics-end"
                type="date"
                className="h-9 w-full sm:w-[160px]"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            {hasDateFilter && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={() => { setStartDate(""); setEndDate(""); }}
              >
                Clear dates
              </Button>
            )}
            {hasDateFilter && !dateError && (
              <span className="text-xs text-muted-foreground self-end pb-1">
                Showing requests created in selected range
              </span>
            )}
            {dateError && (
              <span className="text-xs text-destructive self-end pb-1" role="alert">
                {dateError}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* KPI summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Request Volume</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium">{summary?.totalRequests ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Open</span>
              <span className="font-medium">{summary?.openCount ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Unassigned open</span>
              <span
                className={`font-medium ${(summary?.unassignedOpenCount ?? 0) > 0 ? "text-amber-600" : ""}`}
              >
                {summary?.unassignedOpenCount ?? 0}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Cycle Time</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg to assignment</span>
              <span className="font-medium">
                {formatHours(summary?.avgHoursToAssignment ?? null)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg to quoted</span>
              <span className="font-medium">
                {formatHours(summary?.avgHoursToQuoted ?? null)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Avg to approved</span>
              <span className="font-medium">
                {formatHours(summary?.avgHoursToApproved ?? null)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Draft Conversion</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Eligible requests</span>
              <span className="font-medium">{summary?.draftEligibleCount ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Drafts prepared</span>
              <span className="font-medium">{summary?.convertedToDraftCount ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Conversion rate</span>
              <span className="font-medium">{summary?.convertedToDraftRatePct ?? 0}%</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status Distribution + Request Type Mix charts */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Status Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {statusChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={statusChartData}
                  margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                  <Tooltip
                    formatter={(value: number) => [value, "Requests"]}
                    labelStyle={{ fontSize: 12 }}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {statusChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Request Type Mix</CardTitle>
          </CardHeader>
          <CardContent>
            {typeChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={typeChartData}
                  margin={{ top: 4, right: 8, bottom: 4, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                  <Tooltip
                    formatter={(value: number) => [value, "Requests"]}
                    labelStyle={{ fontSize: 12 }}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="count" name="Requests" radius={[3, 3, 0, 0]}>
                    {typeChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Monthly submission trend */}
      {(data?.trend ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Monthly Submission Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart
                data={data!.trend}
                margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                <Tooltip labelStyle={{ fontSize: 12 }} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  type="monotone"
                  dataKey="submitted"
                  name="Submitted"
                  stroke={TREND_COLORS.submitted}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="approved"
                  name="Approved"
                  stroke={TREND_COLORS.approved}
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="rejected"
                  name="Rejected"
                  stroke={TREND_COLORS.rejected}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Top Requested Items + Manager Workload */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top Requested Items</CardTitle>
          </CardHeader>
          <CardContent>
            {data?.topRequested?.length ? (
              <div className="space-y-2 text-sm">
                {data.topRequested.map((row, index) => {
                  const pct = Math.round((row.count / topRequestedMax) * 100);
                  return (
                    <div key={`${row.itemRef}-${row.count}`}>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1.5 truncate pr-2">
                          <span className="shrink-0 text-xs text-muted-foreground w-5 text-right">
                            #{index + 1}
                          </span>
                          <span className="truncate capitalize">{row.itemRef}</span>
                        </div>
                        <span className="shrink-0 font-medium">{row.count}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No item trend data yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Manager Workload (Open)</CardTitle>
          </CardHeader>
          <CardContent>
            {data?.managerWorkload?.length ? (
              <div className="space-y-1 text-sm">
                {data.managerWorkload.map((row) => (
                  <div
                    key={row.managerId}
                    className="flex items-center justify-between rounded border px-2 py-1.5"
                  >
                    <span className="truncate pr-2 font-medium">
                      {row.managerName ?? row.managerId}
                    </span>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      <span className="text-muted-foreground">
                        {row.openCount} open
                      </span>
                      {row.inReviewCount > 0 && (
                        <Badge variant="warning" className="text-xs py-0">
                          {row.inReviewCount} reviewing
                        </Badge>
                      )}
                      {row.quotedCount > 0 && (
                        <Badge variant="secondary" className="text-xs py-0">
                          {row.quotedCount} quoted
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No open requests.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Oldest open requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Oldest Open Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {data?.oldestOpen?.length ? (
            <div className="space-y-1 text-sm">
              {data.oldestOpen.map((row) => (
                <Link
                  key={row.id}
                  href={`/admin/b2b/procurement?search=${encodeURIComponent(row.clinicName)}`}
                  className="block rounded border p-2 hover:bg-muted/50 transition-colors"
                  aria-label={`Open ${row.clinicName} request in workflow`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.clinicName}</span>
                      <Badge
                        variant={
                          row.status === "APPROVED"
                            ? "success"
                            : row.status === "IN_REVIEW"
                              ? "warning"
                              : row.status === "QUOTED"
                                ? "secondary"
                                : "outline"
                        }
                      >
                        {statusLabel(row.status)}
                      </Badge>
                    </div>
                    <span
                      className={`text-xs font-medium ${
                        row.ageDays >= 7
                          ? "text-red-600"
                          : row.ageDays >= 3
                            ? "text-amber-600"
                            : "text-muted-foreground"
                      }`}
                    >
                      {row.ageDays}d open
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {typeLabel(row.requestType)} -{" "}
                    {row.hasAssignment ? "Assigned" : "Unassigned"}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No open requests.</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
