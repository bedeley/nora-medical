import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";

const generateSchema = z.object({
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
    taxPercent: typeof body.taxPercent === "string" ? Number(body.taxPercent) : body.taxPercent,
    pensionPercent: typeof body.pensionPercent === "string" ? Number(body.pensionPercent) : body.pensionPercent,
    bonus: typeof body.bonus === "string" ? Number(body.bonus) : body.bonus,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const taxPercent = parsed.data.taxPercent ?? 0;
  const pensionPercent = parsed.data.pensionPercent ?? 0;
  const bonus = parsed.data.bonus ?? 0;

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    select: { runType: true },
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
      action: "PAYROLL_GENERATE",
      entityType: "PAYROLL_RUN",
      entityId: resolvedParams.id,
      meta: {
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
  return NextResponse.json(result);
}
