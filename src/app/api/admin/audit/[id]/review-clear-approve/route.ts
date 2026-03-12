import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

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

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-review-clear-approve", 60_000, 80);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { approved?: unknown; note?: unknown }
    | null;
  const approved = Boolean(body?.approved);
  const note = String(body?.note || "").trim().slice(0, 600);
  const { id } = await ctx.params;

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
  const requestStatus = String(prev.reviewClearRequestStatus || "").trim().toUpperCase();
  if (requestStatus !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: "No pending clear request." }, { status: 400 });
  }

  const next: Meta = { ...prev };
  const approvedAt = new Date().toISOString();
  next.reviewClearApprovedAt = approvedAt;
  next.reviewClearApprovedById = user?.id || null;
  next.reviewClearApprovedByName = user?.name || null;
  next.reviewClearApprovedByEmail = user?.email || null;
  next.reviewClearApprovalNote = note || null;
  next.reviewClearRequestStatus = approved ? "APPROVED" : "REJECTED";

  if (approved) {
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
    action: approved ? "AUDIT_REVIEW_CLEAR_APPROVED" : "AUDIT_REVIEW_CLEAR_REJECTED",
    entityType: "AUDIT_LOG",
    entityId: id,
    meta: {
      targetAuditLogId: row.id,
      targetAction: row.action,
      targetEntityType: row.entityType,
      targetEntityId: row.entityId,
      targetCreatedAt: row.createdAt.toISOString(),
      requestedByName: String(prev.reviewClearRequestedByName || "") || null,
      requestedByEmail: String(prev.reviewClearRequestedByEmail || "") || null,
      requestedAt: String(prev.reviewClearRequestedAt || "") || null,
      approvalNote: note || null,
      approvedAt,
      approvedByName: user?.name || null,
    },
  });

  return NextResponse.json({ ok: true });
}
