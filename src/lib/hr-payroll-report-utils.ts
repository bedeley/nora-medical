type BuildPayrollRunExportAuditMetaInput = {
  format: "csv" | "bank_csv";
  payrollRunId: string;
  runType: "REGULAR" | "ADJUSTMENT";
  runStatus: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  periodStart: string;
  periodEnd: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  byteSize: number;
  missingBankDetailsCount?: number;
};

export function buildPayrollRunExportAuditMeta(input: BuildPayrollRunExportAuditMetaInput) {
  return {
    sourcePage: "admin/hr/payroll/[id]",
    section: "run-exports",
    operation: input.format === "bank_csv" ? "export_bank_csv" : "export_csv",
    exportLabel: input.format === "bank_csv" ? "Payroll bank CSV" : "Payroll run CSV",
    payrollRunId: input.payrollRunId,
    before: {
      runType: input.runType,
      status: input.runStatus,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    },
    after: {
      fileName: input.fileName,
      rowCount: input.rowCount,
      columnCount: input.columnCount,
      byteSize: input.byteSize,
      missingBankDetailsCount: input.missingBankDetailsCount ?? 0,
    },
    format: input.format === "bank_csv" ? "csv" : "csv",
    status: "SUCCESS",
    resultSummary:
      input.format === "bank_csv"
        ? "Payroll bank CSV export completed successfully."
        : "Payroll CSV export completed successfully.",
    generatedAt: new Date().toISOString(),
  };
}

type BuildPayrollFilteredExportAuditMetaInput = {
  payrollRunId: string;
  runType: "REGULAR" | "ADJUSTMENT";
  runStatus: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  periodStart: string;
  periodEnd: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  byteSize: number;
  search: string | null;
  sort: string;
  totalPayslips: number;
};

export function buildPayrollFilteredExportAuditMeta(input: BuildPayrollFilteredExportAuditMetaInput) {
  return {
    sourcePage: "admin/hr/payroll/[id]",
    section: "paystub-breakdown",
    operation: "export_filtered_csv",
    exportLabel: "Filtered payroll paystub CSV",
    payrollRunId: input.payrollRunId,
    before: {
      runType: input.runType,
      status: input.runStatus,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      totalPayslips: input.totalPayslips,
    },
    after: {
      fileName: input.fileName,
      format: "csv",
      search: input.search,
      sort: input.sort,
      rowCount: input.rowCount,
      columnCount: input.columnCount,
      byteSize: input.byteSize,
    },
    status: "SUCCESS",
    resultSummary: "Filtered payroll paystub CSV export completed successfully.",
    generatedAt: new Date().toISOString(),
  };
}
