import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionIssueStatus,
  prettyIssueStatus,
  statusRequiresResolution,
} from "@/lib/hr-issues-utils";

test("canTransitionIssueStatus enforces expected workflow", () => {
  assert.equal(canTransitionIssueStatus("OPEN", "IN_PROGRESS"), true);
  assert.equal(canTransitionIssueStatus("OPEN", "RESOLVED"), true);
  assert.equal(canTransitionIssueStatus("OPEN", "CLOSED"), false);
  assert.equal(canTransitionIssueStatus("IN_PROGRESS", "RESOLVED"), true);
  assert.equal(canTransitionIssueStatus("RESOLVED", "CLOSED"), true);
  assert.equal(canTransitionIssueStatus("CLOSED", "OPEN"), false);
  assert.equal(canTransitionIssueStatus("CLOSED", "IN_PROGRESS"), true);
});

test("statusRequiresResolution flags resolved and closed only", () => {
  assert.equal(statusRequiresResolution("OPEN"), false);
  assert.equal(statusRequiresResolution("IN_PROGRESS"), false);
  assert.equal(statusRequiresResolution("RESOLVED"), true);
  assert.equal(statusRequiresResolution("CLOSED"), true);
});

test("prettyIssueStatus formats labels for UI", () => {
  assert.equal(prettyIssueStatus("OPEN"), "Open");
  assert.equal(prettyIssueStatus("IN_PROGRESS"), "In progress");
  assert.equal(prettyIssueStatus("RESOLVED"), "Resolved");
  assert.equal(prettyIssueStatus("CLOSED"), "Closed");
});
