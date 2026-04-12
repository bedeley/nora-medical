import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const parseCsv = (text: string) => {
  const rows: string[][] = [];
  let current: string[] = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      current.push(value);
      value = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      if (value.length > 0 || current.length > 0) {
        current.push(value);
        rows.push(current);
        current = [];
        value = "";
      }
      continue;
    }
    value += char;
  }
  if (value.length > 0 || current.length > 0) {
    current.push(value);
    rows.push(current);
  }
  return rows;
};

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const csv = String(body?.csv || "");
    if (!csv.trim()) {
      return NextResponse.json({ error: "CSV content is required." }, { status: 400 });
    }

    const rows = parseCsv(csv);
    if (rows.length < 2) {
      return NextResponse.json({ error: "CSV must include a header and at least one row." }, { status: 400 });
    }

    const header = rows[0].map((h) => h.trim());
    const expected = [
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
    const missing = expected.filter((h) => !header.includes(h));
    if (missing.length > 0) {
      return NextResponse.json({ error: `Missing columns: ${missing.join(", ")}` }, { status: 400 });
    }

    const colIndex = Object.fromEntries(header.map((h, idx) => [h, idx]));
    const accountCodes = rows
      .slice(1)
      .map((row) => row[colIndex.accountCode]?.trim())
      .filter((code) => code);

    const accounts = await prisma.ledgerAccount.findMany({
      where: { code: { in: accountCodes as string[] } },
      select: { id: true, code: true },
    });
    const accountByCode = new Map(accounts.map((acc) => [acc.code, acc.id]));

    const created = [];
    for (const row of rows.slice(1)) {
      const name = row[colIndex.name]?.trim();
      const matchText = row[colIndex.matchText]?.trim();
      if (!name || !matchText) continue;
      const matchMode = row[colIndex.matchMode]?.trim() || "CONTAINS";
      const accountCode = row[colIndex.accountCode]?.trim();
      const minAmountRaw = row[colIndex.minAmount]?.trim();
      const maxAmountRaw = row[colIndex.maxAmount]?.trim();
      const toleranceRaw = row[colIndex.amountTolerance]?.trim();
      const priorityRaw = row[colIndex.priority]?.trim();
      const isActiveRaw = row[colIndex.isActive]?.trim();

      const minAmount = minAmountRaw ? Number(minAmountRaw) : null;
      const maxAmount = maxAmountRaw ? Number(maxAmountRaw) : null;
      const amountTolerance = toleranceRaw ? Number(toleranceRaw) : 0;
      const priority = priorityRaw ? Number(priorityRaw) : 0;
      const isActive = isActiveRaw ? isActiveRaw.toLowerCase() !== "false" : true;

      const accountId = accountCode ? accountByCode.get(accountCode) || null : null;

      const rule = await prisma.bankMatchRule.create({
        data: {
          bankAccountId: params.id,
          name,
          matchText,
          matchMode: matchMode as "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "REGEX",
          accountId,
          minAmount: Number.isFinite(minAmount as number) ? minAmount : null,
          maxAmount: Number.isFinite(maxAmount as number) ? maxAmount : null,
          amountTolerance: Number.isFinite(amountTolerance) ? amountTolerance : 0,
          priority: Number.isFinite(priority) ? priority : 0,
          isActive,
        },
      });
      created.push(rule.id);
    }

    await recordAccountingBankAudit({
      req,
      actor,
      action: "BANK_RULE_IMPORT",
      entityType: "BANK_MATCH_RULE",
      entityId: params.id,
      section: "rules",
      operation: "import_csv",
      resultSummary: `Imported ${created.length} bank match rule(s).`,
      meta: {
        bankAccountId: params.id,
        imported: created.length,
        importedRuleIds: created,
        sourceRows: Math.max(0, rows.length - 1),
      },
    });
    return NextResponse.json({ imported: created.length });
  } catch (error) {
    console.error("Accounting bank match rule import error:", error);
    return NextResponse.json({ error: "Failed to import rules" }, { status: 500 });
  }
}
