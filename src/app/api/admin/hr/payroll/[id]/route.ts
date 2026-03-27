import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { postExpenseEntry, postPayrollAccrualEntry, postPayrollSettlementEntry } from "@/lib/accounting-posting";
import { getPayrollRunYtdTotalsForEmployees } from "@/lib/hr-paystub-detail";

const updateSchema = z.object({
  status: z.enum(["DRAFT", "FINALIZED", "PAID", "CANCELLED"]).optional(),
  totalGross: z.number().optional(),
  totalNet: z.number().optional(),
  createExpense: z.boolean().optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["FINALIZED", "CANCELLED"],
  FINALIZED: ["PAID"],
  PAID: [],
  CANCELLED: [],
};

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

function summarizePayrollStatusResult(status: "FINALIZED" | "PAID" | "CANCELLED") {
  if (status === "FINALIZED") return "Payroll run finalized successfully.";
  if (status === "PAID") return "Payroll run marked as paid successfully.";
  return "Payroll run cancelled successfully.";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payroll run id is required" }, { status: 400 });
  }
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    include: {
      payslips: { include: { employee: true } },
      expense: true,
      adjustmentFor: {
        select: { id: true, periodStart: true, periodEnd: true, status: true },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const adjustmentsCount = await prisma.payrollRun.count({
    where: { adjustmentForId: run.id, runType: "ADJUSTMENT" },
  });
  const adjustments =
    run.runType === "ADJUSTMENT"
      ? []
      : await prisma.payrollRun.findMany({
          where: { adjustmentForId: run.id, runType: "ADJUSTMENT" },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            periodStart: true,
            periodEnd: true,
            status: true,
            adjustmentNote: true,
            totalGross: true,
            totalNet: true,
          },
        });

  const employeeIds = run.payslips.map((slip) => slip.employeeId);
  const ytdTotals = await getPayrollRunYtdTotalsForEmployees({
    employeeIds,
    payrollRunId: run.id,
    periodEnd: run.periodEnd || new Date(),
  });

  return NextResponse.json({ ...run, adjustmentsCount, adjustments, ytdTotals });
}

export async function PATCH(
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
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  if (typeof parsed.data.totalGross === "number" || typeof parsed.data.totalNet === "number") {
    return NextResponse.json(
      { error: "Manual run total overrides are not allowed. Totals are derived from payslips." },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.payrollRun.findUnique({
        where: { id: resolvedParams.id },
        include: { expense: true },
      });
      if (!existing) return null;

      const data: Record<string, unknown> = {};
      let cancelledPayslips = 0;
      let cancelledTotals: { gross: number; net: number } | null = null;
      const statusChanged =
        parsed.data.status != null && parsed.data.status !== existing.status;
      if (parsed.data.status && statusChanged) {
        if (parsed.data.status !== existing.status) {
          const allowedTargets = ALLOWED_TRANSITIONS[existing.status] || [];
          if (!allowedTargets.includes(parsed.data.status)) {
            throw new Error(
              `Invalid payroll status transition: ${existing.status} to ${parsed.data.status}.`,
            );
          }
        }
        if (parsed.data.status === "FINALIZED") {
          const [payslipCount, totals] = await Promise.all([
            tx.payslip.count({ where: { payrollRunId: existing.id } }),
            tx.payslip.aggregate({
              where: { payrollRunId: existing.id },
              _sum: { grossPay: true, netPay: true },
            }),
          ]);
          if (payslipCount <= 0) {
            throw new Error("Cannot finalize run without at least one payslip.");
          }
          const grossTotal = Number(totals._sum.grossPay || 0);
          const netTotal = Number(totals._sum.netPay || 0);
          data.totalGross = grossTotal;
          data.totalNet = netTotal;
        }
        if (parsed.data.status === "CANCELLED") {
          cancelledTotals = {
            gross: Number(existing.totalGross || 0),
            net: Number(existing.totalNet || 0),
          };
          const deleted = await tx.payslip.deleteMany({
            where: { payrollRunId: existing.id },
          });
          cancelledPayslips = deleted.count;
          data.totalGross = 0;
          data.totalNet = 0;
        }
        data.status = parsed.data.status;
      }
      if (
        statusChanged &&
        parsed.data.status &&
        parsed.data.status !== "DRAFT" &&
        parsed.data.status !== "CANCELLED"
      ) {
        data.finalizedAt = existing.finalizedAt ?? new Date();
      }

      const updated =
        Object.keys(data).length > 0
          ? await tx.payrollRun.update({
              where: { id: resolvedParams.id },
              data,
            })
          : existing;

      let expense = existing.expense;
      let createdExpense = false;
      if (
        parsed.data.createExpense &&
        !expense &&
        (updated.status === "FINALIZED" || updated.status === "PAID")
      ) {
        const amount = Number(updated.totalGross);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Payroll totalGross must be set before creating expense.");
        }

        const expenseLabel =
          updated.runType === "ADJUSTMENT" ? "Payroll adjustment run" : "Payroll run";
        expense = await tx.expense.create({
          data: {
            category: "Payroll",
            amount,
            reason: "Payroll run",
            note: `${expenseLabel} ${updated.periodStart.toISOString()} - ${updated.periodEnd.toISOString()}`,
            payrollRunId: updated.id,
          },
        });
        createdExpense = true;
      }

      return {
        updated,
        expense,
        createdExpense,
        cancelledPayslips,
        cancelledTotals,
        previousStatus: existing.status,
        previousExpenseId: existing.expense?.id ?? null,
        statusChanged,
      };
    });

    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (
      parsed.data.status &&
      result.statusChanged &&
      (parsed.data.status === "FINALIZED" ||
        parsed.data.status === "PAID" ||
        parsed.data.status === "CANCELLED")
    ) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "PAYROLL_STATUS_UPDATE",
          entityType: "PAYROLL_RUN",
          entityId: result.updated.id,
          meta: {
            actor: buildAuditActor(user),
            sourcePage: "admin/hr/payroll/[id]",
            section: "run-actions",
            operation:
              parsed.data.status === "FINALIZED"
                ? "finalize_run"
                : parsed.data.status === "PAID"
                  ? "mark_paid"
                  : "cancel_run",
            period: {
              periodStart: result.updated.periodStart.toISOString(),
              periodEnd: result.updated.periodEnd.toISOString(),
            },
            before: {
              status: result.previousStatus,
              expenseId: result.previousExpenseId,
            },
            after: {
              status: result.updated.status,
              totalGross: Number(result.updated.totalGross),
              totalNet: Number(result.updated.totalNet),
              expenseId: result.expense?.id ?? result.previousExpenseId ?? null,
            },
            cancelledPayslips: result.cancelledPayslips ?? 0,
            cancelledTotals: result.cancelledTotals ?? null,
            status: "SUCCESS",
            resultSummary: summarizePayrollStatusResult(parsed.data.status),
          },
        });
      } catch {
        // best-effort
      }
    }

    if (result.createdExpense && result.expense) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "PAYROLL_EXPENSE_CREATE",
          entityType: "PAYROLL_RUN",
          entityId: result.updated.id,
          meta: {
            actor: buildAuditActor(user),
            sourcePage: "admin/hr/payroll/[id]",
            section: "run-actions",
            operation: "create_expense_entry",
            period: {
              periodStart: result.updated.periodStart.toISOString(),
              periodEnd: result.updated.periodEnd.toISOString(),
            },
            before: {
              status: result.updated.status,
              expenseId: result.previousExpenseId,
            },
            after: {
              status: result.updated.status,
              expenseId: result.expense.id,
              amount: Number(result.expense.amount || 0),
              category: result.expense.category,
              note: result.expense.note || result.expense.reason || null,
            },
            status: "SUCCESS",
            resultSummary: "Expense entry created for payroll run successfully.",
          },
        });
      } catch {
        // best-effort
      }
    }

    if (result.expense?.id) {
      try {
        await postExpenseEntry({
          expenseId: result.expense.id,
          amount: Number(result.expense.amount || 0),
          createdAt: result.expense.createdAt,
          category: result.expense.category,
          note: result.expense.note || result.expense.reason || result.expense.category,
          isReversal: result.expense.isReversal,
        });
      } catch (e) {
        console.warn("Accounting expense posting skipped (payroll run):", e);
      }
    }

    if (result.updated.status === "FINALIZED" || result.updated.status === "PAID") {
      try {
        await postPayrollAccrualEntry({ payrollRunId: result.updated.id });
      } catch (e) {
        console.warn("Accounting payroll accrual posting skipped:", e);
      }
    }
    if (result.updated.status === "PAID") {
      try {
        await postPayrollSettlementEntry({ payrollRunId: result.updated.id });
      } catch (e) {
        console.warn("Accounting payroll settlement posting skipped:", e);
      }
    }

    return NextResponse.json(result.updated);
  } catch (err) {
    console.error("Error updating payroll run:", err);
    const message = err instanceof Error ? err.message : "Failed to update payroll run";
    if (
      /Cannot finalize run without at least one payslip/i.test(message) ||
      /Invalid payroll status transition/i.test(message) ||
      /Manual run total overrides are not allowed/i.test(message)
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
