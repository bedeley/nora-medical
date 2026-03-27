import test from "node:test";
import assert from "node:assert/strict";
import {
  getMissingBankFieldLabels,
  summarizeMissingBankDetails,
  validateManualPayslipInput,
} from "@/lib/hr-payslip-utils";

test("validateManualPayslipInput rejects invalid net and negative line items", () => {
  assert.equal(
    validateManualPayslipInput({
      grossPay: 100,
      netPay: 200,
      lineItems: { allowances: 0, bonus: 0, otherEarnings: 0 },
    }),
    "Net pay cannot exceed gross pay plus additions.",
  );
  assert.equal(
    validateManualPayslipInput({
      grossPay: 100,
      netPay: 90,
      lineItems: { tax: -1 },
    }),
    "Line item 'tax' cannot be negative.",
  );
});

test("validateManualPayslipInput accepts valid data", () => {
  assert.equal(
    validateManualPayslipInput({
      grossPay: 1000,
      netPay: 950,
      lineItems: { tax: 30, pension: 20, allowances: 0, bonus: 0, otherEarnings: 0 },
    }),
    null,
  );
});

test("summarizeMissingBankDetails identifies missing records", () => {
  const summary = summarizeMissingBankDetails([
    {
      employeeId: "e1",
      employee: {
        firstName: "Nora",
        lastName: "Admin",
        bankName: "GCB",
        bankCode: "001",
        bankBranch: "Main",
        bankAccountName: "Nora Admin",
        bankAccountNumber: "123456",
      },
    },
    {
      employeeId: "e2",
      employee: {
        firstName: "Sam",
        lastName: "Nurse",
        bankName: "ADB",
        bankCode: "",
        bankBranch: null,
        bankAccountName: "Sam Nurse",
        bankAccountNumber: "456789",
      },
    },
  ]);
  assert.equal(summary.count, 1);
  assert.deepEqual(summary.entries, [
    {
      employeeId: "e2",
      employee: "Sam Nurse",
      missingFields: ["Bank code", "Bank branch"],
    },
  ]);
});

test("getMissingBankFieldLabels returns every export-required field when details are blank", () => {
  assert.deepEqual(getMissingBankFieldLabels(null), [
    "Bank name",
    "Bank code",
    "Bank branch",
    "Account name",
    "Account number",
  ]);
});
