export type ReportExportJobRow = {
  key: string;
  value: unknown;
  fallbackCreatedAtMs?: number;
};

export function getJobExpiresAt(value: unknown) {
  const raw = (value as Record<string, unknown> | null)?.expiresAt;
  const parsed = Number(raw || 0);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function getJobCreatedAt(value: unknown, fallbackCreatedAtMs = 0) {
  const raw = (value as Record<string, unknown> | null)?.createdAt;
  const parsed = Number(raw || fallbackCreatedAtMs || 0);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

export function collectExpiredJobKeys(rows: ReportExportJobRow[], nowMs: number) {
  return rows
    .filter((row) => {
      const expiresAt = getJobExpiresAt(row.value);
      return typeof expiresAt === "number" && expiresAt <= nowMs;
    })
    .map((row) => row.key);
}

export function collectOverflowJobKeys(rows: ReportExportJobRow[], nowMs: number, keepCount: number) {
  if (!Number.isFinite(keepCount) || keepCount < 1) return [];
  const activeRows = rows
    .filter((row) => {
      const expiresAt = getJobExpiresAt(row.value);
      return typeof expiresAt === "number" && expiresAt > nowMs;
    })
    .sort((a, b) => getJobCreatedAt(b.value, b.fallbackCreatedAtMs) - getJobCreatedAt(a.value, a.fallbackCreatedAtMs));
  if (activeRows.length <= keepCount) return [];
  return activeRows.slice(keepCount).map((row) => row.key);
}

export function normalizeFailureSimulationInput(input: unknown) {
  const body = (input || {}) as Record<string, unknown>;
  const action = String(body.action || "").trim();
  if (action !== "simulate_failure") {
    return { ok: false as const, error: "Unsupported action." };
  }
  const failReasonRaw = typeof body.failReason === "string" ? body.failReason : "";
  const failReason = failReasonRaw.trim() || "Simulated failure for testing.";
  return { ok: true as const, failReason };
}
