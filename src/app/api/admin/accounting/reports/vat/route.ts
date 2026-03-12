import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseDateRange } from "../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

type TaxTotals = {
  taxCodeId: string;
  name: string;
  rate: number;
  type: "OUTPUT" | "INPUT" | "EXEMPT" | "ZERO";
  baseTotal: number;
  vatTotal: number;
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const dateRange = parseDateRange(start, end);

  const lines = await prisma.journalLine.findMany({
    where: {
      taxCodeId: { not: null },
      entry: {
        status: "POSTED",
        entryDate: dateRange.gte || dateRange.lte ? dateRange : undefined,
      },
    },
    include: {
      taxCode: true,
    },
  });

  const totalsMap = new Map<string, TaxTotals>();
  for (const line of lines) {
    if (!line.taxCode) continue;
    const rate = Number(line.taxCode.rate || 0);
    const base = Math.abs(Number(line.debit || 0) - Number(line.credit || 0));
    const vatTotal = line.taxCode.type === "OUTPUT" || line.taxCode.type === "INPUT"
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

  return NextResponse.json({
    range: { start, end },
    totals,
    summary: {
      outputVat,
      inputVat,
      netVat: outputVat - inputVat,
      outputBase,
      inputBase,
      exemptBase,
      zeroBase,
    },
  });
}
