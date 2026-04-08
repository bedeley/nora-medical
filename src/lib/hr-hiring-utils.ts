import { validateExpectedUpdatedAt } from "@/lib/hr-staff-profile-utils";

export const APPLICATION_STAGES = [
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type ApplicationStage = (typeof APPLICATION_STAGES)[number];

const stageOrder: Record<ApplicationStage, number> = {
  APPLIED: 1,
  SCREENING: 2,
  INTERVIEW: 3,
  OFFER: 4,
  HIRED: 5,
  REJECTED: 6,
  WITHDRAWN: 6,
};

export function normalizeAuditText(value: string | undefined, fallback: string) {
  const trimmed = String(value || "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function validateHiringConflict(existingUpdatedAt: Date, expectedUpdatedAt?: string | null) {
  return validateExpectedUpdatedAt(existingUpdatedAt, expectedUpdatedAt);
}

export function requiresApplicationDecisionNote(stage: ApplicationStage) {
  return stage === "REJECTED" || stage === "WITHDRAWN";
}

export function validateApplicationStageTransition(
  fromStage: ApplicationStage,
  toStage: ApplicationStage,
) {
  if (fromStage === toStage) return { ok: true as const };
  if (fromStage === "HIRED" && toStage !== "HIRED") {
    return { ok: false as const, error: "Hired applications cannot move back to earlier stages." };
  }
  if (fromStage === "REJECTED" || fromStage === "WITHDRAWN") {
    return { ok: false as const, error: "Rejected or withdrawn applications cannot be reopened." };
  }
  if (toStage === "APPLIED" && fromStage !== "APPLIED") {
    return { ok: false as const, error: "Applications cannot move back to Applied." };
  }
  if (toStage === "HIRED" && fromStage !== "OFFER") {
    return { ok: false as const, error: "Only Offer stage can move to Hired." };
  }
  if (toStage === "OFFER" && fromStage !== "INTERVIEW") {
    return { ok: false as const, error: "Only Interview stage can move to Offer." };
  }
  if (toStage === "INTERVIEW" && stageOrder[fromStage] < stageOrder.SCREENING) {
    return { ok: false as const, error: "Move to Screening before Interview." };
  }
  if (toStage === "SCREENING" && fromStage !== "APPLIED") {
    return { ok: false as const, error: "Only Applied stage can move to Screening." };
  }
  return { ok: true as const };
}

export function planBulkApplicationStageUpdates(
  requestedIds: string[],
  existingRows: Array<{ id: string; stage: ApplicationStage }>,
  toStage: ApplicationStage,
) {
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const updated: Array<{ id: string; from: ApplicationStage; to: ApplicationStage }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of requestedIds) {
    const existing = existingById.get(id);
    if (!existing) {
      skipped.push({ id, reason: "Not found." });
      continue;
    }
    const transition = validateApplicationStageTransition(existing.stage, toStage);
    if (!transition.ok) {
      skipped.push({ id, reason: transition.error });
      continue;
    }
    updated.push({ id, from: existing.stage, to: toStage });
  }

  return { updated, skipped };
}

type HiringMatchCandidate = {
  id: string;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  department?: string | null;
  position?: string | null;
  hireDate?: Date | null;
  notes?: string | null;
};

function normalizeLookup(value: string | null | undefined) {
  return String(value || "").trim().toLowerCase();
}

export function selectEmployeeMatchForApplicant(
  candidates: HiringMatchCandidate[],
  applicantEmail?: string | null,
  applicantPhone?: string | null,
) {
  if (candidates.length === 0) return { ok: true as const, match: null };

  const email = normalizeLookup(applicantEmail);
  const phone = normalizeLookup(applicantPhone);
  const emailMatches = email
    ? candidates.filter((row) => normalizeLookup(row.email) === email)
    : [];
  const phoneMatches = phone
    ? candidates.filter((row) => normalizeLookup(row.phone) === phone)
    : [];

  const ambiguousError =
    "Ambiguous applicant match: multiple employee records matched email/phone. Review duplicates before hiring.";

  if (emailMatches.length > 1 || phoneMatches.length > 1) {
    return { ok: false as const, error: ambiguousError };
  }

  if (email && phone) {
    if (emailMatches.length === 1 && phoneMatches.length === 1) {
      if (emailMatches[0]!.id !== phoneMatches[0]!.id) {
        return { ok: false as const, error: ambiguousError };
      }
      return { ok: true as const, match: emailMatches[0], matchedBy: "email_and_phone" as const };
    }
    if (emailMatches.length === 1) {
      return { ok: true as const, match: emailMatches[0], matchedBy: "email" as const };
    }
    if (phoneMatches.length === 1) {
      return { ok: true as const, match: phoneMatches[0], matchedBy: "phone" as const };
    }
  } else if (email && emailMatches.length === 1) {
    return { ok: true as const, match: emailMatches[0], matchedBy: "email" as const };
  } else if (phone && phoneMatches.length === 1) {
    return { ok: true as const, match: phoneMatches[0], matchedBy: "phone" as const };
  }

  if (candidates.length === 1) {
    return { ok: true as const, match: candidates[0], matchedBy: "fallback_single_match" as const };
  }
  return { ok: false as const, error: ambiguousError };
}
