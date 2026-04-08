import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { collectExpiredJobKeys, collectOverflowJobKeys } from "@/lib/accounting-report-export-jobs";
import { verifyCronSecret } from "@/lib/cron-auth";

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

function hasCronAccess(req: Request) {
  return verifyCronSecret(req, "ACCOUNTING_REPORT_EXPORT_JOBS_CRON_SECRET");
}

async function cleanupExpiredExportJobs() {
  const now = Date.now();
  const rows = await prisma.siteSetting.findMany({
    where: { key: { startsWith: "report.export.job." } },
    select: { key: true, value: true, createdAt: true },
    orderBy: { updatedAt: "desc" },
    take: 3000,
  });
  const normalizedRows = rows.map((row) => ({
    key: row.key,
    value: row.value,
    fallbackCreatedAtMs: row.createdAt.getTime(),
  }));
  const expiredKeys = collectExpiredJobKeys(normalizedRows, now);
  const overflowKeys = collectOverflowJobKeys(normalizedRows, now, 500);
  const deleteKeys = Array.from(new Set([...expiredKeys, ...overflowKeys]));
  if (deleteKeys.length === 0) return 0;
  const deleted = await prisma.siteSetting.deleteMany({
    where: { key: { in: deleteKeys } },
  });
  return deleted.count;
}

export async function GET(req: Request) {
  const cronAccess = hasCronAccess(req);
  let actorId: string | null = null;
  if (!cronAccess) {
    const session = await getServerSession(authOptions);
    const actor = session?.user as AuthenticatedUser | undefined;
    if (!session || !actor || !isAdmin(actor)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!assertSameOrigin(req)) {
      return NextResponse.json({ error: "Bad origin" }, { status: 403 });
    }
    actorId = actor.id;
  }

  const deletedCount = await cleanupExpiredExportJobs();
  await recordAuditLog({
    actorId,
    action: cronAccess ? "report.export.job.cleanup.cron" : "report.export.job.cleanup.manual",
    entityType: "AccountingReportExportJob",
    entityId: "CLEANUP",
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      deletedCount,
      trigger: cronAccess ? "cron" : "manual",
    },
  });

  return NextResponse.json({ ok: true, deletedCount });
}
