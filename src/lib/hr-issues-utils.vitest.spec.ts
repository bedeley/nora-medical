import { describe, expect, it } from "vitest";
import {
  canTransitionIssueStatus,
  prettyIssueStatus,
  statusRequiresResolution,
} from "@/lib/hr-issues-utils";

describe("hr-issues-utils", () => {
  it("canTransitionIssueStatus enforces expected workflow", () => {
    expect(canTransitionIssueStatus("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canTransitionIssueStatus("OPEN", "RESOLVED")).toBe(true);
    expect(canTransitionIssueStatus("OPEN", "CLOSED")).toBe(false);
    expect(canTransitionIssueStatus("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(canTransitionIssueStatus("RESOLVED", "CLOSED")).toBe(true);
    expect(canTransitionIssueStatus("CLOSED", "OPEN")).toBe(false);
    expect(canTransitionIssueStatus("CLOSED", "IN_PROGRESS")).toBe(true);
  });

  it("statusRequiresResolution flags resolved and closed only", () => {
    expect(statusRequiresResolution("OPEN")).toBe(false);
    expect(statusRequiresResolution("IN_PROGRESS")).toBe(false);
    expect(statusRequiresResolution("RESOLVED")).toBe(true);
    expect(statusRequiresResolution("CLOSED")).toBe(true);
  });

  it("prettyIssueStatus formats labels for UI", () => {
    expect(prettyIssueStatus("OPEN")).toBe("Open");
    expect(prettyIssueStatus("IN_PROGRESS")).toBe("In progress");
    expect(prettyIssueStatus("RESOLVED")).toBe("Resolved");
    expect(prettyIssueStatus("CLOSED")).toBe("Closed");
  });
});
