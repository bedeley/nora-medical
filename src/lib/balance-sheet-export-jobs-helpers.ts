export type BalanceSheetExportJobType = "balance_sheet_csv" | "balance_sheet_pdf" | "reporting_pack_csv";
export type BalanceSheetExportSortBy = "code" | "name" | "balance";
export type BalanceSheetExportSortDir = "asc" | "desc";

export function isBalanceSheetExportRoleAuthorized(role: string | null | undefined) {
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export function normalizeBalanceSheetExportSortBy(value: unknown): BalanceSheetExportSortBy {
  const key = String(value || "").trim().toLowerCase();
  if (key === "name" || key === "balance") return key;
  return "code";
}

export function normalizeBalanceSheetExportSortDir(value: unknown): BalanceSheetExportSortDir {
  return String(value || "").trim().toLowerCase() === "desc" ? "desc" : "asc";
}

export function normalizeBalanceSheetExportJobType(value: unknown): BalanceSheetExportJobType | null {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "balance_sheet_csv" || raw === "balance_sheet_pdf" || raw === "reporting_pack_csv") {
    return raw;
  }
  return null;
}

export function resolveBalanceSheetQueueGuardError(input: {
  hasSession: boolean;
  sameOrigin: boolean;
  rateLimitOk: boolean;
}) {
  if (!input.hasSession) return { status: 401 as const, error: "Unauthorized" };
  if (!input.sameOrigin) return { status: 403 as const, error: "Bad origin" };
  if (!input.rateLimitOk) return { status: 429 as const, error: "Too many requests" };
  return null;
}

export function parseFileNameFromContentDisposition(value: string | null) {
  const text = String(value || "");
  const quoted = /filename="([^"]+)"/i.exec(text);
  if (quoted?.[1]) return quoted[1];
  const plain = /filename=([^;]+)/i.exec(text);
  if (plain?.[1]) return plain[1].trim();
  return null;
}

export function isBalanceSheetExportJobExpired(expiresAt: number, nowMs: number) {
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}
