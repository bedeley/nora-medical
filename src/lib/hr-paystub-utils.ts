export const PAYSTUB_SOURCE_PAGE = "admin/hr/paystubs/[id]";

export type PaystubYtdTotals = {
  gross: number;
  net: number;
  deductions: number;
  tax: number;
  pension: number;
};

export type PaystubAuditActor = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type PaystubLineItems = Record<string, unknown> | null | undefined;

export type PaystubBreakdownRow = {
  label: string;
  value: number;
};

type PaystubAuditSubject = {
  id: string;
  employeeId: string;
  payrollRunId: string;
  employee: {
    firstName: string;
    lastName: string;
    email?: string | null;
  };
  payrollRun: {
    periodStart: Date | string;
    periodEnd: Date | string;
    status: string;
    runType?: string | null;
  };
};

function toIsoDate(value: Date | string) {
  return new Date(value).toISOString().slice(0, 10);
}

export function num(value: unknown) {
  return Number(value || 0);
}

export function formatPaystubMoney(value: number) {
  const formatted = new Intl.NumberFormat("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `GHS ${formatted}`;
}

export function formatPaystubDateRange(periodStart: Date | string, periodEnd: Date | string) {
  const formatter = new Intl.DateTimeFormat("en-GH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "Africa/Accra",
  });
  return `${formatter.format(new Date(periodStart))} - ${formatter.format(new Date(periodEnd))}`;
}

export function getPaystubRoleSummary(position?: string | null, department?: string | null) {
  const safePosition = String(position || "").trim() || "-";
  const safeDepartment = String(department || "").trim() || "-";
  return `${safePosition} | ${safeDepartment}`;
}

export function calculatePaystubDeductions(input: {
  grossPay: unknown;
  netPay: unknown;
  lineItems?: PaystubLineItems;
}) {
  const lineItems = input.lineItems || {};
  return Math.max(0, num((lineItems as Record<string, unknown>).deductions ?? num(input.grossPay) - num(input.netPay)));
}

export function getPaystubPdfFileName(payslipId: string) {
  return `paystub-${payslipId}.pdf`;
}

function getPaystubLineItems(lineItems?: PaystubLineItems) {
  return (lineItems || {}) as Record<string, unknown>;
}

export function getPaystubCurrentBreakdownRows(input: {
  grossPay: unknown;
  netPay: unknown;
  lineItems?: PaystubLineItems;
}): PaystubBreakdownRow[] {
  const lineItems = getPaystubLineItems(input.lineItems);
  return [
    { label: "Gross pay", value: num(input.grossPay) },
    { label: "Net pay", value: num(input.netPay) },
    { label: "Tax", value: num(lineItems.tax) },
    { label: "Employee SSNIT", value: num(lineItems.pension) },
    { label: "Employer SSNIT", value: num(lineItems.employerSsnit) },
    {
      label: "Taxable allowances",
      value: num(lineItems.taxableAllowances ?? lineItems.allowances),
    },
    { label: "Non-taxable allowances", value: num(lineItems.nonTaxableAllowances) },
    { label: "Chargeable income", value: num(lineItems.chargeableIncome) },
    {
      label: "Deductions",
      value: calculatePaystubDeductions({
        grossPay: input.grossPay,
        netPay: input.netPay,
        lineItems,
      }),
    },
  ];
}

export function getPaystubYtdBreakdownRows(ytdTotals?: Partial<PaystubYtdTotals> | null): PaystubBreakdownRow[] {
  return [
    { label: "Gross pay", value: num(ytdTotals?.gross) },
    { label: "Net pay", value: num(ytdTotals?.net) },
    { label: "Tax", value: num(ytdTotals?.tax) },
    { label: "Employee SSNIT", value: num(ytdTotals?.pension) },
    { label: "Deductions", value: num(ytdTotals?.deductions) },
  ];
}

export function buildPaystubActionAuditMeta(input: {
  actor: PaystubAuditActor;
  payslip: PaystubAuditSubject;
  operation: string;
  resultSummary: string;
  after?: Record<string, unknown>;
  section?: string;
  status?: "SUCCESS" | "FAILED";
}) {
  return {
    sourcePage: PAYSTUB_SOURCE_PAGE,
    section: input.section || "paystub-actions",
    operation: input.operation,
    before: {
      payrollRunStatus: input.payslip.payrollRun.status,
      periodStart: toIsoDate(input.payslip.payrollRun.periodStart),
      periodEnd: toIsoDate(input.payslip.payrollRun.periodEnd),
      employeeName: `${input.payslip.employee.firstName} ${input.payslip.employee.lastName}`.trim(),
    },
    after: input.after || {},
    status: input.status || "SUCCESS",
    resultSummary: input.resultSummary,
  };
}
