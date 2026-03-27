import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const adjustmentSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function buildAuditActor(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name || null,
    email: user.email || null,
    role: user.role,
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payroll run id is required" }, { status: 400 });
  }
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = adjustmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const note = (parsed.data.note || "").trim();
  if (note.length > 0 && note.length < 8) {
    return NextResponse.json(
      { error: "Adjustment note should be at least 8 characters when provided." },
      { status: 400 },
    );
  }

  const existing = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.runType !== "REGULAR") {
    return NextResponse.json({ error: "Adjustments can only be created from regular runs." }, { status: 400 });
  }
  if (existing.status !== "FINALIZED" && existing.status !== "PAID") {
    return NextResponse.json({ error: "Only FINALIZED or PAID runs can be adjusted." }, { status: 400 });
  }

  const existingDraft = await prisma.payrollRun.findFirst({
    where: {
      adjustmentForId: existing.id,
      runType: "ADJUSTMENT",
      status: "DRAFT",
    },
    select: { id: true },
  });
  if (existingDraft) {
    return NextResponse.json(
      { error: "A draft adjustment run already exists for this payroll." },
      { status: 409 }
    );
  }

  const adjustment = await prisma.payrollRun.create({
    data: {
      periodStart: existing.periodStart,
      periodEnd: existing.periodEnd,
      status: "DRAFT",
      runType: "ADJUSTMENT",
      adjustmentForId: existing.id,
      adjustmentNote: note || null,
      totalGross: 0,
      totalNet: 0,
    },
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYROLL_ADJUSTMENT_CREATED",
      entityType: "PAYROLL_RUN",
      entityId: adjustment.id,
      meta: {
        actor: buildAuditActor(user),
        sourcePage: "admin/hr/payroll/[id]",
        section: "run-adjustments",
        operation: "create_adjustment_run",
        payrollRunId: existing.id,
        before: {
          payrollRunId: existing.id,
          runType: existing.runType,
          status: existing.status,
          periodStart: existing.periodStart.toISOString(),
          periodEnd: existing.periodEnd.toISOString(),
        },
        after: {
          payrollRunId: adjustment.id,
          runType: adjustment.runType,
          status: adjustment.status,
          periodStart: adjustment.periodStart.toISOString(),
          periodEnd: adjustment.periodEnd.toISOString(),
          adjustmentForId: existing.id,
          note: adjustment.adjustmentNote || null,
        },
        status: "SUCCESS",
        resultSummary: "Payroll adjustment run created successfully.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(adjustment);
}
