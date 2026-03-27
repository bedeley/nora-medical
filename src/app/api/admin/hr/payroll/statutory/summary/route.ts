import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import {
  getMonthlyStatutoryEmployeeBreakdown,
  getHrPayrollRemittancePolicy,
  getMonthlyStatutorySummary,
  payrollMonthKey,
  recordRemittanceFiledSnapshot,
  saveMonthlyRemittanceState,
} from "@/lib/hr-payroll-remittance";
import {
  postPayrollStatutoryRemittanceEntry,
  postPayrollStatutoryRemittanceReversalEntry,
} from "@/lib/accounting-posting";

const querySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

const patchSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  kind: z.enum(["PAYE", "SSNIT"]),
  status: z.enum(["PENDING", "REMITTED"]),
  paymentMethod: z.enum(["BANK", "CASH"]).optional(),
  remittedAt: z.string().optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
  sourcePage: z.string().max(120).optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function parseQueryParams(url: string) {
  const { searchParams } = new URL(url);
  const payload = {
    year: Number(searchParams.get("year") || 0),
    month: Number(searchParams.get("month") || 0),
  };
  return querySchema.safeParse(payload);
}

async function toActorLabel(actorId: string | null | undefined) {
  if (!actorId) return null;
  const user = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, email: true },
  });
  if (!user) return actorId;
  const displayName = String(user.name || "").trim() || "Unknown user";
  const displayEmail = String(user.email || "").trim();
  return displayEmail ? `${displayName} (${displayEmail})` : displayName;
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = parseQueryParams(req.url);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query", details: parsed.error.flatten() }, { status: 400 });
  }

  const [summary, employeeBreakdown, remittancePolicy] = await Promise.all([
    getMonthlyStatutorySummary(parsed.data.year, parsed.data.month),
    getMonthlyStatutoryEmployeeBreakdown(parsed.data.year, parsed.data.month),
    getHrPayrollRemittancePolicy(),
  ]);
  const updatedByLabel = await toActorLabel(summary.remittance.updatedBy);
  return NextResponse.json({
    ...summary,
    employeeBreakdown,
    remittancePolicy,
    remittance: {
      ...summary.remittance,
      updatedByLabel,
    },
  });
}

export async function PATCH(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse({
    ...body,
    year: typeof body.year === "string" ? Number(body.year) : body.year,
    month: typeof body.month === "string" ? Number(body.month) : body.month,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const { year, month, kind, status } = parsed.data;
  const paymentMethod = parsed.data.paymentMethod;
  const [summaryBefore, breakdownBefore, remittancePolicy] = await Promise.all([
    getMonthlyStatutorySummary(year, month),
    getMonthlyStatutoryEmployeeBreakdown(year, month),
    getHrPayrollRemittancePolicy(),
  ]);
  if (
    status === "REMITTED" &&
    ((kind === "PAYE" && summaryBefore.remittance.payeStatus === "REMITTED") ||
      (kind === "SSNIT" && summaryBefore.remittance.ssnitStatus === "REMITTED"))
  ) {
    return NextResponse.json({ error: "Remittance is already marked as remitted." }, { status: 409 });
  }
  if (
    status === "PENDING" &&
    ((kind === "PAYE" && summaryBefore.remittance.payeStatus === "REMITTED") ||
      (kind === "SSNIT" && summaryBefore.remittance.ssnitStatus === "REMITTED"))
  ) {
    return NextResponse.json({ error: "Remitted status is locked and cannot be changed back to pending." }, { status: 409 });
  }
  if (status === "REMITTED" && !paymentMethod) {
    return NextResponse.json({ error: "Select payment method: bank or cash." }, { status: 400 });
  }
  if (status === "REMITTED" && remittancePolicy.requireReference && !String(parsed.data.reference || "").trim()) {
    return NextResponse.json({ error: "Payment reference is required by payroll remittance policy." }, { status: 400 });
  }
  if (status === "REMITTED" && summaryBefore.runCount <= 0) {
    return NextResponse.json(
      { error: "No finalized payroll runs found for this month. Finalize payroll before remittance." },
      { status: 409 },
    );
  }
  if (status === "REMITTED" && kind === "PAYE" && summaryBefore.payeTax <= 0) {
    return NextResponse.json({ error: "No PAYE amount is due for this month." }, { status: 400 });
  }
  if (
    status === "REMITTED" &&
    kind === "SSNIT" &&
    summaryBefore.ssnitEmployee + summaryBefore.ssnitEmployer <= 0
  ) {
    return NextResponse.json({ error: "No SSNIT amount is due for this month." }, { status: 400 });
  }
  const monthKey = payrollMonthKey(year, month);
  const nowIso = new Date().toISOString();
  const remittedAt = parsed.data.remittedAt ? new Date(parsed.data.remittedAt) : new Date();
  const remittedAtIso = Number.isNaN(remittedAt.getTime()) ? nowIso : remittedAt.toISOString();
  const notes = parsed.data.notes?.trim() || null;
  const reference = parsed.data.reference?.trim() || null;
  const nextRemittance =
    kind === "PAYE"
      ? await saveMonthlyRemittanceState(monthKey, {
          payeStatus: status,
          payeRemittedAt: status === "REMITTED" ? remittedAtIso : null,
          payePaymentMethod: status === "REMITTED" ? paymentMethod || "BANK" : null,
          payeReference: status === "REMITTED" ? reference : null,
          notes,
          updatedBy: user.id,
        })
      : await saveMonthlyRemittanceState(monthKey, {
          ssnitStatus: status,
          ssnitRemittedAt: status === "REMITTED" ? remittedAtIso : null,
          ssnitPaymentMethod: status === "REMITTED" ? paymentMethod || "BANK" : null,
          ssnitReference: status === "REMITTED" ? reference : null,
          notes,
          updatedBy: user.id,
        });

  if (status === "REMITTED") {
    try {
      if (kind === "PAYE" && summaryBefore.payeTax > 0) {
        await postPayrollStatutoryRemittanceEntry({
          monthKey,
          kind: "PAYE",
          paidAt: remittedAt,
          payeAmount: summaryBefore.payeTax,
          paymentMethod: paymentMethod || "BANK",
        });
      }
      if (kind === "SSNIT" && summaryBefore.ssnitEmployee + summaryBefore.ssnitEmployer > 0) {
        await postPayrollStatutoryRemittanceEntry({
          monthKey,
          kind: "SSNIT",
          paidAt: remittedAt,
          ssnitEmployeeAmount: summaryBefore.ssnitEmployee,
          ssnitEmployerAmount: summaryBefore.ssnitEmployer,
          paymentMethod: paymentMethod || "BANK",
        });
      }
    } catch (error) {
      console.warn("Statutory remittance posting skipped:", error);
    }
  }
  if (status === "PENDING") {
    try {
      if (kind === "PAYE" && summaryBefore.remittance.payeStatus === "REMITTED" && summaryBefore.payeTax > 0) {
        await postPayrollStatutoryRemittanceReversalEntry({
          monthKey,
          kind: "PAYE",
          reversedAt: new Date(),
          payeAmount: summaryBefore.payeTax,
          paymentMethod: summaryBefore.remittance.payePaymentMethod || "BANK",
        });
      }
      if (
        kind === "SSNIT" &&
        summaryBefore.remittance.ssnitStatus === "REMITTED" &&
        summaryBefore.ssnitEmployee + summaryBefore.ssnitEmployer > 0
      ) {
        await postPayrollStatutoryRemittanceReversalEntry({
          monthKey,
          kind: "SSNIT",
          reversedAt: new Date(),
          ssnitEmployeeAmount: summaryBefore.ssnitEmployee,
          ssnitEmployerAmount: summaryBefore.ssnitEmployer,
          paymentMethod: summaryBefore.remittance.ssnitPaymentMethod || "BANK",
        });
      }
    } catch (error) {
      console.warn("Statutory remittance reversal posting skipped:", error);
    }
  }

  const [summaryAfter, breakdownAfter] = await Promise.all([
    getMonthlyStatutorySummary(year, month),
    getMonthlyStatutoryEmployeeBreakdown(year, month),
  ]);
  const scheduleBefore = breakdownBefore.map((row) =>
    kind === "PAYE"
      ? {
          payrollRunId: row.payrollRunId,
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          grossPay: row.grossPay,
          payeTax: row.payeTax,
        }
      : {
          payrollRunId: row.payrollRunId,
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          ssnitEmployee: row.ssnitEmployee,
          ssnitEmployer: row.ssnitEmployer,
          ssnitTotal: row.ssnitTotal,
        },
  );
  const scheduleAfter = breakdownAfter.map((row) =>
    kind === "PAYE"
      ? {
          payrollRunId: row.payrollRunId,
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          grossPay: row.grossPay,
          payeTax: row.payeTax,
        }
      : {
          payrollRunId: row.payrollRunId,
          employeeId: row.employeeId,
          employeeName: row.employeeName,
          ssnitEmployee: row.ssnitEmployee,
          ssnitEmployer: row.ssnitEmployer,
          ssnitTotal: row.ssnitTotal,
        },
  );
  const scheduleTotalBefore = Number(
    kind === "PAYE"
      ? summaryBefore.payeTax
      : Number(summaryBefore.ssnitEmployee || 0) + Number(summaryBefore.ssnitEmployer || 0),
  );
  const scheduleTotalAfter = Number(
    kind === "PAYE"
      ? summaryAfter.payeTax
      : Number(summaryAfter.ssnitEmployee || 0) + Number(summaryAfter.ssnitEmployer || 0),
  );
  if (status === "REMITTED" && paymentMethod) {
    await recordRemittanceFiledSnapshot({
      monthKey,
      liability: kind,
      paymentMethod,
      reference: reference,
      remittedAtIso: remittedAtIso,
      actorId: user.id,
      scheduleRows: scheduleAfter,
      totalAmount: scheduleTotalAfter,
    });
  }
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYROLL_REMITTANCE_STATUS_UPDATE",
      entityType: "HRPayrollRemittance",
      entityId: monthKey,
      meta: {
        actor: {
          id: user.id,
          role: user.role,
        },
        sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/payroll/remittance",
        section: "statutory-remittance",
        operation: kind === "PAYE" ? "update_paye_remittance_status" : "update_ssnit_remittance_status",
        liability: kind === "PAYE" ? "PAYE tax" : "SSNIT",
        month: monthKey,
        before: {
          status:
            kind === "PAYE"
              ? summaryBefore.remittance.payeStatus
              : summaryBefore.remittance.ssnitStatus,
          paymentMethod:
            kind === "PAYE"
              ? summaryBefore.remittance.payePaymentMethod
              : summaryBefore.remittance.ssnitPaymentMethod,
          amountDue:
            kind === "PAYE"
              ? Number(summaryBefore.payeTax || 0)
              : Number(summaryBefore.ssnitEmployee || 0) + Number(summaryBefore.ssnitEmployer || 0),
          schedule: {
            employeeCount: scheduleBefore.length,
            totalAmount: scheduleTotalBefore,
            rows: scheduleBefore,
          },
        },
        after: {
          status:
            kind === "PAYE"
              ? summaryAfter.remittance.payeStatus
              : summaryAfter.remittance.ssnitStatus,
          paymentMethod:
            kind === "PAYE"
              ? summaryAfter.remittance.payePaymentMethod
              : summaryAfter.remittance.ssnitPaymentMethod,
          remittedAt:
            kind === "PAYE"
              ? nextRemittance.payeRemittedAt
              : nextRemittance.ssnitRemittedAt,
          reference:
            kind === "PAYE"
              ? nextRemittance.payeReference
              : nextRemittance.ssnitReference,
          schedule: {
            employeeCount: scheduleAfter.length,
            totalAmount: scheduleTotalAfter,
            rows: scheduleAfter,
          },
        },
        status: "SUCCESS",
        resultSummary:
          kind === "PAYE"
            ? `PAYE remittance status updated to ${status}.`
            : `SSNIT remittance status updated to ${status}.`,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(summaryAfter);
}
