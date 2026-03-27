import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPayrollFilteredExportAuditMeta,
  buildPayrollRunExportAuditMeta,
} from "@/lib/hr-payroll-report-utils";

test("buildPayrollRunExportAuditMeta returns expected csv metadata", () => {
  const meta = buildPayrollRunExportAuditMeta({
    format: "csv",
    payrollRunId: "run-1",
    runType: "REGULAR",
    runStatus: "FINALIZED",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    fileName: "payroll-run-1-2026-03-01-2026-03-31.csv",
    rowCount: 10,
    columnCount: 4,
    byteSize: 1024,
  });

  assert.equal(meta.sourcePage, "admin/hr/payroll/[id]");
  assert.equal(meta.section, "run-exports");
  assert.equal(meta.operation, "export_csv");
  assert.equal(meta.before.status, "FINALIZED");
  assert.equal(meta.after.rowCount, 10);
  assert.equal(meta.after.columnCount, 4);
  assert.equal(meta.after.byteSize, 1024);
  assert.equal(meta.status, "SUCCESS");
});

test("buildPayrollRunExportAuditMeta includes bank export operation", () => {
  const meta = buildPayrollRunExportAuditMeta({
    format: "bank_csv",
    payrollRunId: "run-2",
    runType: "REGULAR",
    runStatus: "PAID",
    periodStart: "2026-04-01",
    periodEnd: "2026-04-30",
    fileName: "payroll-bank-run-2-2026-04-01-2026-04-30.csv",
    rowCount: 8,
    columnCount: 8,
    byteSize: 2048,
    missingBankDetailsCount: 0,
  });
  assert.equal(meta.operation, "export_bank_csv");
  assert.equal(meta.exportLabel, "Payroll bank CSV");
  assert.equal(meta.after.missingBankDetailsCount, 0);
});

test("buildPayrollFilteredExportAuditMeta returns expected metadata shape", () => {
  const meta = buildPayrollFilteredExportAuditMeta({
    payrollRunId: "run-3",
    runType: "REGULAR",
    runStatus: "FINALIZED",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    fileName: "payroll-filtered-run-3-2026-05-01-2026-05-31.csv",
    rowCount: 7,
    columnCount: 6,
    byteSize: 1440,
    search: "nora",
    sort: "net_desc",
    totalPayslips: 20,
  });
  assert.equal(meta.section, "paystub-breakdown");
  assert.equal(meta.operation, "export_filtered_csv");
  assert.equal(meta.before.totalPayslips, 20);
  assert.equal(meta.after.search, "nora");
  assert.equal(meta.after.sort, "net_desc");
  assert.equal(meta.after.rowCount, 7);
  assert.equal(meta.after.columnCount, 6);
  assert.equal(meta.after.byteSize, 1440);
  assert.equal(meta.status, "SUCCESS");
});
