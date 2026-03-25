export const JOURNAL_IDS_ONLY_MAX = 2000;

const STATUS_RANK: Record<string, number> = {
  DRAFT: 0,
  POSTED: 1,
  VOID: 2,
};

export function normalizeJournalSearchQuery(raw: string) {
  const q = String(raw || "").trim();
  if (q.length > 120) {
    return {
      ok: false as const,
      error: "Search text is too long. Please use 120 characters or fewer.",
    };
  }
  return { ok: true as const, q };
}

export function compareJournalStatus(
  a: { status?: string; entryDate?: Date; createdAt?: Date },
  b: { status?: string; entryDate?: Date; createdAt?: Date },
  dir: "asc" | "desc",
) {
  const rankA = STATUS_RANK[String(a.status || "").toUpperCase()] ?? 999;
  const rankB = STATUS_RANK[String(b.status || "").toUpperCase()] ?? 999;
  if (rankA !== rankB) return dir === "asc" ? rankA - rankB : rankB - rankA;
  const entryA = a.entryDate ? a.entryDate.getTime() : 0;
  const entryB = b.entryDate ? b.entryDate.getTime() : 0;
  if (entryA !== entryB) return entryB - entryA;
  const createdA = a.createdAt ? a.createdAt.getTime() : 0;
  const createdB = b.createdAt ? b.createdAt.getTime() : 0;
  return createdB - createdA;
}

export function applyIdsOnlyCap(ids: string[], cap: number = JOURNAL_IDS_ONLY_MAX) {
  const normalizedCap = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : JOURNAL_IDS_ONLY_MAX;
  const truncated = ids.length > normalizedCap;
  return {
    ids: truncated ? ids.slice(0, normalizedCap) : ids,
    total: ids.length,
    truncated,
    max: normalizedCap,
  };
}

