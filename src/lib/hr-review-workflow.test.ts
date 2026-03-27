import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewWorkflowKey,
  canTransitionReviewWorkflow,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
} from "@/lib/hr-review-workflow";

test("buildReviewWorkflowKey prefixes review id", () => {
  assert.equal(buildReviewWorkflowKey("rev-1"), "hr.review.workflow.rev-1");
});

test("defaultReviewWorkflowState returns expected defaults", () => {
  const state = defaultReviewWorkflowState();
  assert.equal(state.status, "DRAFT");
  assert.equal(state.archived, false);
  assert.equal(state.acknowledgedAt, null);
  assert.equal(state.acknowledgedBy, null);
});

test("parseReviewWorkflowState normalizes invalid input", () => {
  const state = parseReviewWorkflowState({ status: "bad", archived: 1, acknowledgedAt: 123 });
  assert.equal(state.status, "DRAFT");
  assert.equal(state.archived, true);
  assert.equal(state.acknowledgedAt, "123");
});

test("canTransitionReviewWorkflow enforces forward flow", () => {
  assert.equal(canTransitionReviewWorkflow("DRAFT", "SUBMITTED"), true);
  assert.equal(canTransitionReviewWorkflow("SUBMITTED", "ACKNOWLEDGED"), true);
  assert.equal(canTransitionReviewWorkflow("ACKNOWLEDGED", "DRAFT"), false);
  assert.equal(canTransitionReviewWorkflow("DRAFT", "ACKNOWLEDGED"), false);
});
