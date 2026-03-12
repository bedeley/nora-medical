import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const reconciliation = await prisma.reconciliation.findUnique({
    where: { id: params.id },
    include: {
      bankAccount: true,
      lines: {
        include: {
          journalLine: {
            include: {
              account: true,
              entry: true,
            },
          },
        },
      },
    },
  });

  if (!reconciliation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const bankTxns = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId: reconciliation.bankAccountId,
      postedAt: {
        gte: reconciliation.periodStart,
        lte: reconciliation.periodEnd,
      },
    },
    orderBy: { postedAt: "asc" },
  });

  const lineMap = new Map(
    reconciliation.lines.map((line) => [line.bankTransactionId, line]),
  );

  const header = [
    "Bank Date",
    "Description",
    "Reference",
    "Type",
    "Amount",
    "Matched",
    "Journal Date",
    "Account Code",
    "Account Name",
    "Debit",
    "Credit",
    "Match Status",
    "Journal Memo",
  ];

  const rows = bankTxns.map((txn) => {
    const match = lineMap.get(txn.id);
    const journal = match?.journalLine;
    const entryDate = journal?.entry?.entryDate
      ? new Date(journal.entry.entryDate).toISOString().slice(0, 10)
      : "";
    const bankDate = new Date(txn.postedAt).toISOString().slice(0, 10);
    return [
      bankDate,
      txn.description || "",
      txn.reference || "",
      txn.type,
      Number(txn.amount).toFixed(2),
      txn.matched ? "Yes" : "No",
      entryDate,
      journal?.account?.code || "",
      journal?.account?.name || "",
      journal ? Number(journal.debit || 0).toFixed(2) : "",
      journal ? Number(journal.credit || 0).toFixed(2) : "",
      match?.matchStatus || "UNMATCHED",
      journal?.entry?.memo || "",
    ];
  });

  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `reconciliation-${reconciliation.id}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
