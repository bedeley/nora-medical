import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { recordAuditLog } from "@/lib/audit-log";

const generateSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  taxPercent: z.number().min(0).max(100).optional(),
  pensionPercent: z.number().min(0).max(100).optional(),
  bonus: z.number().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = generateSchema.safeParse({
    ...body,
    year: typeof body.year === "string" ? Number(body.year) : body.year,
    month: typeof body.month === "string" ? Number(body.month) : body.month,
    taxPercent: typeof body.taxPercent === "string" ? Number(body.taxPercent) : body.taxPercent,
    pensionPercent: typeof body.pensionPercent === "string"
      ? Number(body.pensionPercent)
      : body.pensionPercent,
    bonus: typeof body.bonus === "string" ? Number(body.bonus) : body.bonus,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const { year, month } = parsed.data;
  const { start, end } = monthRange(year, month);
  const taxPercent = parsed.data.taxPercent ?? 0;
  const pensionPercent = parsed.data.pensionPercent ?? 0;
  const bonus = parsed.data.bonus ?? 0;

  let run = await prisma.payrollRun.findFirst({
    where: {
      periodStart: { gte: start, lte: end },
      periodEnd: { gte: start, lte: end },
      status: "DRAFT",
      runType: "REGULAR",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!run) {
    const finalizedExists = await prisma.payrollRun.findFirst({
      where: {
        periodStart: { gte: start, lte: end },
        periodEnd: { gte: start, lte: end },
        status: { in: ["FINALIZED", "PAID"] },
        runType: "REGULAR",
      },
      select: { id: true },
    });
    if (finalizedExists) {
      return NextResponse.json(
        { error: "Payroll run already finalized for this month." },
        { status: 409 }
      );
    }
  }

  run =
    run ??
    (await prisma.payrollRun.create({
      data: {
        periodStart: start,
        periodEnd: end,
        status: "DRAFT",
        runType: "REGULAR",
        totalGross: 0,
        totalNet: 0,
      },
    }));

  const result = await generatePayslipsForRun({
    payrollRunId: run.id,
    taxPercent,
    pensionPercent,
    bonus,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYROLL_GENERATE_MONTHLY",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      meta: {
        year,
        month,
        created: result.created,
        skipped: result.skipped,
        taxPercent,
        pensionPercent,
        bonus,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ...result, payrollRunId: run.id });
}
