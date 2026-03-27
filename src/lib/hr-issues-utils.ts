export type IssueStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export function canTransitionIssueStatus(from: IssueStatus, to: IssueStatus) {
  if (from === to) return true;
  if (from === "OPEN" && (to === "IN_PROGRESS" || to === "RESOLVED")) return true;
  if (from === "IN_PROGRESS" && (to === "OPEN" || to === "RESOLVED")) return true;
  if (from === "RESOLVED" && (to === "IN_PROGRESS" || to === "CLOSED")) return true;
  if (from === "CLOSED" && to === "IN_PROGRESS") return true;
  return false;
}

export function statusRequiresResolution(status: IssueStatus) {
  return status === "RESOLVED" || status === "CLOSED";
}

export function prettyIssueStatus(status: IssueStatus) {
  return status === "IN_PROGRESS" ? "In progress" : status.charAt(0) + status.slice(1).toLowerCase();
}
