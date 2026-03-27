import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompensationWhereClause,
  normalizeCompensationQueryState,
  summarizeBulkApproveSkipReasons,
} from "@/lib/hr-compensation-utils";

test("hr compensation list endpoint normalizes paging and filters", () => {
  const params = new URLSearchParams({
    status: "pending",
    search: "  Nora   Admin  ",
    page: "3",
    pageSize: "250",
  });
  const query = normalizeCompensationQueryState(params);
  assert.equal(query.status, "PENDING");
  assert.equal(query.search, "Nora Admin");
  assert.equal(query.page, 3);
  assert.equal(query.pageSize, 100);
  assert.equal(query.skip, 200);
  assert.equal(query.take, 100);
});

test("hr compensation list endpoint builds where clause for status and search", () => {
  const where = buildCompensationWhereClause({
    employeeId: null,
    status: "ACTIVE",
    search: "bedeley",
  });
  assert.ok(where);
  assert.ok(Array.isArray((where as { AND?: unknown[] }).AND));
  const andFilters = (where as { AND?: unknown[] }).AND || [];
  assert.equal(andFilters.length, 2);
});

test("hr compensation bulk approve endpoint reports skip reasons", () => {
  const summary = summarizeBulkApproveSkipReasons({
    requestedIds: ["a", "b", "c", "d"],
    beforeRows: [
      { id: "a", status: "PENDING" },
      { id: "b", status: "ACTIVE" },
      { id: "c", status: "DRAFT" },
    ],
    approvedIds: ["a"],
  });
  assert.deepEqual(summary.skippedIds, ["b", "c", "d"]);
  assert.deepEqual(summary.notFoundIds, ["d"]);
  assert.deepEqual(summary.alreadyActiveIds, ["b"]);
  assert.deepEqual(summary.alreadyDraftIds, ["c"]);
});
