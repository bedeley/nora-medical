import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { postExpenseEntry, postPayrollAccrualEntry, postPayrollSettlementEntry } from "@/lib/accounting-posting";

const updateSchema = z.object({
  status: z.enum(["DRAFT", "FINALIZED", "PAID", "CANCELLED"]).optional(),
  totalGross: z.number().optional(),
  totalNet: z.number().optional(),
  createExpense: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
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

  const employeeIds = run.payslips.map((slip) => slip.employeeId);
  const periodEnd = run.periodEnd || new Date();
  const yearStart = new Date(periodEnd.getFullYear(), 0, 1);
  const yearEnd = new Date(periodEnd.getFullYear(), 11, 31, 23, 59, 59, 999);

  const ytdPayslips = employeeIds.length
    ? await prisma.payslip.findMany({
        where: {
          employeeId: { in: employeeIds },
          payrollRun: {
            periodEnd: {
              gte: yearStart,
              lte: yearEnd,
            },
          },
        },
        select: {
          employeeId: true,
          grossPay: true,
          netPay: true,
          lineItems: true,
        },
      })
    : [];

  const ytdTotals = ytdPayslips.reduce<
    Record<string, { gross: number; net: number; deductions: number; tax: number; pension: number }>
  >(
    (acc, slip) => {
      const gross = Number(slip.grossPay || 0);
      const net = Number(slip.netPay || 0);
      const lineItems = slip.lineItems as Record<string, unknown> | null | undefined;
      const tax = Number(lineItems?.tax ?? 0);
      const pension = Number(lineItems?.pension ?? 0);
      const deductions = Math.max(0, Number(lineItems?.deductions ?? gross - net));
      const entry = acc[slip.employeeId] || {
        gross: 0,
        net: 0,
        deductions: 0,
        tax: 0,
        pension: 0,
      };
      entry.gross += gross;
      entry.net += net;
      entry.deductions += deductions;
      entry.tax += tax;
      entry.pension += pension;
      acc[slip.employeeId] = entry;
      return acc;
    },
    {}
  );

  return NextResponse.json({ ...run, adjustmentsCount, ytdTotals });
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
      if (parsed.data.status) {
        if (existing.status !== "DRAFT" && parsed.data.status === "CANCELLED") {
          throw new Error("Only DRAFT payroll runs can be cancelled.");
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
      if (typeof parsed.data.totalGross === "number") data.totalGross = parsed.data.totalGross;
      if (typeof parsed.data.totalNet === "number") data.totalNet = parsed.data.totalNet;
      if (parsed.data.status && parsed.data.status !== "DRAFT" && parsed.data.status !== "CANCELLED") {
        data.finalizedAt = existing.finalizedAt ?? new Date();
      }

      const updated = await tx.payrollRun.update({
        where: { id: resolvedParams.id },
        data,
      });

      let expense = existing.expense;
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
      }

      return { updated, expense, cancelledPayslips, cancelledTotals };
    });

    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (parsed.data.status && (parsed.data.status === "FINALIZED" || parsed.data.status === "PAID" || parsed.data.status === "CANCELLED")) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "PAYROLL_STATUS_UPDATE",
          entityType: "PAYROLL_RUN",
          entityId: result.updated.id,
          meta: {
            status: result.updated.status,
            totalGross: Number(result.updated.totalGross),
            totalNet: Number(result.updated.totalNet),
            expenseId: result.expense?.id ?? null,
            cancelledPayslips: result.cancelledPayslips ?? 0,
            cancelledTotals: result.cancelledTotals ?? null,
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
