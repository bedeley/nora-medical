import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAuditText,
  planBulkApplicationStageUpdates,
  requiresApplicationDecisionNote,
  selectEmployeeMatchForApplicant,
  validateApplicationStageTransition,
  validateHiringConflict,
} from "@/lib/hr-hiring-utils";

test("hiring conflict validator delegates expectedUpdatedAt checks", () => {
  const current = new Date("2026-03-26T10:00:00.000Z");
  assert.equal(validateHiringConflict(current, "").ok, true);
  assert.equal(validateHiringConflict(current, "bad-value").ok, false);
  assert.equal(
    validateHiringConflict(current, "2026-03-26T10:00:00.000Z").ok,
    true,
  );
});

test("application transition validator blocks invalid paths", () => {
  assert.equal(validateApplicationStageTransition("APPLIED", "SCREENING").ok, true);
  assert.equal(validateApplicationStageTransition("INTERVIEW", "OFFER").ok, true);
  assert.equal(validateApplicationStageTransition("OFFER", "HIRED").ok, true);
  assert.equal(validateApplicationStageTransition("APPLIED", "HIRED").ok, false);
  assert.equal(validateApplicationStageTransition("HIRED", "SCREENING").ok, false);
});

test("decision note requirement applies to rejected and withdrawn", () => {
  assert.equal(requiresApplicationDecisionNote("REJECTED"), true);
  assert.equal(requiresApplicationDecisionNote("WITHDRAWN"), true);
  assert.equal(requiresApplicationDecisionNote("INTERVIEW"), false);
});

test("normalizeAuditText uses fallback for empty values", () => {
  assert.equal(normalizeAuditText("", "fallback"), "fallback");
  assert.equal(normalizeAuditText("  provided  ", "fallback"), "provided");
});

test("selectEmployeeMatchForApplicant resolves deterministic single matches", () => {
  const rows = [
    { id: "emp-1", email: "a@example.com", phone: "111" },
    { id: "emp-2", email: "b@example.com", phone: "222" },
  ];
  const byEmail = selectEmployeeMatchForApplicant(rows, "a@example.com", "");
  assert.equal(byEmail.ok, true);
  if (byEmail.ok) assert.equal(byEmail.match?.id, "emp-1");

  const byPhone = selectEmployeeMatchForApplicant(rows, "", "222");
  assert.equal(byPhone.ok, true);
  if (byPhone.ok) assert.equal(byPhone.match?.id, "emp-2");
});

test("selectEmployeeMatchForApplicant rejects ambiguous cross-match", () => {
  const rows = [
    { id: "emp-1", email: "a@example.com", phone: "111" },
    { id: "emp-2", email: "b@example.com", phone: "222" },
  ];
  const result = selectEmployeeMatchForApplicant(rows, "a@example.com", "222");
  assert.equal(result.ok, false);
});

test("planBulkApplicationStageUpdates returns updated and skipped rows with reasons", () => {
  const plan = planBulkApplicationStageUpdates(
    ["app-1", "missing-1", "app-2", "app-3"],
    [
      { id: "app-1", stage: "APPLIED" },
      { id: "app-2", stage: "HIRED" },
      { id: "app-3", stage: "SCREENING" },
    ],
    "INTERVIEW",
  );

  assert.deepEqual(
    plan.updated.map((row) => ({ id: row.id, from: row.from, to: row.to })),
    [{ id: "app-3", from: "SCREENING", to: "INTERVIEW" }],
  );
  assert.equal(plan.skipped.length, 3);
  const skippedById = new Map(plan.skipped.map((row) => [row.id, row.reason]));
  assert.equal(skippedById.get("missing-1"), "Not found.");
  assert.match(String(skippedById.get("app-2")), /cannot move back/i);
  assert.match(String(skippedById.get("app-1")), /screening/i);
});
