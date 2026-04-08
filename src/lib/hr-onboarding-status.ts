export const HIRING_PIPELINE_PENDING_NOTE = "Auto-created from hiring pipeline";

export type OnboardingStatus = "pending" | "complete";

export type OnboardingStatusInput = {
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  position?: string | null;
  hireDate?: string | Date | null;
  notes?: string | null;
};

function hasValue(value?: string | Date | null) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return String(value || "").trim().length > 0;
}

function normalizeNote(value?: string | null) {
  return String(value || "").trim();
}

export function getEmployeeOnboardingMissingFields(input: OnboardingStatusInput) {
  const missingFields: string[] = [];
  if (!hasValue(input.email)) missingFields.push("Email");
  if (!hasValue(input.phone)) missingFields.push("Phone");
  if (!hasValue(input.department)) missingFields.push("Department");
  if (!hasValue(input.position)) missingFields.push("Position");
  if (!hasValue(input.hireDate)) missingFields.push("Hire date");
  return missingFields;
}

export function hasHiringPipelinePendingMarker(input: Pick<OnboardingStatusInput, "notes">) {
  return normalizeNote(input.notes) === HIRING_PIPELINE_PENDING_NOTE;
}

export function getEmployeeOnboardingState(input: OnboardingStatusInput) {
  const missingFields = getEmployeeOnboardingMissingFields(input);
  const hasPendingMarker = hasHiringPipelinePendingMarker(input);
  const status: OnboardingStatus = missingFields.length > 0 || hasPendingMarker ? "pending" : "complete";

  let summary = "Onboarding complete.";
  if (hasPendingMarker && missingFields.length > 0) {
    summary = `Imported from hiring pipeline and still missing ${missingFields.join(", ")}.`;
  } else if (hasPendingMarker) {
    summary = "Imported from hiring pipeline and waiting for HR completion.";
  } else if (missingFields.length > 0) {
    summary = `Missing ${missingFields.join(", ")}.`;
  }

  return {
    status,
    summary,
    missingFields,
    hasPendingMarker,
  };
}
