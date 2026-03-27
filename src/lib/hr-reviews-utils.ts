export type ReviewRating =
  | "EXCEEDS"
  | "MEETS"
  | "NEEDS_IMPROVEMENT"
  | "UNSATISFACTORY";

export type ReviewsSort = "periodEnd_desc" | "periodEnd_asc" | "rating_asc" | "rating_desc";

const RATING_SORT_ORDER: ReviewRating[] = [
  "UNSATISFACTORY",
  "NEEDS_IMPROVEMENT",
  "MEETS",
  "EXCEEDS",
];

export function normalizeReviewDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function validateReviewPeriod(start: Date, end: Date): string | null {
  if (end.getTime() < start.getTime()) {
    return "Period end must be on or after period start.";
  }
  return null;
}

export function periodsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}

export function normalizeReviewsSort(input: string | null | undefined): ReviewsSort {
  const raw = String(input || "").trim();
  if (
    raw === "periodEnd_desc" ||
    raw === "periodEnd_asc" ||
    raw === "rating_asc" ||
    raw === "rating_desc"
  ) {
    return raw;
  }
  return "periodEnd_desc";
}

export function compareReviewRatings(
  left: ReviewRating,
  right: ReviewRating,
  direction: "asc" | "desc",
) {
  const leftIndex = RATING_SORT_ORDER.indexOf(left);
  const rightIndex = RATING_SORT_ORDER.indexOf(right);
  const delta = leftIndex - rightIndex;
  return direction === "asc" ? delta : -delta;
}

export function normalizeReviewsPaging(
  pageRaw: string | null | undefined,
  pageSizeRaw: string | null | undefined,
) {
  const page = Math.max(1, Number.parseInt(String(pageRaw || "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(pageSizeRaw || "25"), 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
