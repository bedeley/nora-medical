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
import { parseValidatedDateRange } from "../../../utils";

type Body = {
  type?: "pl_csv" | "reporting_pack_csv";
  start?: string | null;
  end?: string | null;
  basis?: string | null;
  rangeSummary?: string | null;
};

type StoredExportJob = {
  id: string;
  type: "pl_csv" | "reporting_pack_csv";
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  failReason?: string | null;
  rangeSummary?: string | null;
  start?: string | null;
  end?: string | null;
  requestedBy?: string | null;
  createdAt: number;
  expiresAt: number;
};

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function normalizeStoredJob(row: { key: string; value: Prisma.JsonValue; createdAt: Date }): StoredExportJob | null {
  const value = (row.value || {}) as Record<string, unknown>;
  const id = String(value.id || row.key.replace("report.export.job.", ""));
  const type = value.type === "reporting_pack_csv" ? "reporting_pack_csv" : "pl_csv";
  const statusRaw = String(value.status || "QUEUED").toUpperCase();
  const status: StoredExportJob["status"] = statusRaw === "READY" || statusRaw === "FAILED" ? statusRaw : "QUEUED";
  const downloadUrl = String(value.downloadUrl || "");
  const createdAt = Number(value.createdAt || row.createdAt.getTime());
  const expiresAt = Number(value.expiresAt || 0);
  if (!downloadUrl || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    return null;
  }
  return {
    id,
    type,
    status,
    downloadUrl,
    failReason: value.failReason ? String(value.failReason) : null,
    rangeSummary: value.rangeSummary ? String(value.rangeSummary) : null,
    start: value.start ? String(value.start) : null,
    end: value.end ? String(value.end) : null,
    requestedBy: value.requestedBy ? String(value.requestedBy) : null,
    createdAt,
    expiresAt,
  };
}

const EXPORT_JOBS_RETENTION_COUNT = 500;

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
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-accounting-pl-export-jobs-list", 60_000, 120);
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
    where: { key: { startsWith: "report.export.job." } },
    orderBy: { updatedAt: "desc" },
    take: includeSummary ? 250 : limit,
  });

  const jobs = rows
    .map((row) => normalizeStoredJob(row))
    .filter((job): job is StoredExportJob => {
      if (!job) return false;
      return job.expiresAt > now;
    });
  const recentJobs = jobs.slice(0, limit);
  if (!includeSummary) {
    return NextResponse.json({ jobs: recentJobs });
  }

  const windowStart = now - 30 * 24 * 60 * 60 * 1000;
  const jobsInWindow = jobs.filter((job) => job.createdAt >= windowStart);
  const successful = jobsInWindow.filter((job) => job.status === "READY");
  const lastSuccessfulAt = successful.length > 0 ? Math.max(...successful.map((job) => job.createdAt)) : null;

  const rangeCounts = new Map<string, number>();
  for (const job of jobsInWindow) {
    const key = (job.rangeSummary || "Unspecified range").trim() || "Unspecified range";
    rangeCounts.set(key, (rangeCounts.get(key) || 0) + 1);
  }
  let topRangeSummary: string | null = null;
  let topRangeCount = 0;
  for (const [key, count] of rangeCounts.entries()) {
    if (count > topRangeCount) {
      topRangeSummary = key;
      topRangeCount = count;
    }
  }

  return NextResponse.json({
    jobs: recentJobs,
    stats: {
      lastSuccessfulAt,
      topRangeSummary,
      topRangeCount,
      jobsInLast30Days: jobsInWindow.length,
    },
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-pl-export-jobs", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const type = body.type === "reporting_pack_csv" ? "reporting_pack_csv" : body.type === "pl_csv" ? "pl_csv" : null;
  if (!type) {
    return NextResponse.json({ error: "Export type is required." }, { status: 400 });
  }

  let parsedRange: ReturnType<typeof parseValidatedDateRange>;
  try {
    parsedRange = parseValidatedDateRange(body.start ?? null, body.end ?? null);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid date range.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const query = new URLSearchParams();
  query.set("basis", "accrual");
  query.set("job", "1");
  if (parsedRange.normalizedStart) query.set("start", parsedRange.normalizedStart);
  if (parsedRange.normalizedEnd) query.set("end", parsedRange.normalizedEnd);
  const downloadUrl =
    type === "pl_csv"
      ? `/api/admin/accounting/reports/pl/export?${query.toString()}`
      : `/api/admin/accounting/reports/pack/export?${query.toString()}`;

  const jobId = `pl-export-${randomUUID()}`;
  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000;
  await enforceExportJobsRetention(now);
  const requestedBy = actor?.name || actor?.email || "Unknown admin";
  await prisma.siteSetting.upsert({
    where: { key: `report.export.job.${jobId}` },
    update: {
      value: {
        id: jobId,
        type,
        status: "QUEUED",
        downloadUrl,
        failReason: null,
        rangeSummary: String(body.rangeSummary || ""),
        start: parsedRange.normalizedStart,
        end: parsedRange.normalizedEnd,
        requestedBy,
        createdAt: now,
        expiresAt,
      } as Prisma.InputJsonValue,
    },
    create: {
      key: `report.export.job.${jobId}`,
      value: {
        id: jobId,
        type,
        status: "QUEUED",
        downloadUrl,
        failReason: null,
        rangeSummary: String(body.rangeSummary || ""),
        start: parsedRange.normalizedStart,
        end: parsedRange.normalizedEnd,
        requestedBy,
        createdAt: now,
        expiresAt,
      } as Prisma.InputJsonValue,
    },
  });

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.job.create",
    entityType: "AccountingReportExportJob",
    entityId: jobId,
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      reportType: type,
      basis: String(body.basis || "accrual"),
      rangeSummary: String(body.rangeSummary || ""),
      start: parsedRange.normalizedStart,
      end: parsedRange.normalizedEnd,
      downloadUrl,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
    },
  });

  return NextResponse.json({
    jobId,
    status: "QUEUED",
    downloadUrl,
    expiresAt,
  });
}
