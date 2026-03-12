import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const payslipSchema = z.object({
  payrollRunId: z.string().min(1),
  employeeId: z.string().min(1),
  grossPay: z.number(),
  netPay: z.number(),
  lineItems: z.unknown().optional(),
});

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
  const payrollRunId = searchParams.get("payrollRunId")?.trim() || "";
  const employeeId = searchParams.get("employeeId")?.trim() || "";

  const payslips = await prisma.payslip.findMany({
    where: {
      ...(payrollRunId ? { payrollRunId } : {}),
      ...(employeeId ? { employeeId } : {}),
    },
    include: { employee: true, payrollRun: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: payslips });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payslipSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const run = await prisma.payrollRun.findUnique({
      where: { id: parsed.data.payrollRunId },
      select: { id: true, status: true },
    });
    if (!run) {
      return NextResponse.json({ error: "Payroll run not found" }, { status: 404 });
    }
    if (run.status !== "DRAFT") {
      return NextResponse.json(
        { error: "Payslips can only be added to a DRAFT payroll run." },
        { status: 400 }
      );
    }

    const { payslip } = await prisma.$transaction(async (tx) => {
      const payslip = await tx.payslip.create({
        data: {
          payrollRunId: parsed.data.payrollRunId,
          employeeId: parsed.data.employeeId,
          grossPay: parsed.data.grossPay,
          netPay: parsed.data.netPay,
          lineItems: parsed.data.lineItems ?? undefined,
        },
      });

      const totals = await tx.payslip.aggregate({
        where: { payrollRunId: parsed.data.payrollRunId },
        _sum: { grossPay: true, netPay: true },
      });

      await tx.payrollRun.update({
        where: { id: parsed.data.payrollRunId },
        data: {
          totalGross: Number(totals._sum.grossPay || 0),
          totalNet: Number(totals._sum.netPay || 0),
        },
      });

      return { payslip };
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "PAYSLIP_CREATE",
        entityType: "PAYSLIP",
        entityId: payslip.id,
        meta: {
          payrollRunId: payslip.payrollRunId,
          employeeId: payslip.employeeId,
          grossPay: Number(payslip.grossPay),
          netPay: Number(payslip.netPay),
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(payslip);
  } catch (err) {
    console.error("Error creating payslip:", err);
    return NextResponse.json({ error: "Failed to create payslip" }, { status: 500 });
  }
}
