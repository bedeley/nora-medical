import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOnboardingDeleteAuditMeta,
  validateOnboardingDeleteConflict,
} from "@/lib/hr-onboarding-audit-utils";

test("validateOnboardingDeleteConflict handles valid and conflict paths", () => {
  const current = new Date("2026-03-26T10:00:00.000Z");
  assert.equal(validateOnboardingDeleteConflict(current, "").ok, true);

  const invalid = validateOnboardingDeleteConflict(current, "bad-date");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.status, 400);

  const stale = validateOnboardingDeleteConflict(current, "2026-03-26T10:05:00.000Z");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);
});

test("buildOnboardingDeleteAuditMeta includes required audit fields", () => {
  const meta = buildOnboardingDeleteAuditMeta({
    actorId: "admin-1",
    actorRole: "ADMIN",
    sourcePage: "/admin/hr/staff/emp-1",
    section: "onboarding-checklist",
    operation: "delete_onboarding_task",
    resultSummary: "Onboarding task removed from staff profile.",
    before: {
      employeeId: "emp-1",
      title: "Collect ID card",
      status: "PENDING",
      dueDate: new Date("2026-03-30T00:00:00.000Z"),
      completedAt: null,
    },
  });

  assert.equal(meta.actor.id, "admin-1");
  assert.equal(meta.sourcePage, "/admin/hr/staff/emp-1");
  assert.equal(meta.section, "onboarding-checklist");
  assert.equal(meta.operation, "delete_onboarding_task");
  assert.equal(meta.before.employeeId, "emp-1");
  assert.equal(meta.after, null);
  assert.equal(meta.resultSummary, "Onboarding task removed from staff profile.");
});
