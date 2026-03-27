export type ReviewWorkflowStatus = "DRAFT" | "SUBMITTED" | "ACKNOWLEDGED";

export type ReviewWorkflowState = {
  status: ReviewWorkflowStatus;
  archived: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

export const REVIEW_WORKFLOW_KEY_PREFIX = "hr.review.workflow.";

export function buildReviewWorkflowKey(reviewId: string) {
  return `${REVIEW_WORKFLOW_KEY_PREFIX}${reviewId}`;
}

export function defaultReviewWorkflowState(): ReviewWorkflowState {
  return {
    status: "DRAFT",
    archived: false,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

export function parseReviewWorkflowState(raw: unknown): ReviewWorkflowState {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const statusRaw = String(source.status || "DRAFT").toUpperCase();
  const status: ReviewWorkflowStatus =
    statusRaw === "SUBMITTED" || statusRaw === "ACKNOWLEDGED" ? (statusRaw as ReviewWorkflowStatus) : "DRAFT";
  return {
    status,
    archived: Boolean(source.archived),
    acknowledgedAt: source.acknowledgedAt ? String(source.acknowledgedAt) : null,
    acknowledgedBy: source.acknowledgedBy ? String(source.acknowledgedBy) : null,
  };
}

export function canTransitionReviewWorkflow(
  current: ReviewWorkflowStatus,
  next: ReviewWorkflowStatus,
) {
  if (current === next) return true;
  if (current === "DRAFT" && next === "SUBMITTED") return true;
  if (current === "SUBMITTED" && next === "ACKNOWLEDGED") return true;
  return false;
}
