import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { parseDateRange } from "../reports/utils";

const filingSchema = z.object({
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

  const rows = await prisma.vatFilingRun.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(rows);
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
    const parsed = filingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const startDate = new Date(parsed.data.startDate);
    const endDate = new Date(parsed.data.endDate);
    if (startDate > endDate) {
      return NextResponse.json({ error: "Start date must be before end date." }, { status: 400 });
    }

    const dateRange = parseDateRange(parsed.data.startDate, parsed.data.endDate);
    const lines = await prisma.journalLine.findMany({
      where: {
        taxCodeId: { not: null },
        entry: {
          status: "POSTED",
          entryDate: dateRange.gte || dateRange.lte ? dateRange : undefined,
        },
      },
      include: { taxCode: true },
    });

    const totalsMap = new Map<
      string,
      {
        taxCodeId: string;
        name: string;
        rate: number;
        type: string;
        baseTotal: number;
        vatTotal: number;
      }
    >();

    for (const line of lines) {
      if (!line.taxCode) continue;
      const rate = Number(line.taxCode.rate || 0);
      const base = Math.abs(Number(line.debit || 0) - Number(line.credit || 0));
      const vatTotal =
        line.taxCode.type === "OUTPUT" || line.taxCode.type === "INPUT"
          ? base * (rate / 100)
          : 0;

      const existing = totalsMap.get(line.taxCode.id) || {
        taxCodeId: line.taxCode.id,
        name: line.taxCode.name,
        rate,
        type: line.taxCode.type,
        baseTotal: 0,
        vatTotal: 0,
      };

      existing.baseTotal += base;
      existing.vatTotal += vatTotal;
      totalsMap.set(line.taxCode.id, existing);
    }

    const totals = Array.from(totalsMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    const outputVat = totals.filter((row) => row.type === "OUTPUT").reduce((sum, row) => sum + row.vatTotal, 0);
    const inputVat = totals.filter((row) => row.type === "INPUT").reduce((sum, row) => sum + row.vatTotal, 0);
    const outputBase = totals.filter((row) => row.type === "OUTPUT").reduce((sum, row) => sum + row.baseTotal, 0);
    const inputBase = totals.filter((row) => row.type === "INPUT").reduce((sum, row) => sum + row.baseTotal, 0);
    const exemptBase = totals.filter((row) => row.type === "EXEMPT").reduce((sum, row) => sum + row.baseTotal, 0);
    const zeroBase = totals.filter((row) => row.type === "ZERO").reduce((sum, row) => sum + row.baseTotal, 0);
    const summary = {
      outputVat,
      inputVat,
      netVat: outputVat - inputVat,
      outputBase,
      inputBase,
      exemptBase,
      zeroBase,
    };

    const run = await prisma.vatFilingRun.create({
      data: {
        startDate,
        endDate,
        summary,
        details: totals,
      },
    });

    return NextResponse.json(run);
  } catch (error) {
    console.error("VAT filing run create error:", error);
    return NextResponse.json({ error: "Failed to create VAT filing run" }, { status: 500 });
  }
}
