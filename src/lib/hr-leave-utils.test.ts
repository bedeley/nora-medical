import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLeaveCreateAuditMeta,
  buildLeaveUpdateAuditMeta,
  humanizeLeaveStatus,
  humanizeLeaveType,
  isLeaveActiveOnDate,
  isLeaveDateRangeValid,
  isValidLeaveStatusTransition,
  normalizeLeavePagination,
  parseLeaveDateInput,
  shouldRequireDecisionNote,
} from "@/lib/hr-leave-utils";

test("leave utils enforce expected status transition rules", () => {
  assert.equal(isValidLeaveStatusTransition("REQUESTED", "APPROVED"), true);
  assert.equal(isValidLeaveStatusTransition("APPROVED", "REJECTED"), false);
  assert.equal(isValidLeaveStatusTransition("CANCELLED", "APPROVED"), false);
});

test("leave utils parse date input and reject invalid values", () => {
  const valid = parseLeaveDateInput("2026-03-20");
  assert.equal(valid instanceof Date, true);
  assert.equal(parseLeaveDateInput("invalid-date"), null);
});

test("leave utils validate date ranges", () => {
  const start = new Date("2026-03-20T00:00:00.000Z");
  const end = new Date("2026-03-22T00:00:00.000Z");
  const reversed = new Date("2026-03-18T00:00:00.000Z");
  assert.equal(isLeaveDateRangeValid(start, end), true);
  assert.equal(isLeaveDateRangeValid(start, reversed), false);
});

test("leave utils build create audit metadata with required fields", () => {
  const startDate = new Date("2026-03-20T00:00:00.000Z");
  const endDate = new Date("2026-03-22T00:00:00.000Z");
  const meta = buildLeaveCreateAuditMeta({
    actorId: "admin_1",
    actorRole: "ADMIN",
    sourcePage: "admin/hr/leave",
    section: "leave-requests",
    operation: "create_leave_request",
    resultSummary: "Leave request created successfully.",
    after: {
      employeeId: "emp_1",
      type: "ANNUAL",
      status: "REQUESTED",
      startDate,
      endDate,
      reason: "Family event",
      approvedAt: null,
      cancelledAt: null,
    },
  });

  assert.equal(meta.actor.id, "admin_1");
  assert.equal(meta.sourcePage, "admin/hr/leave");
  assert.equal(meta.section, "leave-requests");
  assert.equal(meta.operation, "create_leave_request");
  assert.equal(meta.before, null);
  assert.equal(meta.after.employeeId, "emp_1");
  assert.equal(meta.after.type, "ANNUAL");
  assert.equal(meta.status, "SUCCESS");
  assert.equal(meta.resultSummary, "Leave request created successfully.");
});

test("leave utils build update audit metadata with before and after snapshots", () => {
  const startDate = new Date("2026-03-20T00:00:00.000Z");
  const endDate = new Date("2026-03-22T00:00:00.000Z");
  const meta = buildLeaveUpdateAuditMeta({
    actorId: "admin_2",
    actorRole: "ADMIN",
    sourcePage: "admin/hr/leave",
    section: "leave-requests",
    operation: "approve_leave_request",
    resultSummary: "Leave request updated successfully.",
    before: {
      employeeId: "emp_1",
      type: "ANNUAL",
      status: "REQUESTED",
      startDate,
      endDate,
      reason: "Family event",
      approvedAt: null,
      cancelledAt: null,
    },
    after: {
      employeeId: "emp_1",
      type: "ANNUAL",
      status: "APPROVED",
      startDate,
      endDate,
      reason: "Family event",
      approvedAt: new Date("2026-03-19T12:00:00.000Z"),
      cancelledAt: null,
    },
  });

  assert.equal(meta.actor.id, "admin_2");
  assert.equal(meta.operation, "approve_leave_request");
  assert.equal(meta.before.status, "REQUESTED");
  assert.equal(meta.after.status, "APPROVED");
  assert.equal(meta.status, "SUCCESS");
});

test("leave utils expose plain english labels", () => {
  assert.equal(humanizeLeaveType("ANNUAL"), "Annual leave");
  assert.equal(humanizeLeaveStatus("REQUESTED"), "Requested");
});

test("leave utils normalize pagination with sane defaults and caps", () => {
  const defaults = normalizeLeavePagination(null, null);
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 50);
  assert.equal(defaults.skip, 0);

  const bounded = normalizeLeavePagination("3", "500");
  assert.equal(bounded.page, 3);
  assert.equal(bounded.pageSize, 200);
  assert.equal(bounded.skip, 400);
});

test("leave utils decide when decision note is required", () => {
  assert.equal(shouldRequireDecisionNote("APPROVED"), false);
  assert.equal(shouldRequireDecisionNote("REJECTED"), true);
  assert.equal(shouldRequireDecisionNote("CANCELLED"), true);
});

test("leave utils identify active approved leave on a target date", () => {
  const active = isLeaveActiveOnDate({
    status: "APPROVED",
    startDate: new Date("2026-03-20T00:00:00.000Z"),
    endDate: new Date("2026-03-25T00:00:00.000Z"),
    date: new Date("2026-03-22T12:00:00.000Z"),
  });
  const inactive = isLeaveActiveOnDate({
    status: "APPROVED",
    startDate: new Date("2026-03-20T00:00:00.000Z"),
    endDate: new Date("2026-03-25T00:00:00.000Z"),
    date: new Date("2026-03-26T12:00:00.000Z"),
  });
  assert.equal(active, true);
  assert.equal(inactive, false);
});
