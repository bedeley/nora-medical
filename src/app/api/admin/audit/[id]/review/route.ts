import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { getMissingTaskRequirement, requiresReviewTask } from "@/lib/audit-review-policy";
import { getEffectiveAuditRiskSettings } from "@/lib/audit-risk-settings.server";
import { evaluateAuditRisk } from "@/lib/audit-risk";

type Meta = Record<string, unknown>;

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT";
}

function parseMeta(raw: string | null): Meta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    // ignore malformed meta
  }
  return {};
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-review-mark", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { reviewed?: unknown; note?: unknown }
    | null;
  const reviewed = Boolean(body?.reviewed);
  const note = String(body?.note || "").trim().slice(0, 600);
  const isAdmin = user?.role === "ADMIN";
  if (!reviewed && note.length < 8) {
    return NextResponse.json(
      { error: "Clear reason is required (minimum 8 characters)." },
      { status: 400 },
    );
  }

  const row = await prisma.auditLog.findUnique({
    where: { id },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      meta: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Audit row not found." }, { status: 404 });

  const prev = parseMeta(row.meta);
  const { settings } = await getEffectiveAuditRiskSettings();
  const risk = evaluateAuditRisk({
    action: row.action,
    entityType: row.entityType,
    meta: prev,
    settings,
  });
  const previouslyReviewed = Boolean(String(prev.reviewedAt || "").trim());
  if (!reviewed && !isAdmin) {
    if (risk.severity === "CRITICAL" && previouslyReviewed) {
      const next: Meta = { ...prev };
      const requestedAt = new Date().toISOString();
      next.reviewClearRequestStatus = "PENDING_APPROVAL";
      next.reviewClearRequestedAt = requestedAt;
      next.reviewClearRequestedById = user?.id || null;
      next.reviewClearRequestedByName = user?.name || null;
      next.reviewClearRequestedByEmail = user?.email || null;
      next.reviewClearRequestNote = note || null;
      await prisma.auditLog.update({
        where: { id },
        data: { meta: JSON.stringify(next) },
      });
      await recordAuditLog({
        actorId: user?.id || null,
        action: "AUDIT_REVIEW_CLEAR_REQUESTED",
        entityType: "AUDIT_LOG",
        entityId: id,
        meta: {
          targetAuditLogId: row.id,
          targetAction: row.action,
          targetEntityType: row.entityType,
          targetEntityId: row.entityId,
          targetCreatedAt: row.createdAt.toISOString(),
          requestedAt,
          note: note || null,
        },
      });
      return NextResponse.json({ ok: true, pendingApproval: true });
    }
    return NextResponse.json(
      { error: "Only ADMIN can clear a review mark." },
      { status: 403 },
    );
  }
  if (reviewed && requiresReviewTask({ action: row.action, entityType: row.entityType, meta: prev, settings })) {
    const taskError = getMissingTaskRequirement(prev);
    if (taskError) {
      return NextResponse.json({ error: taskError }, { status: 400 });
    }
  }
  const previousReviewedAt = String(prev.reviewedAt || "").trim() || null;
  const previousReviewedByName = String(prev.reviewedByName || "").trim() || null;
  const previousReviewNote = String(prev.reviewNote || "").trim() || null;
  const next: Meta = { ...prev };
  const appliedAt = new Date().toISOString();
  if (reviewed) {
    next.reviewedAt = appliedAt;
    next.reviewedById = user?.id || null;
    next.reviewedByName = user?.name || null;
    next.reviewedByEmail = user?.email || null;
    next.reviewNote = note || null;
  } else {
    delete next.reviewedAt;
    delete next.reviewedById;
    delete next.reviewedByName;
    delete next.reviewedByEmail;
    delete next.reviewNote;
  }

  await prisma.auditLog.update({
    where: { id },
    data: { meta: JSON.stringify(next) },
  });

  await recordAuditLog({
    actorId: user?.id || null,
    action: reviewed ? "AUDIT_REVIEW_MARKED" : "AUDIT_REVIEW_CLEARED",
    entityType: "AUDIT_LOG",
    entityId: id,
    meta: {
      reviewStatusFrom: previouslyReviewed ? "REVIEWED" : "NOT_REVIEWED",
      reviewStatusTo: reviewed ? "REVIEWED" : "NOT_REVIEWED",
      targetAuditLogId: row.id,
      targetAction: row.action,
      targetEntityType: row.entityType,
      targetEntityId: row.entityId,
      targetCreatedAt: row.createdAt.toISOString(),
      previousReviewedAt,
      previousReviewedByName,
      previousReviewNote,
      appliedReviewedAt: reviewed ? appliedAt : null,
      appliedReviewedByName: reviewed ? user?.name || null : null,
      note: note || null,
    },
  });

  return NextResponse.json({ ok: true });
}
