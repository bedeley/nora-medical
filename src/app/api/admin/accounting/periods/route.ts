import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { ensureDefaultOpenFiscalPeriod, normalizeFiscalPeriodDateRange } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const periodSchema = z.object({
  name: z.string().min(1).max(120),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureDefaultOpenFiscalPeriod();

  const periods = await prisma.fiscalPeriod.findMany({
    orderBy: { startDate: "desc" },
  });
  return NextResponse.json(periods);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = periodSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const normalizedRange = normalizeFiscalPeriodDateRange(parsed.data.startDate, parsed.data.endDate);
    if ("error" in normalizedRange) {
      return NextResponse.json({ error: normalizedRange.error }, { status: 400 });
    }
    const { start, end } = normalizedRange;

    const overlap = await prisma.fiscalPeriod.findFirst({
      where: {
        startDate: { lte: end },
        endDate: { gte: start },
      },
      select: { id: true, name: true },
    });
    if (overlap) {
      return NextResponse.json(
        { error: `Overlaps existing period "${overlap.name}".` },
        { status: 400 },
      );
    }

    const period = await prisma.fiscalPeriod.create({
      data: {
        name: parsed.data.name,
        startDate: start,
        endDate: end,
        status: "OPEN",
      },
    });

    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "fiscal-period.create",
      entityType: "FiscalPeriod",
      entityId: period.id,
      meta: { name: period.name },
    });

    return NextResponse.json(period);
  } catch (error) {
    console.error("Accounting period create error:", error);
    return NextResponse.json({ error: "Failed to create period" }, { status: 500 });
  }
}
