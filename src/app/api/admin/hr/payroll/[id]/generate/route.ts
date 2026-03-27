import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { getGhanaStatutoryConfigFromSettings } from "@/lib/hr-ghana-statutory";

const generateSchema = z.object({
  bonus: z.number().optional(),
  autoCalculation: z.boolean().optional(),
  taxMode: z.enum(["percent", "amount"]).optional(),
  taxValue: z.number().min(0).optional(),
  ssnitMode: z.enum(["percent", "amount"]).optional(),
  ssnitValue: z.number().min(0).optional(),
  previewOnly: z.boolean().optional(),
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

function parseOptionalNumber(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number(trimmed);
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
  const parsed = generateSchema.safeParse({
    ...body,
    bonus: parseOptionalNumber(body.bonus),
    autoCalculation: typeof body.autoCalculation === "boolean" ? body.autoCalculation : undefined,
    taxMode: body.taxMode,
    taxValue: parseOptionalNumber(body.taxValue),
    ssnitMode: body.ssnitMode,
    ssnitValue: parseOptionalNumber(body.ssnitValue),
    previewOnly: typeof body.previewOnly === "boolean" ? body.previewOnly : undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const bonus = parsed.data.bonus ?? 0;
  const ghanaConfig = await getGhanaStatutoryConfigFromSettings();
  const previewOnly = parsed.data.previewOnly ?? false;
  if (!ghanaConfig.autoStatutoryCalc && parsed.data.autoCalculation === true) {
    return NextResponse.json(
      {
        error:
          "Automatic Ghana statutory calculation is off in HR Settings. Use manual tax and SSNIT inputs or turn it on in HR Settings.",
      },
      { status: 400 },
    );
  }
  const autoCalculation = ghanaConfig.autoStatutoryCalc
    ? (parsed.data.autoCalculation ?? true)
    : false;
  const manual =
    autoCalculation
      ? undefined
      : {
          taxMode: parsed.data.taxMode ?? "percent",
          taxValue: parsed.data.taxValue ?? 0,
          ssnitMode: parsed.data.ssnitMode ?? "percent",
          ssnitValue: parsed.data.ssnitValue ?? ghanaConfig.ssnitEmployeeRate,
        };

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    select: {
      runType: true,
      status: true,
      _count: {
        select: { payslips: true },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Payroll run not found." }, { status: 404 });
  if (run.runType === "ADJUSTMENT") {
    return NextResponse.json(
      { error: "Adjustment runs require manual payslips." },
      { status: 400 }
    );
  }

  const result = await generatePayslipsForRun({
    payrollRunId: resolvedParams.id,
    taxPercent: 0,
    pensionPercent: 0,
    bonus,
    statutory: {
      mode: "ghana",
      enablePaye: ghanaConfig.enablePaye,
      enableSsnitEmployee: ghanaConfig.enableSsnitEmployee,
      enableSsnitEmployer: ghanaConfig.enableSsnitEmployer,
      ssnitEmployeeRate: ghanaConfig.ssnitEmployeeRate,
      ssnitEmployerRate: ghanaConfig.ssnitEmployerRate,
      taxableAllowancePercent: ghanaConfig.taxableAllowancePercent,
      payeBands: ghanaConfig.payeBands,
      manual,
    },
    previewOnly,
  });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (previewOnly) {
    return NextResponse.json({ ...result, previewOnly: true });
  }
  try {
    const payslipCountBefore = Number(run._count?.payslips || 0);
    const payslipCountAfter = payslipCountBefore + Number(result.created || 0);
    await recordAuditLog({
      actorId: user.id,
      action: "PAYROLL_GENERATE",
      entityType: "PAYROLL_RUN",
      entityId: resolvedParams.id,
      meta: {
        actor: buildAuditActor(user),
        sourcePage: "admin/hr/payroll/[id]",
        section: "run-generation",
        operation: "generate_payslips",
        payrollRunId: resolvedParams.id,
        created: result.created,
        updated: result.updated ?? 0,
        skipped: result.skipped,
        bonus,
        before: {
          status: run.status,
          runType: run.runType,
          payslipCount: payslipCountBefore,
        },
        after: {
          status: run.status,
          runType: run.runType,
          payslipCount: payslipCountAfter,
          created: result.created,
          updated: result.updated ?? 0,
          skipped: result.skipped,
          bonus,
        },
        statutory: {
          mode: "ghana",
          autoCalculation,
          manualMode: !autoCalculation,
          collectPaye: ghanaConfig.enablePaye,
          collectSsnitEmployee: ghanaConfig.enableSsnitEmployee,
          trackSsnitEmployer: ghanaConfig.enableSsnitEmployer,
        },
        status: "SUCCESS",
        resultSummary: `Generated ${result.created} payslip(s), updated ${result.updated ?? 0}, skipped ${result.skipped}.`,
      },
    });
  } catch {
    // best-effort
  }
  return NextResponse.json(result);
}
