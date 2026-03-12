import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { createZip } from "@/lib/zip";
import { recordAuditLog } from "@/lib/audit-log";

const schema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(40),
});

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

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-reconciliation-export-zip", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const ids = Array.from(new Set(parsed.data.ids));

  const reconciliations = await prisma.reconciliation.findMany({
    where: { id: { in: ids } },
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
  if (reconciliations.length === 0) {
    return NextResponse.json({ error: "No reconciliations found" }, { status: 404 });
  }

  const files: Array<{ name: string; data: Buffer }> = [];
  for (const reconciliation of reconciliations) {
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

    const lineMap = new Map(reconciliation.lines.map((line) => [line.bankTransactionId, line]));
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
      const entryDate = journal?.entry?.entryDate ? new Date(journal.entry.entryDate).toISOString().slice(0, 10) : "";
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
    files.push({
      name: `reconciliation-${reconciliation.id}.csv`,
      data: Buffer.from(csv, "utf8"),
    });
  }

  const zip = createZip(files);
  const fileName = `reconciliations-bulk-${new Date().toISOString().slice(0, 10)}.zip`;
  await recordAuditLog({
    actorId: user?.id || null,
    action: "reconciliation.bulk.export.zip",
    entityType: "Reconciliation",
    entityId: `count:${files.length}`,
    meta: { ids, fileName },
  });

  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
