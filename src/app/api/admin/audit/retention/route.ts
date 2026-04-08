import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { evaluateAuditRisk } from "@/lib/audit-risk";

function parseRetentionDays(value: string | undefined) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 365;
  return Math.max(30, Math.floor(raw));
}

export async function POST(req: Request) {
  const { verifyCronSecret } = await import("@/lib/cron-auth");
  const hasCronAccess = verifyCronSecret(req);

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasAdminAccess = !!session && user?.role === "ADMIN";

  if (!hasAdminAccess && !hasCronAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (hasAdminAccess && !hasCronAccess && !assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-retention", 60_000, 6);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const retentionDays = parseRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const body = (await req.json().catch(() => ({}))) as {
    overrideMediumUnreviewed?: unknown;
    overrideReason?: unknown;
  };
  const overrideMediumUnreviewed = Boolean(body?.overrideMediumUnreviewed);
  const overrideReason = String(body?.overrideReason || "").trim().slice(0, 300);

  const candidates = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, action: true, entityType: true, meta: true },
  });

  const blockedCriticalHigh: string[] = [];
  const blockedMedium: string[] = [];
  for (const row of candidates) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    const risk = evaluateAuditRisk({
      action: row.action,
      entityType: row.entityType,
      meta: parsed,
    });
    if (risk.severity === "LOW" || risk.reviewed) continue;
    if (risk.severity === "CRITICAL" || risk.severity === "HIGH") {
      blockedCriticalHigh.push(row.id);
    } else if (risk.severity === "MEDIUM") {
      blockedMedium.push(row.id);
    }
  }

  if (blockedCriticalHigh.length > 0) {
    try {
      await recordAuditLog({
        actorId: hasAdminAccess ? user?.id : null,
        action: "AUDIT_LOG_RETENTION_BLOCKED",
        entityType: "AUDIT_LOG",
        entityId: "purge",
        meta: {
          retentionDays,
          cutoff: cutoff.toISOString(),
          blockedCriticalHigh: blockedCriticalHigh.length,
          blockedMedium: blockedMedium.length,
          reason: "Unreviewed high/critical exceptions must be reviewed before retention purge.",
          triggeredBy: hasCronAccess ? "cron" : "admin",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(
      {
        error: "Retention blocked: review all unreviewed High/Critical exceptions first.",
        blocked: {
          criticalHigh: blockedCriticalHigh.length,
          medium: blockedMedium.length,
        },
      },
      { status: 409 },
    );
  }

  if (blockedMedium.length > 0 && (!overrideMediumUnreviewed || overrideReason.length < 8)) {
    return NextResponse.json(
      {
        error: "Retention needs override for unreviewed Medium-risk exceptions.",
        blocked: {
          criticalHigh: 0,
          medium: blockedMedium.length,
        },
        required: "Set overrideMediumUnreviewed=true and provide overrideReason (min 8 chars).",
      },
      { status: 409 },
    );
  }

  const excludedIds = new Set<string>();
  blockedCriticalHigh.forEach((id) => excludedIds.add(id));
  if (!overrideMediumUnreviewed) {
    blockedMedium.forEach((id) => excludedIds.add(id));
  }
  const result = await prisma.auditLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      ...(excludedIds.size > 0 ? { id: { notIn: [...excludedIds] } } : {}),
    },
  });

  try {
    await recordAuditLog({
      actorId: hasAdminAccess ? user?.id : null,
      action: "AUDIT_LOG_RETENTION",
      entityType: "AUDIT_LOG",
      entityId: "purge",
      meta: {
        retentionDays,
        deleted: result.count,
        cutoff: cutoff.toISOString(),
        triggeredBy: hasCronAccess ? "cron" : "admin",
        blockedCriticalHigh: blockedCriticalHigh.length,
        blockedMedium: blockedMedium.length,
        overrideMediumUnreviewed,
        overrideReason: overrideMediumUnreviewed ? overrideReason || null : null,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: true,
    deleted: result.count,
    retentionDays,
    cutoff: cutoff.toISOString(),
    blocked: {
      criticalHigh: blockedCriticalHigh.length,
      medium: blockedMedium.length,
    },
    overrideMediumUnreviewed,
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasAdminAccess = !!session && user?.role === "ADMIN";

  if (!hasAdminAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const retentionDays = parseRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { action: true, entityType: true, meta: true },
  });
  let blockedCriticalHigh = 0;
  let blockedMedium = 0;
  for (const row of candidates) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    const risk = evaluateAuditRisk({
      action: row.action,
      entityType: row.entityType,
      meta: parsed,
    });
    if (risk.severity === "LOW" || risk.reviewed) continue;
    if (risk.severity === "CRITICAL" || risk.severity === "HIGH") blockedCriticalHigh += 1;
    else if (risk.severity === "MEDIUM") blockedMedium += 1;
  }
  const eligibleCount = candidates.length;

  return NextResponse.json({
    retentionDays,
    cutoff: cutoff.toISOString(),
    eligibleCount,
    reviewGuard: {
      blockedCriticalHigh,
      blockedMedium,
      eligibleAfterGuard: Math.max(0, eligibleCount - blockedCriticalHigh - blockedMedium),
    },
  });
}
