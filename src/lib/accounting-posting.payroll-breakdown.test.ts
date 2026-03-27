import test from "node:test";
import assert from "node:assert/strict";
import { computePayrollAccrualBreakdown } from "@/lib/accounting-posting";

test("computePayrollAccrualBreakdown splits liabilities correctly", () => {
  const result = computePayrollAccrualBreakdown({
    totalGross: 3000,
    totalNet: 2620,
    tax: 160,
    employeeSsnit: 160,
    employerSsnit: 377,
  });
  assert.equal(result.payrollPayable, 2620);
  assert.equal(result.payePayable, 160);
  assert.equal(result.ssnitEmployeePayable, 160);
  assert.equal(result.ssnitEmployerPayable, 377);
  assert.equal(result.otherDeductionsPayable, 60);
});
