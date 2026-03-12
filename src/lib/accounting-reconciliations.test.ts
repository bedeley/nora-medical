import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReconciliationListQuery,
  isPrismaUniqueConstraintError,
  normalizeReconciliationPeriodInput,
  parseReconciliationListParams,
  pickSelectedReconciliationId,
} from "@/lib/accounting-reconciliations";

test("normalizeReconciliationPeriodInput builds UTC day boundaries", () => {
  const range = normalizeReconciliationPeriodInput("2026-03-01", "2026-03-31");
  assert.ok(range);
  assert.equal(range?.periodStart.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(range?.periodEnd.toISOString(), "2026-03-31T23:59:59.999Z");
});

test("normalizeReconciliationPeriodInput rejects invalid order", () => {
  const range = normalizeReconciliationPeriodInput("2026-03-31", "2026-03-01");
  assert.equal(range, null);
});

test("parseReconciliationListParams clamps paging and normalizes filters", () => {
  const params = new URLSearchParams({
    assignedToId: "user_1",
    status: "IN_PROGRESS",
    q: "  ecobank ",
    page: "-4",
    pageSize: "1000",
    periodStartFrom: "2026-02-01",
    periodEndTo: "bad",
    sort: "statementBalance_desc",
    minOpenAgeDays: "12",
    pageMode: "cursor",
    cursor: "rec_123",
  });
  const parsed = parseReconciliationListParams(params);
  assert.equal(parsed.status, "IN_PROGRESS");
  assert.equal(parsed.assignedToId, "user_1");
  assert.equal(parsed.q, "ecobank");
  assert.equal(parsed.page, 1);
  assert.equal(parsed.pageSize, 100);
  assert.equal(parsed.periodStartFrom, "2026-02-01");
  assert.equal(parsed.periodEndTo, undefined);
  assert.equal(parsed.sort, "statementBalance_desc");
  assert.equal(parsed.minOpenAgeDays, 12);
  assert.equal(parsed.pageMode, "cursor");
  assert.equal(parsed.cursor, "rec_123");
});

test("buildReconciliationListQuery keeps URL state shareable", () => {
  const query = buildReconciliationListQuery({
    bankAccountId: "bank_1",
    assignedToId: "user_1",
    status: "IN_PROGRESS",
    q: "ecobank",
    periodStartFrom: "2026-01-01",
    periodEndTo: "2026-01-31",
    minOpenAgeDays: 7,
    sort: "createdAt_asc",
    pageMode: "cursor",
    cursor: "rec_123",
    page: 2,
    pageSize: 20,
  });
  assert.equal(
    query,
    "bankAccountId=bank_1&assignedToId=user_1&status=IN_PROGRESS&q=ecobank&periodStartFrom=2026-01-01&periodEndTo=2026-01-31&minOpenAgeDays=7&sort=createdAt_asc&pageMode=cursor&cursor=rec_123&page=2&pageSize=20",
  );
});

test("pickSelectedReconciliationId falls back to first row", () => {
  const items = [{ id: "a" }, { id: "b" }];
  assert.equal(pickSelectedReconciliationId("b", items), "b");
  assert.equal(pickSelectedReconciliationId("missing", items), "a");
  assert.equal(pickSelectedReconciliationId("", items), "a");
  assert.equal(pickSelectedReconciliationId("x", []), "");
});

test("isPrismaUniqueConstraintError identifies duplicate conflict", () => {
  assert.equal(isPrismaUniqueConstraintError({ code: "P2002" }), true);
  assert.equal(isPrismaUniqueConstraintError({ code: "P2025" }), false);
  assert.equal(isPrismaUniqueConstraintError(new Error("x")), false);
});
