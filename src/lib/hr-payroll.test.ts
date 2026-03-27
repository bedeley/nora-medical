import test from "node:test";
import assert from "node:assert/strict";
import {
  computeGeneratedPayslipAmounts,
  computeGeneratedGhanaPayslipAmounts,
  computeProratedPayslipFromCompensations,
  daysInclusive,
} from "@/lib/hr-payroll";

test("daysInclusive is DST-safe for March 2026 month boundaries", () => {
  const start = new Date(2026, 2, 1, 0, 0, 0, 0);
  const end = new Date(2026, 2, 31, 23, 59, 59, 999);
  assert.equal(daysInclusive(start, end), 31);
});

test("computeGeneratedPayslipAmounts includes compensation deductions in net", () => {
  const amounts = computeGeneratedPayslipAmounts({
    baseSalary: 2000,
    allowances: 100,
    compensationDeductions: 150,
    bonusValue: 0,
    factor: 0.2,
    taxPercent: 5,
    pensionPercent: 0,
  });

  assert.equal(amounts.gross, 420);
  assert.equal(amounts.tax, 21);
  assert.equal(amounts.proratedCompensationDeductions, 30);
  assert.equal(amounts.deductions, 51);
  assert.equal(amounts.net, 369);
});

test("computeGeneratedPayslipAmounts caps deductions to avoid negative net", () => {
  const amounts = computeGeneratedPayslipAmounts({
    baseSalary: 100,
    allowances: 0,
    compensationDeductions: 300,
    bonusValue: 0,
    factor: 1,
    taxPercent: 0,
    pensionPercent: 0,
  });

  assert.equal(amounts.gross, 100);
  assert.equal(amounts.calculatedDeductions, 300);
  assert.equal(amounts.deductions, 100);
  assert.equal(amounts.unappliedDeductions, 200);
  assert.equal(amounts.net, 0);
});

test("computeProratedPayslipFromCompensations handles mid-month compensation changes", () => {
  const periodStart = new Date(2026, 2, 1);
  const periodEnd = new Date(2026, 2, 30);
  const toDayIndex = (value: Date) =>
    Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);

  const result = computeProratedPayslipFromCompensations({
    activeStartDay: toDayIndex(periodStart),
    activeEndDay: toDayIndex(periodEnd),
    periodTotalDays: 30,
    taxPercent: 0,
    pensionPercent: 0,
    defaultBonus: 0,
    compensations: [
      {
        effectiveDate: new Date(2026, 2, 1),
        baseSalary: 2000,
        allowances: 0,
        deductions: 0,
        bonus: 0,
      },
      {
        effectiveDate: new Date(2026, 2, 16),
        baseSalary: 3000,
        allowances: 0,
        deductions: 0,
        bonus: 0,
      },
    ],
  });

  assert.ok(result);
  // 15/30 of 2000 + 15/30 of 3000 = 2500
  assert.equal(result?.gross, 2500);
  assert.equal(result?.net, 2500);
});

test("computeGeneratedGhanaPayslipAmounts applies SSNIT then PAYE", () => {
  const amounts = computeGeneratedGhanaPayslipAmounts({
    baseSalary: 2000,
    allowances: 100,
    compensationDeductions: 150,
    bonusValue: 0,
    factor: 1,
    ssnitEmployeeRate: 5.5,
    payeBands: [
      { limit: 490, rate: 0 },
      { limit: 110, rate: 5 },
      { limit: 130, rate: 10 },
      { limit: null, rate: 17.5 },
    ],
  });
  assert.equal(amounts.pension, 110);
  assert.equal(amounts.chargeableIncome, 1990);
  assert.ok(amounts.tax > 0);
  assert.equal(amounts.net, amounts.gross - amounts.deductions);
});
