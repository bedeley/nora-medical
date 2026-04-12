import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

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
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rules = await prisma.bankMatchRule.findMany({
    where: { bankAccountId: params.id },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    include: { account: true },
  });

  const header = [
    "name",
    "matchText",
    "matchMode",
    "accountCode",
    "minAmount",
    "maxAmount",
    "amountTolerance",
    "priority",
    "isActive",
  ];

  const rows = rules.map((rule) => [
    rule.name,
    rule.matchText,
    rule.matchMode,
    rule.account?.code || "",
    rule.minAmount ? Number(rule.minAmount).toFixed(2) : "",
    rule.maxAmount ? Number(rule.maxAmount).toFixed(2) : "",
    Number(rule.amountTolerance || 0).toFixed(2),
    String(rule.priority || 0),
    rule.isActive ? "true" : "false",
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `bank-match-rules-${params.id}.csv`;
  const sourcePage = String(new URL(req.url).searchParams.get("sourcePage") || "admin/accounting/banks").trim();
  await recordAccountingBankAudit({
    req,
    actor,
    action: "BANK_RULE_EXPORT_CSV",
    entityType: "BANK_MATCH_RULE",
    entityId: params.id,
    section: "rules",
    operation: "export_csv",
    resultSummary: `Exported ${rows.length} bank match rule row(s) to CSV.`,
    meta: {
      bankAccountId: params.id,
      format: "CSV",
      fileName: filename,
      rowCount: rows.length,
      columnCount: header.length,
      byteSize: Buffer.byteLength(csv, "utf8"),
      sourcePage,
    },
  });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
