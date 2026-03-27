import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBankExportFileName,
  buildBankExportHeader,
  buildBankExportRows,
  filterAndSortPayrollPayslips,
  buildPayrollExportFileName,
  buildPayrollExportRows,
  getPayrollRunAuditHref,
  isBankExportAllowedStatus,
  normalizePayrollPayslipSort,
} from "@/lib/hr-payroll-export-routes";

test("buildPayrollExportRows returns header plus normalized rows", () => {
  const rows = buildPayrollExportRows([
    {
      id: "slip-1",
      employeeId: "emp-1",
      grossPay: 1000,
      netPay: 850,
      employee: { firstName: "Nora", lastName: "Admin" },
    },
  ]);

  assert.equal(rows[0]?.join("|"), "Employee|Gross Pay|Net Pay|Deductions");
  assert.equal(rows[1]?.[0], "Nora Admin");
  assert.equal(rows[1]?.[1], "1000.00");
  assert.equal(rows[1]?.[2], "850.00");
  assert.equal(rows[1]?.[3], "150.00");
});

test("buildPayrollExportRows clamps negative deductions to zero", () => {
  const rows = buildPayrollExportRows([
    {
      id: "slip-2",
      employeeId: "emp-2",
      grossPay: 100,
      netPay: 120,
      employee: { firstName: "Alex", lastName: "Doe" },
    },
  ]);

  assert.equal(rows[1]?.[3], "0.00");
});

test("bank export helpers return header, rows, and allowed statuses", () => {
  const header = buildBankExportHeader();
  assert.equal(header.length, 8);
  assert.equal(header[0], "Employee");

  const rows = buildBankExportRows("run-1", [
    {
      id: "slip-3",
      employeeId: "emp-1",
      grossPay: 1000,
      netPay: 900,
      employee: {
        firstName: "Nora",
        lastName: "Admin",
        bankName: "Bank A",
        bankCode: "001",
        bankBranch: "Main",
        bankAccountName: "Nora Admin",
        bankAccountNumber: "1234",
      },
    },
  ]);
  assert.equal(rows[0]?.[0], "Nora Admin");
  assert.equal(rows[0]?.[6], 900);
  assert.equal(rows[0]?.[7], "run-1");

  assert.equal(isBankExportAllowedStatus("FINALIZED"), true);
  assert.equal(isBankExportAllowedStatus("PAID"), true);
  assert.equal(isBankExportAllowedStatus("DRAFT"), false);
  assert.equal(isBankExportAllowedStatus("CANCELLED"), false);
});

test("filename and audit href helpers include period and id", () => {
  const from = new Date("2026-03-01T00:00:00.000Z");
  const to = new Date("2026-03-31T00:00:00.000Z");

  assert.equal(
    buildPayrollExportFileName("run-123", from, to),
    "payroll-run-123-2026-03-01-2026-03-31.csv",
  );
  assert.equal(
    buildBankExportFileName("run-123", from, to),
    "payroll-bank-export-run-123-2026-03-01-2026-03-31.csv",
  );
  assert.equal(
    getPayrollRunAuditHref("run 123"),
    "/admin/audit?sourcePage=admin%2Fhr%2Fpayroll%2F%5Bid%5D&payrollRunId=run+123",
  );
});

test("normalizePayrollPayslipSort falls back for unknown sort", () => {
  assert.equal(normalizePayrollPayslipSort("gross_desc"), "gross_desc");
  assert.equal(normalizePayrollPayslipSort("unknown"), "employee_asc");
  assert.equal(normalizePayrollPayslipSort(null), "employee_asc");
});

test("filterAndSortPayrollPayslips applies search and sort", () => {
  const rows = filterAndSortPayrollPayslips(
    [
      {
        id: "slip-4",
        employeeId: "emp-2",
        grossPay: 500,
        netPay: 400,
        employee: { firstName: "Bede", lastName: "Zed" },
      },
      {
        id: "slip-5",
        employeeId: "emp-1",
        grossPay: 900,
        netPay: 700,
        employee: { firstName: "Nora", lastName: "Admin" },
      },
    ],
    "nora",
    "net_desc",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.employeeId, "emp-1");
});
