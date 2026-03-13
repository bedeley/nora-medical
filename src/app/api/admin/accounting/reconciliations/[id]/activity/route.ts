import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const getReconciliationId = (req: Request) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 2] || "";
};

const postPayloadSchema = z.object({
  event: z.enum(["auto_match_run", "undo_auto_batch"]),
  mode: z.enum(["exact", "tolerance", "rules"]).optional(),
  matchedCount: z.number().int().min(0).optional(),
  attemptedCount: z.number().int().min(0).optional(),
  revertedCount: z.number().int().min(0).optional(),
});

type ParsedMeta = Record<string, unknown> & {
  source?: string;
  matchStatus?: string;
  forceReason?: string;
};

function parseMeta(meta: string | null): ParsedMeta {
  if (!meta) return {};
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

function formatActionText(action: string, meta: ParsedMeta) {
  if (action === "reconciliation.workspace.open") return "Workspace opened.";
  if (action === "reconciliation.close") return "Reconciliation closed.";
  if (action === "reconciliation.force_close") {
    const reason = typeof meta.forceReason === "string" ? meta.forceReason.trim() : "";
    return reason ? `Reconciliation force-closed (${reason}).` : "Reconciliation force-closed.";
  }
  if (action === "reconciliation.auto_match_run") {
    const mode = String(meta.mode || "exact");
    const matched = Number(meta.matchedCount || 0);
    const attempted = Number(meta.attemptedCount || 0);
    return `Auto-match ${mode} run (${matched}/${attempted}).`;
  }
  if (action === "reconciliation.undo_auto_batch") {
    const reverted = Number(meta.revertedCount || 0);
    return `Undo auto-match batch (${reverted} reverted).`;
  }
  if (action === "reconciliation.match") {
    const source = String(meta.source || "manual");
    const status = String(meta.matchStatus || "");
    if (source === "undo_auto" || status === "UNMATCHED") return "Auto-match undo row reverted.";
    if (source === "auto_exact") return "Auto-match exact row saved.";
    if (source === "auto_tolerance") return "Auto-match tolerance row saved.";
    if (source === "auto_rules") return "Auto-match rules row saved.";
    return "Manual match saved.";
  }
  return action;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const recId = getReconciliationId(req);
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: "Reconciliation",
      entityId: recId,
      deletedAt: null,
      action: {
        in: [
          "reconciliation.workspace.open",
          "reconciliation.match",
          "reconciliation.close",
          "reconciliation.force_close",
          "reconciliation.auto_match_run",
          "reconciliation.undo_auto_batch",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      actor: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json(
    rows.map((row) => {
      const meta = parseMeta(row.meta || null);
      return {
        id: row.id,
        at: row.createdAt,
        action: row.action,
        text: formatActionText(row.action, meta),
        actor: row.actor?.name || row.actor?.email || "Unknown",
      };
    }),
  );
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const recId = getReconciliationId(req);
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = postPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid activity payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.event === "auto_match_run") {
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "reconciliation.auto_match_run",
      entityType: "Reconciliation",
      entityId: recId,
      meta: {
        mode: parsed.data.mode || "exact",
        matchedCount: parsed.data.matchedCount || 0,
        attemptedCount: parsed.data.attemptedCount || 0,
      },
    });
  } else {
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "reconciliation.undo_auto_batch",
      entityType: "Reconciliation",
      entityId: recId,
      meta: {
        revertedCount: parsed.data.revertedCount || 0,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

