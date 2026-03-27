const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value: string) {
  if (!YMD_RE.test(value)) return false;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function resolveBalanceSheetAsOf(rawAsOf: string | null | undefined, defaultAsOf: string) {
  const candidate = String(rawAsOf || "").trim() || defaultAsOf;
  if (!isValidDateOnly(candidate)) {
    return {
      ok: false as const,
      error: "As-of date is invalid. Use YYYY-MM-DD.",
    };
  }
  return { ok: true as const, asOf: candidate };
}

type BuildBalanceSheetExportAuditMetaInput = {
  correlationId: string | null;
  inputAsOf: string | null;
  effectiveAsOf: string;
  actorRole: string | null;
  actorEmail: string | null;
  assetsRowCount: number;
  liabilitiesRowCount: number;
  equityRowCount: number;
  totalRowCount: number;
  integrityRowCount?: number;
  checksumSha256?: string | null;
  format?: "csv" | "pdf";
};

export function buildBalanceSheetExportAuditMeta(input: BuildBalanceSheetExportAuditMetaInput) {
  const format = input.format === "pdf" ? "pdf" : "csv";
  return {
    sourcePage: "admin/accounting/reports/balance-sheet",
    section: "exports",
    operation: format === "pdf" ? "export_pdf" : "export_csv",
    correlationId: input.correlationId,
    before: {
      asOf: input.inputAsOf,
    },
    after: {
      asOf: input.effectiveAsOf,
    },
    report: "balance-sheet",
    format,
    basis: "accrual",
    generatedAt: new Date().toISOString(),
    actorRole: input.actorRole,
    actorEmail: input.actorEmail,
    assetsRowCount: input.assetsRowCount,
    liabilitiesRowCount: input.liabilitiesRowCount,
    equityRowCount: input.equityRowCount,
    totalRowCount: input.totalRowCount,
    integrity: {
      rowCount: input.integrityRowCount ?? null,
      checksumSha256: input.checksumSha256 ?? null,
    },
  };
}
