import { describe, expect, it } from "vitest";
import {
  buildReviewWorkflowKey,
  canTransitionReviewWorkflow,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
} from "@/lib/hr-review-workflow";

describe("hr-review-workflow", () => {
  it("buildReviewWorkflowKey prefixes review id", () => {
    expect(buildReviewWorkflowKey("rev-1")).toBe("hr.review.workflow.rev-1");
  });

  it("defaultReviewWorkflowState returns expected defaults", () => {
    const state = defaultReviewWorkflowState();
    expect(state.status).toBe("DRAFT");
    expect(state.archived).toBe(false);
    expect(state.acknowledgedAt).toBeNull();
    expect(state.acknowledgedBy).toBeNull();
  });

  it("parseReviewWorkflowState normalizes invalid input", () => {
    const state = parseReviewWorkflowState({ status: "bad", archived: 1, acknowledgedAt: 123 });
    expect(state.status).toBe("DRAFT");
    expect(state.archived).toBe(true);
    expect(state.acknowledgedAt).toBe("123");
  });

  it("canTransitionReviewWorkflow enforces forward flow", () => {
    expect(canTransitionReviewWorkflow("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransitionReviewWorkflow("SUBMITTED", "ACKNOWLEDGED")).toBe(true);
    expect(canTransitionReviewWorkflow("ACKNOWLEDGED", "DRAFT")).toBe(false);
    expect(canTransitionReviewWorkflow("DRAFT", "ACKNOWLEDGED")).toBe(false);
  });
});
