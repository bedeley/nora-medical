import test from "node:test";
import assert from "node:assert/strict";
import { buildRetryTargets, explainPostingFailure, summarizeAgingBuckets } from "@/lib/accounting-integrity";

test("buildRetryTargets respects pinned source", () => {
  const items = {
    orders: [{ id: "o1", createdAt: "2026-03-10T00:00:00.000Z" }],
    payments: [{ id: "p1", createdAt: "2026-03-10T00:00:00.000Z" }],
    expenses: [{ id: "e1", createdAt: "2026-03-10T00:00:00.000Z" }],
  };
  const all = buildRetryTargets(items, "all");
  assert.equal(all.length, 3);
  const payments = buildRetryTargets(items, "payments");
  assert.equal(payments.length, 1);
  assert.equal(payments[0]?.entityType, "PAYMENT");
  assert.equal(payments[0]?.entityId, "p1");
});

test("summarizeAgingBuckets classifies fresh warning overdue", () => {
  const nowMs = new Date("2026-03-15T00:00:00.000Z").getTime();
  const rows = [
    { createdAt: "2026-03-14T00:00:00.000Z" }, // fresh
    { createdAt: "2026-03-11T00:00:00.000Z" }, // warning at 4d
    { createdAt: "2026-03-01T00:00:00.000Z" }, // overdue
  ];
  const result = summarizeAgingBuckets(rows, nowMs, 3, 8);
  assert.deepEqual(result, { fresh: 1, warning: 1, overdue: 1 });
});

test("explainPostingFailure maps common causes", () => {
  const closed = explainPostingFailure({ reason: "period_closed" });
  assert.equal(closed.reason, "Period is closed");
  const mapping = explainPostingFailure({ reason: "missing_account_mapping" });
  assert.equal(mapping.reason, "Missing account mapping");
  const generic = explainPostingFailure({ reason: "mystery" });
  assert.equal(generic.reason, "Posting failed");
});
