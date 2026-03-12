import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange } from "../../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const escapeCsv = (value: string) => {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
};

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
          select: { id: true, code: true, name: true, type: true },
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

  const totals = accountIds
    .map((accountId) => {
      const opening = openingMap.get(accountId);
      const movement = movementMap.get(accountId);
      const closing = closingMap.get(accountId);
      const base = opening || movement || closing;
      const account = includeZero ? allAccounts.find((row) => row.id === accountId) : null;
      if (!base && !account) return null;
      return {
        code: base?.code || account?.code || "",
        name: base?.name || account?.name || "",
        type: base?.type || account?.type || "",
        openingDebit: opening?.debit || 0,
        openingCredit: opening?.credit || 0,
        movementDebit: movement?.debit || 0,
        movementCredit: movement?.credit || 0,
        closingDebit: closing?.debit || 0,
        closingCredit: closing?.credit || 0,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => a.code.localeCompare(b.code));

  const header = [
    "Code",
    "Account",
    "Type",
    "Opening Debit",
    "Opening Credit",
    "Movement Debit",
    "Movement Credit",
    "Closing Debit",
    "Closing Credit",
  ];
  const rows = totals.map((row) => [
    row.code,
    row.name,
    row.type,
    row.openingDebit.toFixed(2),
    row.openingCredit.toFixed(2),
    row.movementDebit.toFixed(2),
    row.movementCredit.toFixed(2),
    row.closingDebit.toFixed(2),
    row.closingCredit.toFixed(2),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `trial-balance${start || end ? `-${start || "start"}-${end || "end"}` : ""}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
