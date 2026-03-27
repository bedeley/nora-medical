import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { collectExpiredJobKeys, collectOverflowJobKeys } from "@/lib/accounting-report-export-jobs";
import { resolveBalanceSheetAsOf } from "@/lib/balance-sheet-report-utils";
import {
  isBalanceSheetExportRoleAuthorized,
  normalizeBalanceSheetExportJobType,
  normalizeBalanceSheetExportSortBy,
  normalizeBalanceSheetExportSortDir,
} from "@/lib/balance-sheet-export-jobs-helpers";

type JobType = "balance_sheet_csv" | "balance_sheet_pdf" | "reporting_pack_csv";
type SortBy = "code" | "name" | "balance";
type SortDir = "asc" | "desc";

type Body = {
  type?: JobType;
  asOf?: string | null;
  sortBy?: SortBy | null;
  sortDir?: SortDir | null;
  correlationId?: string | null;
};

type StoredExportJob = {
  id: string;
  type: JobType;
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  requestUrl?: string | null;
  failReason?: string | null;
  asOf?: string | null;
  sortBy?: SortBy;
  sortDir?: SortDir;
  correlationId?: string | null;
  requestedBy?: string | null;
  createdAt: number;
  expiresAt: number;
};

const EXPORT_JOBS_RETENTION_COUNT = 500;
const EXPORT_JOB_TTL_MS = 15 * 60 * 1000;

function normalizeStoredJob(row: { key: string; value: Prisma.JsonValue; createdAt: Date }): StoredExportJob | null {
  const value = (row.value || {}) as Record<string, unknown>;
  const id = String(value.id || row.key.replace("report.export.job.", ""));
  const type = normalizeBalanceSheetExportJobType(value.type) || "balance_sheet_csv";
  const statusRaw = String(value.status || "QUEUED").toUpperCase();
  const status: StoredExportJob["status"] = statusRaw === "READY" || statusRaw === "FAILED" ? statusRaw : "QUEUED";
  const downloadUrl = String(value.downloadUrl || "");
  const requestUrl = value.requestUrl ? String(value.requestUrl) : null;
  const createdAt = Number(value.createdAt || row.createdAt.getTime());
  const expiresAt = Number(value.expiresAt || 0);
  if (!downloadUrl || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  return {
    id,
    type,
    status,
    downloadUrl,
    requestUrl,
    failReason: value.failReason ? String(value.failReason) : null,
    asOf: value.asOf ? String(value.asOf) : null,
    sortBy: normalizeBalanceSheetExportSortBy(value.sortBy),
    sortDir: normalizeBalanceSheetExportSortDir(value.sortDir),
    correlationId: value.correlationId ? String(value.correlationId) : null,
    requestedBy: value.requestedBy ? String(value.requestedBy) : null,
    createdAt,
    expiresAt,
  };
}

async function enforceExportJobsRetention(now: number) {
  const candidates = await prisma.siteSetting.findMany({
    where: { key: { startsWith: "report.export.job." } },
    select: { key: true, value: true, createdAt: true },
    take: 3000,
    orderBy: { updatedAt: "desc" },
  });
  const rows = candidates.map((row) => ({
    key: row.key,
    value: row.value,
    fallbackCreatedAtMs: row.createdAt.getTime(),
  }));
  const expiredKeys = collectExpiredJobKeys(rows, now);
  const overflowKeys = collectOverflowJobKeys(rows, now, EXPORT_JOBS_RETENTION_COUNT);
  const deleteKeys = Array.from(new Set([...expiredKeys, ...overflowKeys]));
  if (deleteKeys.length === 0) return 0;
  const deleted = await prisma.siteSetting.deleteMany({ where: { key: { in: deleteKeys } } });
  return deleted.count;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isBalanceSheetExportRoleAuthorized((session.user as AuthenticatedUser | undefined)?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-accounting-balance-sheet-export-jobs-list", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { searchParams } = new URL(req.url);
  const requestedLimit = Number(searchParams.get("limit") || 3);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 10) : 3;
  const includeSummary = searchParams.get("summary") === "1";
  const now = Date.now();
  await enforceExportJobsRetention(now);

  const rows = await prisma.siteSetting.findMany({
    where: { key: { startsWith: "report.export.job.bs-" } },
    orderBy: { updatedAt: "desc" },
    take: includeSummary ? 250 : limit,
  });
  const jobs = rows
    .map((row) => normalizeStoredJob(row))
    .filter((job): job is StoredExportJob => Boolean(job && job.expiresAt > now));
  const recentJobs = jobs.slice(0, limit);
  if (!includeSummary) {
    return NextResponse.json({ jobs: recentJobs });
  }

  const windowStart = now - 30 * 24 * 60 * 60 * 1000;
  const jobsInWindow = jobs.filter((job) => job.createdAt >= windowStart);
  const successful = jobsInWindow.filter((job) => job.status === "READY");
  const lastSuccessfulAt = successful.length > 0 ? Math.max(...successful.map((job) => job.createdAt)) : null;

  return NextResponse.json({
    jobs: recentJobs,
    stats: {
      lastSuccessfulAt,
      jobsInLast30Days: jobsInWindow.length,
    },
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isBalanceSheetExportRoleAuthorized(actor?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-balance-sheet-export-jobs-create", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const type = normalizeBalanceSheetExportJobType(body.type);
  if (!type) {
    return NextResponse.json({ error: "Export type is required." }, { status: 400 });
  }

  const defaultAsOf = new Date().toISOString().slice(0, 10);
  const parsed = resolveBalanceSheetAsOf(body.asOf, defaultAsOf);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const asOfEffective = parsed.asOf;
  const sortBy = normalizeBalanceSheetExportSortBy(body.sortBy);
  const sortDir = normalizeBalanceSheetExportSortDir(body.sortDir);
  const correlationId = String(body.correlationId || "").trim() || null;

  const query = new URLSearchParams();
  query.set("job", "1");
  query.set("asOf", asOfEffective);
  query.set("sortBy", sortBy);
  query.set("sortDir", sortDir);
  if (correlationId) query.set("correlationId", correlationId);
  const requestUrl =
    type === "balance_sheet_csv"
      ? `/api/admin/accounting/reports/balance-sheet/export?${query.toString()}`
      : type === "balance_sheet_pdf"
        ? `/api/admin/accounting/reports/balance-sheet/export/pdf?${query.toString()}`
        : `/api/admin/accounting/reports/pack/export?${query.toString()}&source=balance-sheet`;

  const jobId = `bs-${randomUUID()}`;
  const downloadUrl = `/api/admin/accounting/reports/balance-sheet/export/jobs/${encodeURIComponent(jobId)}/download`;
  const now = Date.now();
  const expiresAt = now + EXPORT_JOB_TTL_MS;
  await enforceExportJobsRetention(now);

  const requestedBy = actor?.name || actor?.email || "Unknown admin";
  const key = `report.export.job.${jobId}`;
  const value: Prisma.InputJsonValue = {
    id: jobId,
    type,
    status: "QUEUED",
    downloadUrl,
    requestUrl,
    failReason: null,
    asOf: asOfEffective,
    sortBy,
    sortDir,
    correlationId,
    requestedBy,
    createdAt: now,
    expiresAt,
  };
  await prisma.siteSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.balance-sheet.job.create",
    entityType: "AccountingReportExportJob",
    entityId: jobId,
    meta: {
      sourcePage: "admin/accounting/reports/balance-sheet",
      section: "exports",
      operation: "queue_export",
      correlationId,
      before: {
        asOf: body.asOf || null,
      },
      after: {
        asOf: asOfEffective,
      },
      type,
      sortBy,
      sortDir,
      downloadUrl,
      requestUrl,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
      requestedBy,
      expiresAt,
    },
  });

  return NextResponse.json({
    jobId,
    status: "QUEUED",
    downloadUrl,
    expiresAt,
  });
}
