import type { Prisma } from "@prisma/client";

export const COMPENSATION_STATUSES = ["DRAFT", "PENDING", "ACTIVE"] as const;
export type CompensationStatus = (typeof COMPENSATION_STATUSES)[number];
export type CompensationStatusFilter = CompensationStatus | "ALL";

export type CompensationQueryState = {
  employeeId: string | null;
  status: CompensationStatusFilter;
  search: string | null;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LEN = 80;

function cleanText(value: string | null | undefined) {
  return String(value || "").trim();
}

function normalizePage(raw: string | null | undefined) {
  const parsed = Number.parseInt(cleanText(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE;
  return parsed;
}

function normalizePageSize(raw: string | null | undefined) {
  const parsed = Number.parseInt(cleanText(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, parsed);
}

export function normalizeCompensationStatusFilter(
  raw: string | null | undefined,
): CompensationStatusFilter {
  const upper = cleanText(raw).toUpperCase();
  return COMPENSATION_STATUSES.includes(upper as CompensationStatus)
    ? (upper as CompensationStatus)
    : "ALL";
}

export function normalizeCompensationSearch(raw: string | null | undefined) {
  const compact = cleanText(raw).replace(/\s+/g, " ");
  if (!compact) return null;
  return compact.slice(0, MAX_SEARCH_LEN);
}

export function normalizeCompensationQueryState(searchParams: URLSearchParams): CompensationQueryState {
  const employeeIdRaw = cleanText(searchParams.get("employeeId"));
  const employeeId = employeeIdRaw || null;
  const status = normalizeCompensationStatusFilter(searchParams.get("status"));
  const search = normalizeCompensationSearch(searchParams.get("search"));
  const page = normalizePage(searchParams.get("page"));
  const pageSize = normalizePageSize(searchParams.get("pageSize"));
  const skip = (page - 1) * pageSize;
  return { employeeId, status, search, page, pageSize, skip, take: pageSize };
}

export function buildCompensationWhereClause(
  query: Pick<CompensationQueryState, "employeeId" | "status" | "search">,
): Prisma.CompensationWhereInput {
  const filters: Prisma.CompensationWhereInput[] = [];
  if (query.employeeId) filters.push({ employeeId: query.employeeId });
  if (query.status !== "ALL") filters.push({ status: query.status });
  if (query.search) {
    filters.push({
      OR: [
        { employeeId: { contains: query.search, mode: "insensitive" } },
        { employee: { firstName: { contains: query.search, mode: "insensitive" } } },
        { employee: { lastName: { contains: query.search, mode: "insensitive" } } },
        { employee: { email: { contains: query.search, mode: "insensitive" } } },
      ],
    });
  }
  if (filters.length === 0) return {};
  return { AND: filters };
}

type BulkBeforeRow = { id: string; status: CompensationStatus };
type BulkSummaryInput = {
  requestedIds: string[];
  beforeRows: BulkBeforeRow[];
  approvedIds: string[];
};

export function summarizeBulkApproveSkipReasons(input: BulkSummaryInput) {
  const beforeById = new Map(input.beforeRows.map((row) => [row.id, row]));
  const approvedSet = new Set(input.approvedIds);
  const skippedIds = input.requestedIds.filter((id) => !approvedSet.has(id));
  const notFoundIds = skippedIds.filter((id) => !beforeById.has(id));
  const notPendingRows = skippedIds
    .map((id) => beforeById.get(id))
    .filter((row): row is BulkBeforeRow => Boolean(row))
    .filter((row) => row.status !== "PENDING");
  return {
    skippedIds,
    notFoundIds,
    notPendingIds: notPendingRows.map((row) => row.id),
    alreadyActiveIds: notPendingRows.filter((row) => row.status === "ACTIVE").map((row) => row.id),
    alreadyDraftIds: notPendingRows.filter((row) => row.status === "DRAFT").map((row) => row.id),
  };
}
