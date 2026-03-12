import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const getReconciliationId = (req: Request) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 2] || "";
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const recId = getReconciliationId(req);
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }

  const reconciliation = await prisma.reconciliation.findUnique({
    where: { id: recId },
    select: {
      id: true,
      bankAccountId: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      bankAccount: { select: { name: true } },
    },
  });
  if (!reconciliation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [unmatchedBankTxns, unmatchedJournalLines] = await Promise.all([
    prisma.bankTransaction.count({
      where: {
        bankAccountId: reconciliation.bankAccountId,
        postedAt: {
          gte: reconciliation.periodStart,
          lte: reconciliation.periodEnd,
        },
        matched: false,
      },
    }),
    prisma.journalLine.count({
      where: {
        reconciliationLine: null,
        account: {
          OR: [
            { code: "1010" },
            reconciliation.bankAccount?.name
              ? { name: { contains: reconciliation.bankAccount.name, mode: "insensitive" } }
              : undefined,
            { name: { contains: "bank", mode: "insensitive" } },
          ].filter(Boolean) as Array<Record<string, unknown>>,
        },
        entry: {
          status: "POSTED",
          entryDate: {
            gte: reconciliation.periodStart,
            lte: reconciliation.periodEnd,
          },
        },
      },
    }),
  ]);

  return NextResponse.json({
    reconciliationId: reconciliation.id,
    status: reconciliation.status,
    unmatchedBankTxns,
    unmatchedJournalLines,
  });
}
