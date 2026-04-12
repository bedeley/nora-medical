import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { getMissingTaskRequirement, requiresReviewTask } from "@/lib/audit-review-policy";
import { getEffectiveAuditRiskSettings } from "@/lib/audit-risk-settings.server";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

type Meta = Record<string, unknown>;

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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-review-bulk", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { ids?: unknown; reviewed?: unknown; note?: unknown }
    | null;
  const reviewed = Boolean(body?.reviewed);
  const note = String(body?.note || "").trim().slice(0, 600);
  const isAdmin = user?.role === "ADMIN";
  if (!reviewed && !isAdmin) {
    return NextResponse.json(
      { error: "Only ADMIN can clear review marks." },
      { status: 403 },
    );
  }
  if (!reviewed && note.length < 8) {
    return NextResponse.json(
      { error: "Clear reason is required (minimum 8 characters)." },
      { status: 400 },
    );
  }
  const idsInput = Array.isArray(body?.ids) ? body?.ids : [];
  const ids = [...new Set(idsInput.map((value) => String(value || "").trim()).filter(Boolean))];

  if (ids.length === 0) {
    return NextResponse.json({ error: "Select at least one row." }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: "You can update up to 200 rows at once." }, { status: 400 });
  }

  const rows = await prisma.auditLog.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      meta: true,
    },
  });
  if (!rows.length) {
    return NextResponse.json({ error: "No matching audit rows found." }, { status: 404 });
  }
  if (reviewed) {
    const { settings } = await getEffectiveAuditRiskSettings();
    const blocking = rows.find((row) => {
      const meta = parseMeta(row.meta);
      if (!requiresReviewTask({ action: row.action, entityType: row.entityType, meta, settings })) return false;
      return Boolean(getMissingTaskRequirement(meta));
    });
    if (blocking) {
      const meta = parseMeta(blocking.meta);
      return NextResponse.json(
        {
          error: `${getMissingTaskRequirement(meta)} (blocked row: ${blocking.action} ${blocking.entityType} ${blocking.entityId})`,
        },
        { status: 400 },
      );
    }
  }

  const nowIso = new Date().toISOString();
  let fromReviewedCount = 0;
  let fromNotReviewedCount = 0;
  await prisma.$transaction(
    rows.map((row) => {
      const prev = parseMeta(row.meta);
      const previouslyReviewed = Boolean(String(prev.reviewedAt || "").trim());
      if (previouslyReviewed) fromReviewedCount += 1;
      else fromNotReviewedCount += 1;
      const next: Meta = { ...prev };
      if (reviewed) {
        next.reviewedAt = nowIso;
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
      return prisma.auditLog.update({
        where: { id: row.id },
        data: { meta: JSON.stringify(next) },
      });
    }),
  );

  await recordAuditLog({
    actorId: user?.id || null,
    action: reviewed ? "AUDIT_REVIEW_BULK_MARKED" : "AUDIT_REVIEW_BULK_CLEARED",
    entityType: "AUDIT_LOG",
    entityId: "bulk",
    meta: {
      count: rows.length,
      reviewStatusFrom: {
        reviewed: fromReviewedCount,
        notReviewed: fromNotReviewedCount,
      },
      reviewStatusTo: reviewed ? "REVIEWED" : "NOT_REVIEWED",
      appliedReviewedAt: reviewed ? nowIso : null,
      appliedReviewedByName: reviewed ? user?.name || null : null,
      note: note || null,
      targetIds: rows.slice(0, 25).map((row) => row.id),
      sampleTargets: rows.slice(0, 10).map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
      })),
    },
  });

  return NextResponse.json({ ok: true, updated: rows.length });
}
