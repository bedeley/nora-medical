import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { normalizeFailureSimulationInput } from "@/lib/accounting-report-export-jobs";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const id = String(params.id || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Job id is required." }, { status: 400 });
  }
  const row = await prisma.siteSetting.findUnique({ where: { key: `report.export.job.${id}` } });
  if (!row) {
    return NextResponse.json({ error: "Export job not found or expired." }, { status: 404 });
  }
  const value = (row.value || {}) as Record<string, unknown>;
  const expiresAt = Number(value.expiresAt || 0);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await prisma.siteSetting.delete({ where: { key: `report.export.job.${id}` } }).catch(() => undefined);
    return NextResponse.json({ error: "Export job expired." }, { status: 404 });
  }

  let status = String(value.status || "QUEUED").toUpperCase();
  const downloadUrl = String(value.downloadUrl || "");
  let failReason = value.failReason ? String(value.failReason) : null;
  if (!downloadUrl && status !== "FAILED") {
    status = "FAILED";
    failReason = "Export file link is missing. Queue a new export job.";
  }
  if (status === "QUEUED") {
    status = "READY";
  } else if (status !== "READY" && status !== "FAILED") {
    status = "QUEUED";
  }
  await prisma.siteSetting.update({
    where: { key: `report.export.job.${id}` },
    data: {
      value: {
        ...(value as Record<string, unknown>),
        status,
        failReason,
      } as Prisma.InputJsonValue,
    },
  });

  return NextResponse.json({
    jobId: id,
    status,
    downloadUrl,
    expiresAt,
    failReason,
  });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Failure simulation is disabled in production." }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !actor || !isAdmin(actor)) {
    return NextResponse.json({ error: "Only admins can simulate export failures." }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const params = await context.params;
  const id = String(params.id || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Job id is required." }, { status: 400 });
  }
  const parsedInput = normalizeFailureSimulationInput(await req.json().catch(() => ({})));
  if (!parsedInput.ok) {
    return NextResponse.json({ error: parsedInput.error }, { status: 400 });
  }
  const row = await prisma.siteSetting.findUnique({ where: { key: `report.export.job.${id}` } });
  if (!row) {
    return NextResponse.json({ error: "Export job not found." }, { status: 404 });
  }
  const value = (row.value || {}) as Record<string, unknown>;
  const failReason = parsedInput.failReason;
  await prisma.siteSetting.update({
    where: { key: `report.export.job.${id}` },
    data: {
      value: {
        ...(value as Record<string, unknown>),
        status: "FAILED",
        failReason,
      } as Prisma.InputJsonValue,
    },
  });

  await recordAuditLog({
    actorId: actor.id,
    action: "report.export.job.simulate_failure",
    entityType: "AccountingReportExportJob",
    entityId: id,
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      failReason,
      actorRole: actor.role || null,
      actorEmail: actor.email || null,
      environment: process.env.NODE_ENV || "unknown",
    },
  });

  return NextResponse.json({ ok: true, jobId: id, status: "FAILED", failReason });
}
