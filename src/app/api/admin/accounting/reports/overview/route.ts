import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, toNet } from "../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const KEY_CODES = ["1000", "1010", "1100", "2000", "2100", "1200"] as const;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [accounts, totals] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { code: { in: KEY_CODES as unknown as string[] } },
    }),
    loadAccountTotals(),
  ]);

  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const details = accounts
    .map((account) => {
      const row = totalsByCode.get(account.code);
      return {
        code: account.code,
        name: account.name,
        balance: row ? toNet(row) : 0,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const byCode = new Map(details.map((row) => [row.code, row.balance]));
  const cash = byCode.get("1000") ?? 0;
  const bank = byCode.get("1010") ?? 0;
  const accountsReceivable = byCode.get("1100") ?? 0;
  const accountsPayable = byCode.get("2000") ?? 0;
  const vatPayable = byCode.get("2100") ?? 0;
  const inventory = byCode.get("1200") ?? 0;

  return NextResponse.json({
    snapshot: {
      cash,
      bank,
      netCash: cash + bank,
      accountsReceivable,
      accountsPayable,
      vatPayable,
      inventory,
    },
    details,
  });
}
