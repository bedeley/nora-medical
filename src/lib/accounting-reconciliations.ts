const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ReconciliationStatusFilter = "all" | "DRAFT" | "IN_PROGRESS" | "CLOSED";

export type ReconciliationListParams = {
  bankAccountId?: string;
  assignedToId?: string;
  status: ReconciliationStatusFilter;
  q?: string;
  periodStartFrom?: string;
  periodEndTo?: string;
  minOpenAgeDays?: number;
  sort: ReconciliationSortOption;
  pageMode: "offset" | "cursor";
  cursor?: string;
  page: number;
  pageSize: number;
};

export const DEFAULT_RECON_PAGE_SIZE = 20;
export const MAX_RECON_PAGE_SIZE = 100;
export type ReconciliationSortOption =
  | "periodEnd_desc"
  | "periodEnd_asc"
  | "updatedAt_desc"
  | "statementBalance_desc"
  | "createdAt_asc";

export function parseReconciliationSort(value: string | null | undefined): ReconciliationSortOption {
  if (
    value === "periodEnd_desc" ||
    value === "periodEnd_asc" ||
    value === "updatedAt_desc" ||
    value === "statementBalance_desc" ||
    value === "createdAt_asc"
  ) {
    return value;
  }
  return "periodEnd_desc";
}

export function parsePositiveInt(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function clampPageSize(pageSize: number) {
  if (!Number.isFinite(pageSize) || pageSize <= 0) return DEFAULT_RECON_PAGE_SIZE;
  return Math.min(MAX_RECON_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

export function parseReconciliationStatusFilter(value: string | null | undefined): ReconciliationStatusFilter {
  if (value === "DRAFT" || value === "IN_PROGRESS" || value === "CLOSED") return value;
  return "all";
}

export function parseReconciliationListParams(searchParams: URLSearchParams): ReconciliationListParams {
  const status = parseReconciliationStatusFilter(searchParams.get("status"));
  const q = (searchParams.get("q") || "").trim();
  const periodStartFrom = (searchParams.get("periodStartFrom") || "").trim();
  const periodEndTo = (searchParams.get("periodEndTo") || "").trim();
  return {
    bankAccountId: (searchParams.get("bankAccountId") || "").trim() || undefined,
    assignedToId: (searchParams.get("assignedToId") || "").trim() || undefined,
    status,
    q: q || undefined,
    periodStartFrom: isYmd(periodStartFrom) ? periodStartFrom : undefined,
    periodEndTo: isYmd(periodEndTo) ? periodEndTo : undefined,
    minOpenAgeDays: parsePositiveInt(searchParams.get("minOpenAgeDays"), 0) || undefined,
    sort: parseReconciliationSort(searchParams.get("sort")),
    pageMode: searchParams.get("pageMode") === "cursor" ? "cursor" : "offset",
    cursor: (searchParams.get("cursor") || "").trim() || undefined,
    page: parsePositiveInt(searchParams.get("page"), 1),
    pageSize: clampPageSize(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_RECON_PAGE_SIZE)),
  };
}

export function buildReconciliationListQuery(params: ReconciliationListParams) {
  const p = new URLSearchParams();
  if (params.bankAccountId) p.set("bankAccountId", params.bankAccountId);
  if (params.assignedToId) p.set("assignedToId", params.assignedToId);
  if (params.status !== "all") p.set("status", params.status);
  if (params.q) p.set("q", params.q);
  if (params.periodStartFrom) p.set("periodStartFrom", params.periodStartFrom);
  if (params.periodEndTo) p.set("periodEndTo", params.periodEndTo);
  if (params.minOpenAgeDays && params.minOpenAgeDays > 0) p.set("minOpenAgeDays", String(params.minOpenAgeDays));
  if (params.sort !== "periodEnd_desc") p.set("sort", params.sort);
  if (params.pageMode === "cursor") p.set("pageMode", "cursor");
  if (params.cursor) p.set("cursor", params.cursor);
  p.set("page", String(params.page));
  p.set("pageSize", String(params.pageSize));
  return p.toString();
}

export function pickSelectedReconciliationId<T extends { id: string }>(
  currentId: string,
  items: T[],
) {
  if (!Array.isArray(items) || items.length === 0) return "";
  if (currentId && items.some((item) => item.id === currentId)) return currentId;
  return items[0].id;
}

export function isDuplicateReconciliation<T extends { bankAccountId: string; periodStart: string; periodEnd: string }>(
  items: T[],
  bankAccountId: string,
  periodStartYmd: string,
  periodEndYmd: string,
) {
  return items.find(
    (rec) =>
      rec.bankAccountId === bankAccountId &&
      rec.periodStart.slice(0, 10) === periodStartYmd &&
      rec.periodEnd.slice(0, 10) === periodEndYmd,
  );
}

export function isYmd(value: string) {
  return YMD_RE.test(value);
}

export function toAccraUtcStartOfDay(ymd: string) {
  if (!isYmd(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function toAccraUtcEndOfDay(ymd: string) {
  if (!isYmd(ymd)) return null;
  const d = new Date(`${ymd}T23:59:59.999Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function normalizeReconciliationPeriodInput(periodStartYmd: string, periodEndYmd: string) {
  const start = toAccraUtcStartOfDay(String(periodStartYmd || "").trim());
  const end = toAccraUtcEndOfDay(String(periodEndYmd || "").trim());
  if (!start || !end) return null;
  if (start.getTime() > end.getTime()) return null;
  return { periodStart: start, periodEnd: end };
}

export function isPrismaUniqueConstraintError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if (!("code" in error)) return false;
  return (error as { code?: string }).code === "P2002";
}
