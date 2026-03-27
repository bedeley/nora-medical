import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  expectedUpdatedAt: z.string().optional(),
  sourcePage: z.string().min(1).optional(),
  section: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  resultSummary: z.string().min(1).optional(),
});

function defaultSectionForKey(key: string) {
  if (key === "hr.workweekDays") return "leave-policy";
  if (key === "hr.reviewCadence") return "review-policy";
  if (key === "hr.payroll.ghana.ssnitEmployeeRate") return "payroll-policy";
  if (key === "hr.payroll.ghana.payeBands") return "payroll-policy";
  if (key === "hr.payroll.ghana.autoStatutoryCalc") return "payroll-policy";
  if (key === "hr.payroll.ghana.enablePaye") return "payroll-policy";
  if (key === "hr.payroll.ghana.enableSsnitEmployee") return "payroll-policy";
  if (key === "hr.payroll.ghana.enableSsnitEmployer") return "payroll-policy";
  if (key === "hr.payroll.ghana.ssnitEmployerRate") return "payroll-policy";
  if (key === "hr.payroll.ghana.taxableAllowancePercent") return "payroll-policy";
  if (key === "hr.payroll.remittance.requireReference") return "payroll-policy";
  return "settings";
}

function defaultOperationForKey(key: string) {
  if (key === "hr.workweekDays") return "update_workweek_days";
  if (key === "hr.reviewCadence") return "update_review_cadence";
  if (key === "hr.payroll.ghana.ssnitEmployeeRate") return "update_ghana_ssnit_rate";
  if (key === "hr.payroll.ghana.payeBands") return "update_ghana_paye_bands";
  if (key === "hr.payroll.ghana.autoStatutoryCalc") return "update_ghana_auto_calculation_toggle";
  if (key === "hr.payroll.ghana.enablePaye") return "update_ghana_enable_paye";
  if (key === "hr.payroll.ghana.enableSsnitEmployee") return "update_ghana_enable_ssnit_employee";
  if (key === "hr.payroll.ghana.enableSsnitEmployer") return "update_ghana_enable_ssnit_employer";
  if (key === "hr.payroll.ghana.ssnitEmployerRate") return "update_ghana_employer_ssnit_rate";
  if (key === "hr.payroll.ghana.taxableAllowancePercent") return "update_ghana_taxable_allowance_percent";
  if (key === "hr.payroll.remittance.requireReference") return "update_remittance_reference_requirement";
  return "update_hr_setting";
}

function defaultResultSummaryForKey(key: string) {
  if (key === "hr.workweekDays") return "HR workweek days setting updated successfully.";
  if (key === "hr.reviewCadence") return "HR review cadence updated successfully.";
  if (key === "hr.payroll.ghana.ssnitEmployeeRate") return "Ghana SSNIT employee rate updated successfully.";
  if (key === "hr.payroll.ghana.payeBands") return "Ghana PAYE tax bands updated successfully.";
  if (key === "hr.payroll.ghana.autoStatutoryCalc") return "Ghana payroll auto calculation setting updated successfully.";
  if (key === "hr.payroll.ghana.enablePaye") return "Ghana PAYE enabled setting updated successfully.";
  if (key === "hr.payroll.ghana.enableSsnitEmployee")
    return "Ghana SSNIT employee deduction enabled setting updated successfully.";
  if (key === "hr.payroll.ghana.enableSsnitEmployer")
    return "Ghana SSNIT employer contribution enabled setting updated successfully.";
  if (key === "hr.payroll.ghana.ssnitEmployerRate") return "Ghana SSNIT employer rate updated successfully.";
  if (key === "hr.payroll.ghana.taxableAllowancePercent") return "Ghana taxable allowance percent updated successfully.";
  if (key === "hr.payroll.remittance.requireReference")
    return "Payroll remittance reference requirement updated successfully.";
  return "HR setting updated successfully.";
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const keysParam = searchParams.get("keys")?.trim() || "";
  const keys = keysParam
    ? keysParam.split(",").map((key) => key.trim()).filter(Boolean)
    : [];

  const rows = keys.length
    ? await prisma.siteSetting.findMany({ where: { key: { in: keys } } })
    : await prisma.siteSetting.findMany();

  const values: Record<string, unknown> = {};
  const meta: Record<string, { createdAt: string; updatedAt: string }> = {};
  rows.forEach((row) => {
    values[row.key] = row.value;
    meta[row.key] = {
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return NextResponse.json({ values, meta });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const value = parsed.data.value as Prisma.InputJsonValue;
  const previous = await prisma.siteSetting.findUnique({
    where: { key: parsed.data.key },
    select: { value: true, updatedAt: true },
  });

  if (parsed.data.expectedUpdatedAt && previous?.updatedAt) {
    const expectedTime = new Date(parsed.data.expectedUpdatedAt).getTime();
    const currentTime = previous.updatedAt.getTime();
    if (Number.isFinite(expectedTime) && expectedTime !== currentTime) {
      return NextResponse.json(
        {
          error: "This setting was updated by another user. Refresh and try again.",
          code: "HR_SETTINGS_CONFLICT",
          currentUpdatedAt: previous.updatedAt.toISOString(),
        },
        { status: 409 },
      );
    }
  }
  const setting = await prisma.siteSetting.upsert({
    where: { key: parsed.data.key },
    update: { value },
    create: { key: parsed.data.key, value },
  });

  const previousValue = previous?.value ?? null;
  const nextValue = setting.value ?? null;
  const unchanged = JSON.stringify(previousValue) === JSON.stringify(nextValue);
  if (unchanged) {
    return NextResponse.json({
      ...setting,
      unchanged: true,
      resultSummary: "No setting change detected.",
    });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_SETTING_UPDATE",
      entityType: "APPSETTING",
      entityId: setting.key,
      meta: {
        actor: {
          id: user.id,
          role: user.role,
        },
        sourcePage: parsed.data.sourcePage || "admin/hr/settings",
        section: parsed.data.section || defaultSectionForKey(parsed.data.key),
        operation: parsed.data.operation || defaultOperationForKey(parsed.data.key),
        before: {
          key: parsed.data.key,
          value: previous?.value ?? null,
        },
        after: {
          key: setting.key,
          value: setting.value,
        },
        status: "SUCCESS",
        resultSummary: parsed.data.resultSummary || defaultResultSummaryForKey(parsed.data.key),
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(setting);
}
