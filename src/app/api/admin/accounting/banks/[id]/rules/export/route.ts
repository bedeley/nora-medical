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
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
