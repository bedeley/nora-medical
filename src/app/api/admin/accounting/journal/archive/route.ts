import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { JournalStatus } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const archiveSchema = z.object({
  dryRun: z.boolean().optional(),
  months: z.number().int().min(1).max(120).optional(),
});
const undoSchema = z.object({
  runAt: z.string().datetime(),
});

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

function hasCronAccess(req: Request) {
  const configuredSecret = (process.env.JOURNAL_ARCHIVE_CRON_SECRET || process.env.CRON_SECRET || "").trim();
  const authHeader = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const providedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : headerSecret.trim();
  return Boolean(configuredSecret && providedSecret && configuredSecret === providedSecret);
}

async function executeArchiveRun({
  dryRun,
  months,
  defaultMonths,
  trigger,
  auditActorId,
  auditActor,
  auditAction,
}: {
  dryRun: boolean;
  months: number;
  defaultMonths: number;
  trigger: "manual" | "cron";
  auditActorId: string | null;
  auditActor?: { id: string; name?: string | null; email?: string | null; role?: string | null } | null;
  auditAction: string;
}) {
  const cutoffDate = new Date();
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - months);
  cutoffDate.setUTCHours(23, 59, 59, 999);
  const archiveRunAt = new Date();
  const statuses: JournalStatus[] = [JournalStatus.POSTED, JournalStatus.VOID];

  const where = {
    archivedAt: null,
    entryDate: { lt: cutoffDate },
    status: { in: statuses },
  };

  const candidates = await prisma.journalEntry.count({ where });
  let archived = 0;
  if (!dryRun && candidates > 0) {
    const result = await prisma.journalEntry.updateMany({
      where,
      data: { archivedAt: archiveRunAt },
    });
    archived = result.count;
  }

  await recordAuditLog({
    actorId: auditActorId,
    action: auditAction,
    entityType: "JournalEntry",
    entityId: "ARCHIVE_BATCH",
    meta: {
      months,
      cutoffDate: cutoffDate.toISOString(),
      archiveRunAt: archiveRunAt.toISOString(),
      candidateCount: candidates,
      archivedCount: archived,
      dryRun,
      trigger,
      monthsSource: months === defaultMonths ? "default-policy" : "manual-override",
      defaultMonths,
      includedStatuses: statuses,
      actorId: auditActor?.id || null,
      actorName: auditActor?.name || null,
      actorEmail: auditActor?.email || null,
      actorRole: auditActor?.role || null,
      archivePolicyVersion: 2,
      resultSummary: dryRun
        ? `Dry run only. ${candidates} entries would be archived.`
        : archived > 0
          ? `${archived} entries archived.`
          : "No entries archived.",
      noOpReason:
        candidates === 0
          ? "No eligible entries found under current archive policy."
          : dryRun
            ? "Dry run mode enabled."
            : null,
    },
  });

  return {
    ok: true,
    dryRun,
    months,
    cutoffDate: cutoffDate.toISOString(),
    archiveRunAt: archiveRunAt.toISOString(),
    candidateCount: candidates,
    archivedCount: archived,
  };
}

export async function GET(req: Request) {
  if (!hasCronAccess(req)) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }
  try {
    const configuredMonths = Number(process.env.JOURNAL_ARCHIVE_AFTER_MONTHS || "18");
    const defaultMonths = Number.isFinite(configuredMonths) && configuredMonths > 0 ? Math.floor(configuredMonths) : 18;
    const cronDryRun = String(process.env.JOURNAL_ARCHIVE_CRON_DRY_RUN || "").trim();
    const dryRun = cronDryRun ? cronDryRun === "1" || cronDryRun.toLowerCase() === "true" : false;
    const result = await executeArchiveRun({
      dryRun,
      months: defaultMonths,
      defaultMonths,
      trigger: "cron",
      auditActorId: null,
      auditActor: null,
      auditAction: dryRun ? "journal.archive.cron.dry_run" : "journal.archive.cron.run",
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Journal archive cron error:", error);
    return NextResponse.json({ error: "Failed to run journal archive cron." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !actor || !isAdmin(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const parsed = archiveSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const configuredMonths = Number(process.env.JOURNAL_ARCHIVE_AFTER_MONTHS || "18");
    const defaultMonths = Number.isFinite(configuredMonths) && configuredMonths > 0 ? Math.floor(configuredMonths) : 18;
    const months = parsed.data.months ?? defaultMonths;
    const dryRun = parsed.data.dryRun !== false;

    const result = await executeArchiveRun({
      dryRun,
      months,
      defaultMonths,
      trigger: "manual",
      auditActorId: actor.id,
      auditActor: {
        id: actor.id,
        name: actor.name || null,
        email: actor.email || null,
        role: actor.role || null,
      },
      auditAction: dryRun ? "journal.archive.dry_run" : "journal.archive.run",
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Journal archive run error:", error);
    return NextResponse.json({ error: "Failed to run journal archive." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !actor || !isAdmin(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const parsed = undoSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const runAt = new Date(parsed.data.runAt);
    if (Number.isNaN(runAt.getTime())) {
      return NextResponse.json({ error: "Invalid run timestamp." }, { status: 400 });
    }
    const ageMs = Date.now() - runAt.getTime();
    if (ageMs < 0 || ageMs > 5 * 60 * 1000) {
      return NextResponse.json({ error: "Undo window expired (5 minutes)." }, { status: 400 });
    }
    const result = await prisma.journalEntry.updateMany({
      where: { archivedAt: runAt },
      data: { archivedAt: null },
    });
    await recordAuditLog({
      actorId: actor.id,
      action: "journal.archive.undo",
      entityType: "JournalEntry",
      entityId: "ARCHIVE_BATCH",
      meta: {
        runAt: runAt.toISOString(),
        restoredCount: result.count,
        undoRequestedAt: new Date().toISOString(),
        undoWindowMinutes: 5,
        actorId: actor.id,
        actorName: actor.name || null,
        actorEmail: actor.email || null,
        actorRole: actor.role || null,
        archivePolicyVersion: 2,
        resultSummary:
          result.count > 0
            ? `${result.count} archived entries restored.`
            : "No entries matched the selected archive batch.",
      },
    });
    return NextResponse.json({
      ok: true,
      runAt: runAt.toISOString(),
      restoredCount: result.count,
    });
  } catch (error) {
    console.error("Journal archive undo error:", error);
    return NextResponse.json({ error: "Failed to undo archive batch." }, { status: 500 });
  }
}
