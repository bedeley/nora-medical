export type ManualPayslipValidationInput = {
  grossPay: number;
  netPay: number;
  lineItems?: Record<string, number>;
};

export function validateManualPayslipInput(input: ManualPayslipValidationInput) {
  if (!Number.isFinite(input.grossPay) || !Number.isFinite(input.netPay)) {
    return "Gross and net pay must be valid numbers.";
  }
  if (input.grossPay < 0 || input.netPay < 0) {
    return "Gross and net pay cannot be negative.";
  }
  const lineItems = input.lineItems || {};
  const negativeEntry = Object.entries(lineItems).find(([, value]) => !Number.isFinite(value) || value < 0);
  if (negativeEntry) {
    return `Line item '${negativeEntry[0]}' cannot be negative.`;
  }
  const additions =
    Number(lineItems.allowances || 0) +
    Number(lineItems.bonus || 0) +
    Number(lineItems.otherEarnings || 0);
  if (input.netPay > input.grossPay + additions) {
    return "Net pay cannot exceed gross pay plus additions.";
  }
  return null;
}

type MissingBankInput = {
  employeeId: string;
  employee: {
    firstName?: string | null;
    lastName?: string | null;
    bankName?: string | null;
    bankCode?: string | null;
    bankBranch?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
  };
};

const BANK_EXPORT_REQUIRED_FIELDS = [
  { key: "bankName", label: "Bank name" },
  { key: "bankCode", label: "Bank code" },
  { key: "bankBranch", label: "Bank branch" },
  { key: "bankAccountName", label: "Account name" },
  { key: "bankAccountNumber", label: "Account number" },
] as const;

function hasText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export function getMissingBankFieldLabels(employee: MissingBankInput["employee"] | null | undefined) {
  if (!employee) {
    return BANK_EXPORT_REQUIRED_FIELDS.map((field) => field.label);
  }
  return BANK_EXPORT_REQUIRED_FIELDS
    .filter((field) => !hasText(employee[field.key]))
    .map((field) => field.label);
}

export function summarizeMissingBankDetails(rows: MissingBankInput[]) {
  const missing = rows
    .map((row) => ({
      row,
      missingFields: getMissingBankFieldLabels(row.employee),
    }))
    .filter((entry) => entry.missingFields.length > 0);
  return {
    count: missing.length,
    entries: missing.map(({ row, missingFields }) => ({
      employeeId: row.employeeId,
      employee:
        `${row.employee.firstName || ""} ${row.employee.lastName || ""}`.trim() || row.employeeId,
      missingFields,
    })),
  };
}
