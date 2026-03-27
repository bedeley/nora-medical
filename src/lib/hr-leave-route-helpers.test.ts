import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLeaveListFilters,
  validateDecisionNoteForStatus,
  validateExpectedUpdatedAtConflict,
} from "@/lib/hr-leave-route-helpers";

test("leave route helpers normalize activeToday filter and force approved date window", () => {
  const params = new URLSearchParams({
    status: "REQUESTED",
    activeToday: "1",
    page: "2",
    pageSize: "25",
  });
  const now = new Date("2026-03-26T12:00:00.000Z");
  const normalized = normalizeLeaveListFilters(params, now);

  assert.equal(normalized.activeToday, true);
  assert.equal(normalized.status, "REQUESTED");
  assert.equal(normalized.page, 2);
  assert.equal(normalized.pageSize, 25);
  assert.equal((normalized.where as { status?: string }).status, "APPROVED");
  const where = normalized.where as { startDate?: { lte: Date }; endDate?: { gte: Date } };
  assert.equal(where.startDate?.lte.toISOString(), now.toISOString());
  assert.equal(where.endDate?.gte.toISOString(), now.toISOString());
});

test("leave route helpers validate expectedUpdatedAt for conflict detection", () => {
  const existingUpdatedAt = new Date("2026-03-26T10:15:00.000Z");
  const match = validateExpectedUpdatedAtConflict(existingUpdatedAt, "2026-03-26T10:15:00.000Z");
  assert.equal(match.ok, true);

  const invalid = validateExpectedUpdatedAtConflict(existingUpdatedAt, "not-a-date");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.status, 400);
  }

  const conflict = validateExpectedUpdatedAtConflict(existingUpdatedAt, "2026-03-26T10:16:00.000Z");
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.status, 409);
  }
});

test("leave route helpers enforce decision note for rejected and cancelled", () => {
  const approve = validateDecisionNoteForStatus("APPROVED", "");
  assert.equal(approve.ok, true);

  const rejectBad = validateDecisionNoteForStatus("REJECTED", "x");
  assert.equal(rejectBad.ok, false);
  if (!rejectBad.ok) {
    assert.equal(rejectBad.status, 400);
  }

  const cancelOk = validateDecisionNoteForStatus("CANCELLED", "Staff request");
  assert.equal(cancelOk.ok, true);
  if (cancelOk.ok) {
    assert.equal(cancelOk.note, "Staff request");
  }
});
