import test from "node:test";
import assert from "node:assert/strict";
import {
  compareReviewRatings,
  normalizeReviewDate,
  normalizeReviewsPaging,
  normalizeReviewsSort,
  periodsOverlap,
  validateReviewPeriod,
} from "@/lib/hr-reviews-utils";

test("normalizeReviewDate parses valid and rejects invalid", () => {
  assert.equal(Boolean(normalizeReviewDate("2026-03-01")), true);
  assert.equal(normalizeReviewDate("not-a-date"), null);
  assert.equal(normalizeReviewDate(""), null);
});

test("validateReviewPeriod rejects inverted range", () => {
  const start = new Date("2026-03-02T00:00:00.000Z");
  const end = new Date("2026-03-01T00:00:00.000Z");
  assert.equal(validateReviewPeriod(start, end), "Period end must be on or after period start.");
  assert.equal(validateReviewPeriod(end, start), null);
});

test("periodsOverlap handles touching and separated ranges", () => {
  const aStart = new Date("2026-01-01T00:00:00.000Z");
  const aEnd = new Date("2026-01-31T00:00:00.000Z");
  const bStart = new Date("2026-01-31T00:00:00.000Z");
  const bEnd = new Date("2026-02-28T00:00:00.000Z");
  const cStart = new Date("2026-02-01T00:00:00.000Z");
  const cEnd = new Date("2026-02-28T00:00:00.000Z");
  assert.equal(periodsOverlap(aStart, aEnd, bStart, bEnd), true);
  assert.equal(periodsOverlap(aStart, aEnd, cStart, cEnd), false);
});

test("normalizeReviewsSort defaults safely", () => {
  assert.equal(normalizeReviewsSort("rating_asc"), "rating_asc");
  assert.equal(normalizeReviewsSort("bad-value"), "periodEnd_desc");
  assert.equal(normalizeReviewsSort(undefined), "periodEnd_desc");
});

test("compareReviewRatings follows business order", () => {
  assert.equal(compareReviewRatings("UNSATISFACTORY", "MEETS", "asc") < 0, true);
  assert.equal(compareReviewRatings("EXCEEDS", "MEETS", "desc") < 0, true);
});

test("normalizeReviewsPaging clamps values", () => {
  const paging = normalizeReviewsPaging("0", "500");
  assert.equal(paging.page, 1);
  assert.equal(paging.pageSize, 100);
  assert.equal(paging.skip, 0);
  assert.equal(paging.take, 100);
});
