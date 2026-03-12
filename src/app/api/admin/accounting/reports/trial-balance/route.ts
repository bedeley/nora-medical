import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange } from "../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function classifyPattern(
  code: string,
  type: string,
  normalBalance: number,
): { unusualBalance: boolean; patternSeverity: "FLAG" | "INFO" | "NONE"; patternNote: string | null } {
  if (normalBalance >= 0) {
    return { unusualBalance: false, patternSeverity: "NONE", patternNote: null };
  }

  if (code === "6990") {
    return {
      unusualBalance: false,
      patternSeverity: "INFO",
      patternNote: "Cash overage posted (credit balance on over/short).",
    };
  }

  if (type === "ASSET" && (code === "1000" || code === "1010")) {
    return {
      unusualBalance: false,
      patternSeverity: "INFO",
      patternNote: "Negative cash/bank indicates overdraft/deficit; review cash/bank reconciliation.",
    };
  }

  if (type === "LIABILITY" && code === "2000") {
    return {
      unusualBalance: false,
      patternSeverity: "INFO",
      patternNote: "AP debit balance suggests supplier prepayments/over-settlement.",
    };
  }

  if (type === "LIABILITY" && code === "2100") {
    return {
      unusualBalance: false,
      patternSeverity: "INFO",
      patternNote: "VAT debit balance suggests recoverable input VAT (net VAT receivable).",
    };
  }

  return {
    unusualBalance: true,
    patternSeverity: "FLAG",
    patternNote: "Balance direction differs from account normal side.",
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const includeZero = searchParams.get("includeZero") === "1";

  const openingEnd = start
    ? new Date(new Date(`${start}T00:00:00`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;

  const [openingTotals, movementTotals, closingTotals, allAccounts] = await Promise.all([
    openingEnd ? loadAccountTotals(parseDateRange(null, openingEnd)) : Promise.resolve([]),
    loadAccountTotals(parseDateRange(start, end)),
    loadAccountTotals(parseDateRange(null, end)),
    includeZero
      ? prisma.ledgerAccount.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true, type: true, subtype: true },
          orderBy: { code: "asc" },
        })
      : Promise.resolve([]),
  ]);

  const openingMap = new Map(openingTotals.map((row) => [row.accountId, row]));
  const movementMap = new Map(movementTotals.map((row) => [row.accountId, row]));
  const closingMap = new Map(closingTotals.map((row) => [row.accountId, row]));

  const accountIds = includeZero
    ? allAccounts.map((row) => row.id)
    : Array.from(new Set([...openingMap.keys(), ...movementMap.keys(), ...closingMap.keys()]));

  const rows = accountIds
    .map((accountId) => {
      const opening = openingMap.get(accountId);
      const movement = movementMap.get(accountId);
      const closing = closingMap.get(accountId);
      const base = opening || movement || closing;
      const account = includeZero ? allAccounts.find((row) => row.id === accountId) : null;
      if (!base && !account) return null;

      const type = base?.type || account?.type;
      const openingDebit = opening?.debit || 0;
      const openingCredit = opening?.credit || 0;
      const movementDebit = movement?.debit || 0;
      const movementCredit = movement?.credit || 0;
      const closingDebit = closing?.debit || 0;
      const closingCredit = closing?.credit || 0;
      const normalBalance =
        type === "ASSET" || type === "EXPENSE"
          ? closingDebit - closingCredit
          : closingCredit - closingDebit;
      const pattern = classifyPattern(String(base?.code || account?.code || ""), String(type || ""), normalBalance);

      return {
        accountId,
        code: base?.code || account?.code || "",
        name: base?.name || account?.name || "",
        type: type || "ASSET",
        openingDebit,
        openingCredit,
        movementDebit,
        movementCredit,
        closingDebit,
        closingCredit,
        unusualBalance: pattern.unusualBalance,
        patternSeverity: pattern.patternSeverity,
        patternNote: pattern.patternNote,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => a.code.localeCompare(b.code));

  const summary = rows.reduce(
    (acc, row) => {
      acc.openingDebit += row.openingDebit;
      acc.openingCredit += row.openingCredit;
      acc.movementDebit += row.movementDebit;
      acc.movementCredit += row.movementCredit;
      acc.closingDebit += row.closingDebit;
      acc.closingCredit += row.closingCredit;
      return acc;
    },
    {
      openingDebit: 0,
      openingCredit: 0,
      movementDebit: 0,
      movementCredit: 0,
      closingDebit: 0,
      closingCredit: 0,
    },
  );

  return NextResponse.json({
    range: { start, end },
    totals: rows,
    summary,
  });
}
