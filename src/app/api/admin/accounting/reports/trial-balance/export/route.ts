import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import crypto from "node:crypto";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";
import { loadAccountTotals, parseDateRange } from "../../utils";
import {
  buildTrialBalanceExportAuditMeta,
  resolveTrialBalanceDateRange,
} from "@/lib/trial-balance-report-utils";

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

const MAX_EXPORT_ROWS = 5000;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const includeZero = searchParams.get("includeZero") === "1";
  const fromJob = searchParams.get("job") === "1";
  const limited = await rateLimit(req, "admin-accounting-trial-balance-export-csv", 60_000, fromJob ? 180 : 40);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many export requests. Please wait and retry." }, { status: 429 });
  }
  const correlationId = String(searchParams.get("correlationId") || "").trim() || null;
  const parsedRange = resolveTrialBalanceDateRange(start, end);
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 });
  }

  const openingEnd = parsedRange.start
    ? new Date(new Date(`${parsedRange.start}T00:00:00`).getTime() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
    : null;

  const [openingTotals, movementTotals, closingTotals, allAccounts] = await Promise.all([
    openingEnd ? loadAccountTotals(parseDateRange(null, openingEnd)) : Promise.resolve([]),
    loadAccountTotals(parseDateRange(parsedRange.start, parsedRange.end)),
    loadAccountTotals(parseDateRange(null, parsedRange.end)),
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
  const allAccountsMap = includeZero ? new Map(allAccounts.map((row) => [row.id, row])) : null;
  const accountIds = includeZero
    ? allAccounts.map((row) => row.id)
    : Array.from(new Set([...openingMap.keys(), ...movementMap.keys(), ...closingMap.keys()]));

  const totals = accountIds
    .map((accountId) => {
      const opening = openingMap.get(accountId);
      const movement = movementMap.get(accountId);
      const closing = closingMap.get(accountId);
      const base = opening || movement || closing;
      const account = includeZero ? allAccountsMap?.get(accountId) || null : null;
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
  if (totals.length + 1 > MAX_EXPORT_ROWS) {
    return NextResponse.json(
      { error: `Export is too large (${totals.length + 1} rows). Narrow the date range before exporting.` },
      { status: 413 },
    );
  }

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
  const integrityRowCount = rows.length + 1;
  const checksumSha256 = crypto.createHash("sha256").update(csv, "utf8").digest("hex");

  const filename = `trial-balance${parsedRange.start || parsedRange.end ? `-${parsedRange.start || "start"}-${parsedRange.end || "end"}` : ""}.csv`;
  const byteSize = Buffer.byteLength(csv, "utf8");
  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.trial-balance.csv",
    entityType: "AccountingReport",
    entityId: "trial-balance",
    meta: buildTrialBalanceExportAuditMeta({
      correlationId,
      includeZero,
      inputStart: start || null,
      inputEnd: end || null,
      effectiveStart: parsedRange.start,
      effectiveEnd: parsedRange.end,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
      rowCount: rows.length,
      integrityRowCount,
      checksumSha256,
      fileName: filename,
      columnCount: header.length,
      byteSize,
    }),
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Export-Row-Count": String(integrityRowCount),
    "X-Export-Checksum-Sha256": checksumSha256,
  };
  if (correlationId) {
    headers["X-Report-Correlation-Id"] = correlationId;
  }
  return new NextResponse(csv, {
    headers,
  });
}
