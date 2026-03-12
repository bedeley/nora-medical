import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReconciliationListQuery,
  isDuplicateReconciliation,
  parseReconciliationListParams,
  pickSelectedReconciliationId,
} from "@/lib/accounting-reconciliations";

type Rec = {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
};

test("reconciliation list flow: create guard -> filter URL -> selection fallback", () => {
  const items: Rec[] = [
    {
      id: "rec_old",
      bankAccountId: "bank_1",
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-02-28T23:59:59.999Z",
    },
    {
      id: "rec_new",
      bankAccountId: "bank_1",
      periodStart: "2026-03-01T00:00:00.000Z",
      periodEnd: "2026-03-31T23:59:59.999Z",
    },
  ];

  const duplicate = isDuplicateReconciliation(items, "bank_1", "2026-03-01", "2026-03-31");
  assert.equal(duplicate?.id, "rec_new");

  const query = buildReconciliationListQuery({
    bankAccountId: "bank_1",
    assignedToId: "user_1",
    status: "IN_PROGRESS",
    q: "ecobank",
    periodStartFrom: "2026-01-01",
    periodEndTo: "2026-12-31",
    minOpenAgeDays: 7,
    sort: "createdAt_asc",
    pageMode: "cursor",
    cursor: "rec_old",
    page: 1,
    pageSize: 20,
  });
  const parsed = parseReconciliationListParams(new URLSearchParams(query));
  assert.equal(parsed.bankAccountId, "bank_1");
  assert.equal(parsed.assignedToId, "user_1");
  assert.equal(parsed.status, "IN_PROGRESS");
  assert.equal(parsed.q, "ecobank");
  assert.equal(parsed.minOpenAgeDays, 7);
  assert.equal(parsed.sort, "createdAt_asc");
  assert.equal(parsed.pageMode, "cursor");
  assert.equal(parsed.cursor, "rec_old");

  assert.equal(pickSelectedReconciliationId("missing", items), "rec_old");
  assert.equal(pickSelectedReconciliationId("rec_new", items), "rec_new");
});
