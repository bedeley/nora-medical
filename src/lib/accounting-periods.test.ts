import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFiscalPeriodDateRange } from "@/lib/accounting-periods";

test("normalizeFiscalPeriodDateRange builds UTC day boundaries", () => {
  const result = normalizeFiscalPeriodDateRange("2026-03-01", "2026-03-31");
  assert.ok(!("error" in result));
  if ("error" in result) return;
  assert.equal(result.start.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(result.end.toISOString(), "2026-03-31T23:59:59.999Z");
});

test("normalizeFiscalPeriodDateRange rejects invalid date text", () => {
  const result = normalizeFiscalPeriodDateRange("2026-02-30", "2026-03-31");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error, "Use date format YYYY-MM-DD.");
});

test("normalizeFiscalPeriodDateRange rejects inverted ranges", () => {
  const result = normalizeFiscalPeriodDateRange("2026-04-01", "2026-03-31");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error, "Start date must be before end date.");
});
