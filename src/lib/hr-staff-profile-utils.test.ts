import test from "node:test";
import assert from "node:assert/strict";
import {
  validateExpectedUpdatedAt,
  validateStaffBankInput,
  validateStaffContactInput,
} from "@/lib/hr-staff-profile-utils";

test("staff profile conflict check validates expectedUpdatedAt", () => {
  const current = new Date("2026-03-26T10:00:00.000Z");
  assert.equal(validateExpectedUpdatedAt(current, "").ok, true);
  assert.equal(validateExpectedUpdatedAt(current, "not-a-date").ok, false);
  assert.equal(validateExpectedUpdatedAt(current, "2026-03-26T10:00:00.000Z").ok, true);
  const stale = validateExpectedUpdatedAt(current, "2026-03-26T10:05:00.000Z");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);
});

test("staff profile contact validation returns plain english errors", () => {
  const invalid = validateStaffContactInput({ email: "bad", phone: "12" });
  assert.equal(Boolean(invalid.errors.email), true);
  assert.equal(Boolean(invalid.errors.phone), true);

  const valid = validateStaffContactInput({ email: "admin@example.com", phone: "1234567890" });
  assert.deepEqual(valid.errors, {});
});

test("staff profile bank validation enforces required fields", () => {
  const result = validateStaffBankInput({
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
  });
  assert.equal(Boolean(result.errors.bankName), true);
  assert.equal(Boolean(result.errors.bankAccountName), true);
  assert.equal(Boolean(result.errors.bankAccountNumber), true);
});

test("staff profile bank validation enforces account/bank-code format", () => {
  const result = validateStaffBankInput({
    bankName: "Nora Bank",
    bankAccountName: "Nora Admin",
    bankAccountNumber: "12ab",
    bankCode: "*bad*",
    bankBranch: "Main",
  });
  assert.equal(Boolean(result.errors.bankAccountNumber), true);
  assert.equal(Boolean(result.errors.bankCode), true);
});
