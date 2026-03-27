import test from "node:test";
import assert from "node:assert/strict";
import { computeStatutoryTotals, payrollMonthKey } from "@/lib/hr-payroll-remittance";
import {
  buildGraPayeFilingCsvRows,
  buildMonthlyRemittanceCsvRows,
  buildPayeScheduleCsvRows,
  buildSsnitFilingCsvRows,
  buildSsnitScheduleCsvRows,
} from "@/lib/hr-payroll-remittance-csv";

test("payrollMonthKey zero-pads month", () => {
  assert.equal(payrollMonthKey(2026, 3), "2026-03");
});

test("computeStatutoryTotals calculates tax, ssnit, and other deductions", () => {
  const totals = computeStatutoryTotals([
    {
      grossPay: 2100,
      netPay: 1810,
      lineItems: { tax: 120, pension: 110, employerSsnit: 260 },
    },
    {
      grossPay: 900,
      netPay: 810,
      lineItems: { tax: 40, pension: 50, employerSsnit: 117 },
    },
  ]);
  assert.equal(totals.totalGross, 3000);
  assert.equal(totals.totalNet, 2620);
  assert.equal(totals.payeTax, 160);
  assert.equal(totals.ssnitEmployee, 160);
  assert.equal(totals.ssnitEmployer, 377);
  assert.equal(totals.otherDeductions, 60);
});

test("buildMonthlyRemittanceCsvRows returns essential monthly remittance rows", () => {
  const rows = buildMonthlyRemittanceCsvRows({
    monthKey: "2026-03",
    runCount: 1,
    payslipCount: 2,
    employeeCount: 2,
    totalGross: 3000,
    totalNet: 2620,
    payeTax: 160,
    ssnitEmployee: 160,
    ssnitEmployer: 377,
    otherDeductions: 60,
    remittance: {
      payeStatus: "PENDING",
      ssnitStatus: "REMITTED",
      payeRemittedAt: null,
      ssnitRemittedAt: "2026-03-28T12:00:00.000Z",
      payePaymentMethod: null,
      ssnitPaymentMethod: "CASH",
      payeReference: null,
      ssnitReference: "SSNIT-2026-03",
    },
  });

  assert.equal(rows[0]?.[0], "Month");
  assert.equal(rows[0]?.[1], "2026-03");
  assert.deepEqual(rows[8], ["Liability", "Amount", "Status", "PaymentMethod", "RemittedAt", "Reference"]);
  assert.equal(rows[9]?.[0], "PAYE");
  assert.equal(rows[10]?.[0], "SSNIT");
  assert.equal(rows[10]?.[3], "CASH");
  assert.equal(rows[11]?.[0], "SSNITEmployee");
  assert.equal(rows[12]?.[0], "SSNITEmployer");
});

test("schedule CSV helpers return employee-level PAYE and SSNIT rows", () => {
  const rows = [
    {
      employeeId: "emp-1",
      employeeName: "Kwesi Yeboah",
      email: "kwesi@nora.com",
      department: "Sales",
      position: "Sales Rep",
      grossPay: 2100,
      payeTax: 120,
      ssnitEmployee: 110,
      ssnitEmployer: 260,
      ssnitTotal: 370,
    },
  ];
  const payeCsv = buildPayeScheduleCsvRows(rows);
  const ssnitCsv = buildSsnitScheduleCsvRows(rows);
  assert.equal(payeCsv[0]?.[0], "EmployeeId");
  assert.equal(payeCsv[1]?.[6], "120.00");
  assert.equal(ssnitCsv[0]?.[5], "EmployeeSSNIT");
  assert.equal(ssnitCsv[1]?.[7], "370.00");
  const graCsv = buildGraPayeFilingCsvRows(rows);
  const ssnitFilingCsv = buildSsnitFilingCsvRows(rows);
  assert.equal(graCsv[0]?.[4], "PAYE Withheld");
  assert.equal(ssnitFilingCsv[0]?.[4], "Total SSNIT");
});
