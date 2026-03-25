import assert from "node:assert/strict";
import test from "node:test";
import { normalizePeriodActivityFilters } from "@/lib/accounting-period-activity-query";

test("normalizePeriodActivityFilters keeps known action and trims actor", () => {
  const result = normalizePeriodActivityFilters({
    action: "fiscal-month.close",
    actor: "  nora admin  ",
    from: null,
    to: null,
    daysBack: 90,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.filters.action, "fiscal-month.close");
  assert.equal(result.filters.actor, "nora admin");
});

test("normalizePeriodActivityFilters ignores unknown action", () => {
  const result = normalizePeriodActivityFilters({
    action: "unknown.action",
    actor: "",
    from: null,
    to: null,
    daysBack: 90,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.filters.action, null);
});

test("normalizePeriodActivityFilters rejects invalid date order", () => {
  const result = normalizePeriodActivityFilters({
    action: null,
    actor: null,
    from: "2026-03-24",
    to: "2026-03-01",
    daysBack: 90,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "From date cannot be after to date.");
});
