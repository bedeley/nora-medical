import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYSTUB_SOURCE_PAGE,
  buildPaystubActionAuditMeta,
  calculatePaystubDeductions,
  getPaystubCurrentBreakdownRows,
  getPaystubRoleSummary,
  getPaystubYtdBreakdownRows,
} from "@/lib/hr-paystub-utils";

test("calculatePaystubDeductions falls back to gross minus net when deductions are missing", () => {
  assert.equal(
    calculatePaystubDeductions({
      grossPay: 1500,
      netPay: 1200,
      lineItems: { tax: 200 },
    }),
    300,
  );
});

test("getPaystubCurrentBreakdownRows exposes the PDF and page breakdown in one place", () => {
  const rows = getPaystubCurrentBreakdownRows({
    grossPay: 1800,
    netPay: 1450,
    lineItems: {
      tax: 200,
      pension: 99,
      employerSsnit: 117,
      allowances: 50,
      nonTaxableAllowances: 20,
      chargeableIncome: 1730,
      deductions: 350,
    },
  });

  assert.deepEqual(
    rows.map((row) => row.label),
    [
      "Gross pay",
      "Net pay",
      "Tax",
      "Employee SSNIT",
      "Employer SSNIT",
      "Taxable allowances",
      "Non-taxable allowances",
      "Chargeable income",
      "Deductions",
    ],
  );
  assert.equal(rows.at(-1)?.value, 350);
  assert.equal(rows[5]?.value, 50);
});

test("getPaystubYtdBreakdownRows returns the expected year to date order", () => {
  const rows = getPaystubYtdBreakdownRows({
    gross: 9000,
    net: 7200,
    deductions: 1800,
    tax: 1200,
    pension: 600,
  });

  assert.deepEqual(
    rows.map((row) => row.label),
    ["Gross pay", "Net pay", "Tax", "Employee SSNIT", "Deductions"],
  );
  assert.equal(rows[3]?.value, 600);
});

test("buildPaystubActionAuditMeta keeps only essential audit context", () => {
  const meta = buildPaystubActionAuditMeta({
    actor: {
      id: "admin-1",
      name: "Nora Admin",
      email: "nora@example.com",
      role: "ADMIN",
    },
    payslip: {
      id: "slip-1",
      employeeId: "emp-1",
      payrollRunId: "run-1",
      employee: {
        firstName: "Nora",
        lastName: "Admin",
        email: "staff@example.com",
      },
      payrollRun: {
        periodStart: "2026-03-01T00:00:00.000Z",
        periodEnd: "2026-03-31T00:00:00.000Z",
        status: "FINALIZED",
        runType: "REGULAR",
      },
    },
    operation: "download_paystub_pdf",
    after: {
      fileName: "paystub-slip-1.pdf",
    },
    resultSummary: "Paystub PDF downloaded successfully.",
  });

  assert.equal(meta.sourcePage, PAYSTUB_SOURCE_PAGE);
  assert.equal("actor" in meta, false);
  assert.equal(meta.before.employeeName, "Nora Admin");
  assert.equal(meta.before.payrollRunStatus, "FINALIZED");
  assert.equal("payrollRunType" in meta.before, false);
  assert.equal(meta.after.fileName, "paystub-slip-1.pdf");
  assert.equal(meta.resultSummary, "Paystub PDF downloaded successfully.");
});

test("getPaystubRoleSummary falls back cleanly when values are missing", () => {
  assert.equal(getPaystubRoleSummary("", null), "- | -");
});
