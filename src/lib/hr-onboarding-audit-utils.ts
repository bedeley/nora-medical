import { validateExpectedUpdatedAt } from "@/lib/hr-staff-profile-utils";

type BuildOnboardingDeleteAuditMetaInput = {
  actorId: string;
  actorRole: string;
  sourcePage: string;
  section: string;
  operation: string;
  resultSummary: string;
  before: {
    employeeId: string;
    title: string;
    status: "PENDING" | "COMPLETE";
    dueDate: Date | null;
    completedAt: Date | null;
  };
};

export function validateOnboardingDeleteConflict(currentUpdatedAt: Date, expectedUpdatedAt?: string) {
  return validateExpectedUpdatedAt(currentUpdatedAt, expectedUpdatedAt);
}

export function buildOnboardingDeleteAuditMeta(input: BuildOnboardingDeleteAuditMetaInput) {
  return {
    actor: {
      id: input.actorId,
      role: input.actorRole,
    },
    sourcePage: input.sourcePage,
    section: input.section,
    operation: input.operation,
    before: {
      employeeId: input.before.employeeId,
      title: input.before.title,
      status: input.before.status,
      dueDate: input.before.dueDate?.toISOString?.() ?? null,
      completedAt: input.before.completedAt?.toISOString?.() ?? null,
    },
    after: null,
    status: "SUCCESS",
    resultSummary: input.resultSummary,
  };
}
