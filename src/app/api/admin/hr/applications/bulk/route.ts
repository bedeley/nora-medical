import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  normalizeAuditText,
  planBulkApplicationStageUpdates,
  requiresApplicationDecisionNote,
  validateHiringConflict,
  type ApplicationStage,
} from "@/lib/hr-hiring-utils";

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]),
  notes: z.string().optional().or(z.literal("")),
  expectedUpdatedAtById: z.record(z.string(), z.string()).optional(),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function PATCH(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const note = normalizeOptional(parsed.data.notes);
  const nextStage = parsed.data.stage as ApplicationStage;
  if (requiresApplicationDecisionNote(nextStage) && !note) {
    return NextResponse.json(
      { error: "A short note is required when stage is Rejected or Withdrawn." },
      { status: 400 },
    );
  }

  const existingRows = await prisma.application.findMany({
    where: { id: { in: parsed.data.ids } },
    select: { id: true, stage: true, updatedAt: true },
  });
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const plan = planBulkApplicationStageUpdates(
    parsed.data.ids,
    existingRows.map((row) => ({ id: row.id, stage: row.stage as ApplicationStage })),
    nextStage,
  );
  const updated: Array<{ id: string; from: string; to: string }> = [];

  for (const item of plan.updated) {
    const existing = existingById.get(item.id);
    if (!existing) {
      plan.skipped.push({ id: item.id, reason: "Not found." });
      continue;
    }
    const expectedUpdatedAt = String(parsed.data.expectedUpdatedAtById?.[item.id] || "").trim();
    const conflictCheck = validateHiringConflict(existing.updatedAt, expectedUpdatedAt);
    if (!conflictCheck.ok) {
      plan.skipped.push({ id: item.id, reason: conflictCheck.error });
      continue;
    }
    const row = await prisma.application.update({
      where: { id: item.id },
      data: {
        stage: nextStage,
        ...(note !== null ? { notes: note } : {}),
      },
      select: { id: true, stage: true },
    });
    updated.push({ id: row.id, from: item.from, to: row.stage });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_APPLICATION_BULK_UPDATE",
      entityType: "APPLICATION",
      entityId: "bulk",
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
        section: normalizeAuditText(parsed.data.section, "applications"),
        operation: normalizeAuditText(parsed.data.operation, "bulk_update_application_stage"),
        before: {
          requestedCount: parsed.data.ids.length,
        },
        after: {
          updatedCount: updated.length,
          skippedCount: plan.skipped.length,
          stageTo: nextStage,
        },
        status: "SUCCESS",
        resultSummary: normalizeAuditText(
          parsed.data.resultSummary,
          `Bulk stage update completed. Updated ${updated.length}; skipped ${plan.skipped.length}.`,
        ),
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    updatedCount: updated.length,
    skippedCount: plan.skipped.length,
    updated,
    skipped: plan.skipped,
  });
}
