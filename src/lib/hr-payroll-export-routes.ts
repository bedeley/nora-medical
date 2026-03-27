import type { PayrollStatus } from "@prisma/client";

export type PayrollExportPayslip = {
  id: string;
  employeeId: string;
  grossPay: unknown;
  netPay: unknown;
  lineItems?: unknown;
  employee: {
    id?: string;
    firstName: string;
    lastName: string;
    bankName?: string | null;
    bankCode?: string | null;
    bankBranch?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
  };
};

export type PayrollPayslipSort =
  | "employee_asc"
  | "employee_desc"
  | "gross_desc"
  | "gross_asc"
  | "net_desc"
  | "net_asc";

const PAYSLIP_SORTS: PayrollPayslipSort[] = [
  "employee_asc",
  "employee_desc",
  "gross_desc",
  "gross_asc",
  "net_desc",
  "net_asc",
];

export function buildPayrollExportRows(payslips: PayrollExportPayslip[]): string[][] {
  return [
    ["Employee", "Gross Pay", "Net Pay", "Deductions"],
    ...payslips.map((slip) => {
      const gross = Number(slip.grossPay || 0);
      const net = Number(slip.netPay || 0);
      const deductions = Math.max(0, gross - net);
      return [
        `${slip.employee.firstName} ${slip.employee.lastName}`,
        gross.toFixed(2),
        net.toFixed(2),
        deductions.toFixed(2),
      ];
    }),
  ];
}

export function buildPayrollExportFileName(runId: string, periodStart: Date, periodEnd: Date): string {
  return `payroll-${runId}-${periodStart.toISOString().slice(0, 10)}-${periodEnd.toISOString().slice(0, 10)}.csv`;
}

export function isBankExportAllowedStatus(status: PayrollStatus): boolean {
  return status === "FINALIZED" || status === "PAID";
}

export function buildBankExportHeader(): string[] {
  return [
    "Employee",
    "BankName",
    "BankCode",
    "BankBranch",
    "AccountName",
    "AccountNumber",
    "Amount",
    "PayrollRunId",
  ];
}

export function buildBankExportRows(runId: string, payslips: PayrollExportPayslip[]): Array<Array<string | number>> {
  return payslips.map((slip) => [
    `${slip.employee.firstName} ${slip.employee.lastName}`,
    slip.employee.bankName || "",
    slip.employee.bankCode || "",
    slip.employee.bankBranch || "",
    slip.employee.bankAccountName || "",
    slip.employee.bankAccountNumber || "",
    Number(slip.netPay || 0),
    runId,
  ]);
}

export function buildBankExportFileName(runId: string, periodStart: Date, periodEnd: Date): string {
  return `payroll-bank-export-${runId}-${periodStart.toISOString().slice(0, 10)}-${periodEnd.toISOString().slice(0, 10)}.csv`;
}

export function getPayrollRunAuditHref(runId: string): string {
  const params = new URLSearchParams();
  params.set("sourcePage", "admin/hr/payroll/[id]");
  params.set("payrollRunId", runId);
  return `/admin/audit?${params.toString()}`;
}

export const getPayrollRunExportAuditHref = getPayrollRunAuditHref;

export function normalizePayrollPayslipSort(raw: string | null | undefined): PayrollPayslipSort {
  if (!raw) return "employee_asc";
  return PAYSLIP_SORTS.includes(raw as PayrollPayslipSort)
    ? (raw as PayrollPayslipSort)
    : "employee_asc";
}

export function filterAndSortPayrollPayslips<T extends PayrollExportPayslip>(
  payslips: T[],
  search: string,
  sort: PayrollPayslipSort,
): T[] {
  const normalizedSearch = search.trim().toLowerCase();
  const filtered = payslips.filter((slip) => {
    if (!normalizedSearch) return true;
    const fullName = `${slip.employee.firstName} ${slip.employee.lastName}`.toLowerCase();
    return (
      fullName.includes(normalizedSearch) ||
      String(slip.employeeId || "").toLowerCase().includes(normalizedSearch)
    );
  });

  filtered.sort((a, b) => {
    if (sort === "employee_asc" || sort === "employee_desc") {
      const left = `${a.employee.firstName} ${a.employee.lastName}`.toLowerCase();
      const right = `${b.employee.firstName} ${b.employee.lastName}`.toLowerCase();
      return sort === "employee_asc" ? left.localeCompare(right) : right.localeCompare(left);
    }
    if (sort === "gross_desc") return Number(b.grossPay || 0) - Number(a.grossPay || 0);
    if (sort === "gross_asc") return Number(a.grossPay || 0) - Number(b.grossPay || 0);
    if (sort === "net_desc") return Number(b.netPay || 0) - Number(a.netPay || 0);
    return Number(a.netPay || 0) - Number(b.netPay || 0);
  });

  return filtered;
}
