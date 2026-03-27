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

function normalizeDateInput(value: string | null | undefined, label: "Start" | "End") {
  const candidate = String(value || "").trim();
  if (!candidate) return { ok: true as const, value: null };
  if (!isValidDateOnly(candidate)) {
    return { ok: false as const, error: `${label} date is invalid. Use YYYY-MM-DD.` };
  }
  return { ok: true as const, value: candidate };
}

export function resolveTrialBalanceDateRange(rawStart: string | null | undefined, rawEnd: string | null | undefined) {
  const start = normalizeDateInput(rawStart, "Start");
  if (!start.ok) return start;
  const end = normalizeDateInput(rawEnd, "End");
  if (!end.ok) return end;
  if (start.value && end.value && end.value < start.value) {
    return { ok: false as const, error: "End date cannot be earlier than start date." };
  }
  return {
    ok: true as const,
    start: start.value,
    end: end.value,
  };
}

type BuildTrialBalanceExportAuditMetaInput = {
  correlationId: string | null;
  includeZero: boolean;
  inputStart: string | null;
  inputEnd: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  actorRole: string | null;
  actorEmail: string | null;
  rowCount: number;
  integrityRowCount: number;
  checksumSha256: string;
  fileName: string;
  columnCount: number;
  byteSize: number;
};

export function buildTrialBalanceExportAuditMeta(input: BuildTrialBalanceExportAuditMetaInput) {
  return {
    sourcePage: "admin/accounting/reports/trial-balance",
    section: "trial-balance",
    operation: "export_csv",
    exportLabel: "Trial balance CSV",
    correlationId: input.correlationId,
    includeZero: input.includeZero,
    before: {
      start: input.inputStart,
      end: input.inputEnd,
    },
    after: {
      start: input.effectiveStart,
      end: input.effectiveEnd,
    },
    format: "csv",
    fileName: input.fileName,
    rowCount: input.rowCount,
    columnCount: input.columnCount,
    byteSize: input.byteSize,
    resultSummary: "Export completed successfully.",
    status: "SUCCESS",
    integrity: {
      rowCount: input.integrityRowCount,
      checksumSha256: input.checksumSha256,
    },
    actorRole: input.actorRole,
    actorEmail: input.actorEmail,
    generatedAt: new Date().toISOString(),
  };
}
