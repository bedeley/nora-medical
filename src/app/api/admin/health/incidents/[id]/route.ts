import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { IssueStatus } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";

type RouteCtx = {
  params: Promise<{ id: string }>;
};

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user || user.role !== "ADMIN") return null;
  return user;
}

function incidentStatusLabel(status: IssueStatus) {
  return String(status).replace(/_/g, " ").toLowerCase();
}

function isReopenTransition(from: IssueStatus, to: IssueStatus) {
  return (from === "RESOLVED" || from === "CLOSED") && (to === "OPEN" || to === "IN_PROGRESS");
}

function serializeIncident(
  next: {
    id: string;
    fingerprint: string;
    issueCount: number;
    issueSummary: string;
    isManual: boolean;
    status: IssueStatus;
    ownerId: string | null;
    ownerName: string | null;
    followUpDueAt: Date | null;
    openedAt: Date;
    resolvedAt: Date | null;
    closedAt: Date | null;
    openedBy?: { name: string | null; email: string | null } | null;
    resolvedBy?: { name: string | null; email: string | null } | null;
    notes: Array<{ id: string; note: string; createdAt: Date; createdByName: string }>;
  },
) {
  return {
    id: next.id,
    fingerprint: next.fingerprint,
    issueCount: next.issueCount,
    issueSummary: next.issueSummary,
    isManual: next.isManual,
    status: next.status,
    ownerId: next.ownerId,
    ownerName: next.ownerName,
    followUpDueAt: next.followUpDueAt ? next.followUpDueAt.toISOString() : null,
    openedAt: next.openedAt.toISOString(),
    resolvedAt: next.resolvedAt ? next.resolvedAt.toISOString() : null,
    closedAt: next.closedAt ? next.closedAt.toISOString() : null,
    openedByName: next.openedBy?.name || next.openedBy?.email || null,
    resolvedByName: next.resolvedBy?.name || next.resolvedBy?.email || null,
    notes: next.notes.map((row) => ({
      id: row.id,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdByName,
    })),
  };
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const requestedStatus = String(body?.status || "OPEN").toUpperCase();
  const status = (
    requestedStatus === "IN_PROGRESS" || requestedStatus === "RESOLVED" || requestedStatus === "CLOSED"
      ? requestedStatus
      : "OPEN"
  ) as IssueStatus;
  const ownerIdRaw = String(body?.ownerId || "").trim();
  const ownerId = ownerIdRaw || null;
  const note = String(body?.note || "").trim();
  if (note && note.length < 8) {
    return NextResponse.json({ error: "Workflow note must be at least 8 characters." }, { status: 400 });
  }
  const dueAtRaw = String(body?.followUpDueAt || "").trim();
  let followUpDueAt: Date | null = null;
  if (dueAtRaw) {
    const due = new Date(dueAtRaw);
    if (Number.isNaN(due.getTime())) {
      return NextResponse.json({ error: "Invalid follow-up due date." }, { status: 400 });
    }
    followUpDueAt = due;
  }

  const existing = await prisma.healthIncident.findUnique({
    where: { id },
    include: { owner: { select: { id: true, name: true, email: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Incident not found." }, { status: 404 });

  const reopenRequested = Boolean(body?.reopen);
  const reopening = isReopenTransition(existing.status, status);
  if (existing.status === "CLOSED" && !reopenRequested) {
    return NextResponse.json(
      { error: "Closed incidents cannot be edited from normal workflow. Use Reopen closed incident." },
      { status: 400 },
    );
  }
  if (existing.status === "CLOSED" && reopenRequested && !reopening) {
    return NextResponse.json({ error: "Closed incidents can only be reopened to Open or In progress." }, { status: 400 });
  }
  if (reopening && note.length < 8) {
    return NextResponse.json(
      { error: "Reopen reason is required (minimum 8 characters)." },
      { status: 400 },
    );
  }

  let ownerName: string | null = null;
  let ownerEmail: string | null = null;
  if (ownerId) {
    const owner = await prisma.user.findFirst({
      where: { id: ownerId, role: "ADMIN", deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (!owner) return NextResponse.json({ error: "Selected owner is invalid." }, { status: 400 });
    ownerName = owner.name || owner.email || "Admin";
    ownerEmail = owner.email || null;
  }

  const now = new Date();
  const shouldResolve = status === "RESOLVED";
  const shouldClose = status === "CLOSED";
  const next = await prisma.healthIncident.update({
    where: { id },
    data: {
      status,
      ownerId,
      ownerName,
      followUpDueAt,
      statusUpdatedAt: now,
      statusUpdatedById: user.id,
      statusUpdatedByName: user.name || user.email || "Admin",
      resolvedAt: shouldResolve ? (existing.resolvedAt || now) : null,
      resolvedById: shouldResolve ? user.id : null,
      closedAt: shouldClose ? now : null,
    },
    include: {
      openedBy: { select: { name: true, email: true } },
      resolvedBy: { select: { name: true, email: true } },
      notes: {
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, note: true, createdAt: true, createdByName: true },
      },
    },
  });

  if (note) {
    await prisma.healthIncidentNote.create({
      data: {
        incidentId: next.id,
        note,
        createdById: user.id,
        createdByName: user.name || user.email || "Admin",
      },
    });
  }

  const ownerChanged = existing.ownerId !== next.ownerId;
  if (ownerChanged && ownerEmail) {
    const subject = `Health incident assigned: ${next.id}`;
    const text = [
      `You have been assigned to a health incident.`,
      `Incident ID: ${next.id}`,
      `Status: ${String(next.status).replace(/_/g, " ")}`,
      `Summary: ${next.issueSummary}`,
      `Due: ${next.followUpDueAt ? next.followUpDueAt.toLocaleString() : "Not set"}`,
      `Assigned by: ${user.name || user.email || "Admin"}`,
      `Open: /admin/health/incidents/${next.id}`,
    ].join("\n");
    const emailResult = await sendEmail(ownerEmail, subject, text);
    await recordAuditLog({
      actorId: user.id,
      action: "HEALTH_INCIDENT_OWNER_NOTIFIED",
      entityType: "HEALTH_ALERT",
      entityId: next.id,
      meta: {
        initiatedByName: user.name || user.email || "Admin",
        initiatedByEmail: user.email || null,
        incidentId: next.id,
        ownerBefore: existing.ownerName || "Unassigned",
        ownerAfter: next.ownerName || "Unassigned",
        recipient: ownerEmail,
        notificationResult: emailResult.ok ? "sent" : "failed",
        notificationError: emailResult.ok ? null : emailResult.error || "Unknown error",
      },
    });
  }

  await recordAuditLog({
    actorId: user.id,
    action: reopening ? "HEALTH_INCIDENT_REOPENED" : "HEALTH_INCIDENT_WORKFLOW_UPDATED",
    entityType: "HEALTH_ALERT",
    entityId: next.id,
    meta: {
      initiatedByName: user.name || user.email || "Admin",
      initiatedByEmail: user.email || null,
      initiatedByRole: user.role,
      incidentId: next.id,
      incidentFingerprint: next.fingerprint,
      statusBefore: incidentStatusLabel(existing.status),
      statusAfter: incidentStatusLabel(next.status),
      ownerBefore: existing.owner?.name || existing.owner?.email || existing.ownerName || "Unassigned",
      ownerAfter: next.ownerName || "Unassigned",
      followUpDueBefore: existing.followUpDueAt ? existing.followUpDueAt.toISOString() : null,
      followUpDueAfter: next.followUpDueAt ? next.followUpDueAt.toISOString() : null,
      reopened: reopening,
      reopenRequested,
      workflowNote: note || null,
      result: reopening ? "Incident reopened." : "Incident workflow updated.",
    },
  });

  return NextResponse.json({
    ok: true,
    incident: serializeIncident(next),
  });
}

export async function POST(req: Request, ctx: RouteCtx) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "add_note").toLowerCase();
  const incident = await prisma.healthIncident.findUnique({
    where: { id },
    include: {
      openedBy: { select: { name: true, email: true } },
      resolvedBy: { select: { name: true, email: true } },
      notes: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, note: true, createdAt: true, createdByName: true } },
    },
  });
  if (!incident) return NextResponse.json({ error: "Incident not found." }, { status: 404 });

  if (action === "mark_false_positive") {
    const reason = String(body?.reason || "").trim();
    if (reason.length < 8) {
      return NextResponse.json({ error: "False positive reason must be at least 8 characters." }, { status: 400 });
    }
    const now = new Date();
    const updated = await prisma.healthIncident.update({
      where: { id: incident.id },
      data: {
        status: "CLOSED",
        closedAt: now,
        resolvedAt: incident.resolvedAt || now,
        resolvedById: user.id,
        statusUpdatedAt: now,
        statusUpdatedById: user.id,
        statusUpdatedByName: user.name || user.email || "Admin",
      },
      include: {
        openedBy: { select: { name: true, email: true } },
        resolvedBy: { select: { name: true, email: true } },
        notes: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, note: true, createdAt: true, createdByName: true } },
      },
    });
    await prisma.healthIncidentNote.create({
      data: {
        incidentId: incident.id,
        note: `Marked false positive: ${reason}`,
        createdById: user.id,
        createdByName: user.name || user.email || "Admin",
      },
    });
    await recordAuditLog({
      actorId: user.id,
      action: "HEALTH_INCIDENT_FALSE_POSITIVE",
      entityType: "HEALTH_ALERT",
      entityId: incident.id,
      meta: {
        initiatedByName: user.name || user.email || "Admin",
        incidentId: incident.id,
        incidentFingerprint: incident.fingerprint,
        reason,
        result: "Incident marked as false positive and closed.",
      },
    });
    return NextResponse.json({ ok: true, incident: serializeIncident(updated) });
  }

  if (action === "split") {
    const summary = String(body?.summary || "").trim();
    if (summary.length < 8) {
      return NextResponse.json({ error: "Split summary must be at least 8 characters." }, { status: 400 });
    }
    const newIncident = await prisma.healthIncident.create({
      data: {
        fingerprint: `${incident.fingerprint}:split:${Date.now()}`,
        isManual: true,
        issueCount: 0,
        issueSummary: summary,
        status: "OPEN",
        openedById: user.id,
        ownerId: incident.ownerId,
        ownerName: incident.ownerName,
        followUpDueAt: incident.followUpDueAt,
      },
      include: {
        openedBy: { select: { name: true, email: true } },
        resolvedBy: { select: { name: true, email: true } },
        notes: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, note: true, createdAt: true, createdByName: true } },
      },
    });
    await Promise.all([
      prisma.healthIncidentNote.create({
        data: {
          incidentId: incident.id,
          note: `Split created: ${newIncident.id} (${summary})`,
          createdById: user.id,
          createdByName: user.name || user.email || "Admin",
        },
      }),
      recordAuditLog({
        actorId: user.id,
        action: "HEALTH_INCIDENT_SPLIT",
        entityType: "HEALTH_ALERT",
        entityId: incident.id,
        meta: {
          initiatedByName: user.name || user.email || "Admin",
          incidentId: incident.id,
          newIncidentId: newIncident.id,
          splitSummary: summary,
          result: "Created follow-up split incident.",
        },
      }),
    ]);
    return NextResponse.json({
      ok: true,
      splitIncidentId: newIncident.id,
      splitIncidentLink: `/admin/health/incidents/${newIncident.id}`,
      incident: serializeIncident(incident),
    });
  }

  if (action === "merge_from") {
    const mergeFromId = String(body?.mergeFromId || "").trim();
    if (!mergeFromId || mergeFromId === incident.id) {
      return NextResponse.json({ error: "Enter a valid source incident ID to merge." }, { status: 400 });
    }
    const source = await prisma.healthIncident.findUnique({
      where: { id: mergeFromId },
      select: { id: true, issueSummary: true, status: true, ownerName: true },
    });
    if (!source) return NextResponse.json({ error: "Source incident not found." }, { status: 404 });
    const now = new Date();
    await prisma.$transaction([
      prisma.healthIncidentNote.create({
        data: {
          incidentId: incident.id,
          note: `Merged from ${source.id}: ${source.issueSummary}`,
          createdById: user.id,
          createdByName: user.name || user.email || "Admin",
        },
      }),
      prisma.healthIncident.update({
        where: { id: source.id },
        data: {
          status: "CLOSED",
          closedAt: now,
          statusUpdatedAt: now,
          statusUpdatedById: user.id,
          statusUpdatedByName: user.name || user.email || "Admin",
        },
      }),
    ]);
    await recordAuditLog({
      actorId: user.id,
      action: "HEALTH_INCIDENT_MERGED",
      entityType: "HEALTH_ALERT",
      entityId: incident.id,
      meta: {
        initiatedByName: user.name || user.email || "Admin",
        targetIncidentId: incident.id,
        sourceIncidentId: source.id,
        sourceStatusBefore: incidentStatusLabel(source.status),
        result: "Source incident merged and closed.",
      },
    });
    const refreshed = await prisma.healthIncident.findUnique({
      where: { id: incident.id },
      include: {
        openedBy: { select: { name: true, email: true } },
        resolvedBy: { select: { name: true, email: true } },
        notes: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, note: true, createdAt: true, createdByName: true } },
      },
    });
    if (!refreshed) return NextResponse.json({ error: "Incident not found after merge." }, { status: 404 });
    return NextResponse.json({ ok: true, incident: serializeIncident(refreshed) });
  }

  const note = String(body?.note || "").trim();
  if (note.length < 8) {
    return NextResponse.json({ error: "Incident note must be at least 8 characters." }, { status: 400 });
  }

  const created = await prisma.healthIncidentNote.create({
    data: {
      incidentId: incident.id,
      note,
      createdById: user.id,
      createdByName: user.name || user.email || "Admin",
    },
    select: { id: true, note: true, createdAt: true, createdByName: true },
  });

  await recordAuditLog({
    actorId: user.id,
    action: "HEALTH_INCIDENT_NOTE_ADDED",
    entityType: "HEALTH_ALERT",
    entityId: incident.id,
    meta: {
      initiatedByName: user.name || user.email || "Admin",
      initiatedByEmail: user.email || null,
      initiatedByRole: user.role,
      incidentId: incident.id,
      incidentFingerprint: incident.fingerprint,
      incidentStatus: incidentStatusLabel(incident.status),
      note,
      result: "Incident timeline note added.",
    },
  });

  return NextResponse.json({
    ok: true,
    note: {
      id: created.id,
      note: created.note,
      createdAt: created.createdAt.toISOString(),
      createdByName: created.createdByName,
    },
  });
}
