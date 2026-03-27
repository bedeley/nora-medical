export type MonthlyRemittanceCsvInput = {
  monthKey: string;
  runCount: number;
  payslipCount: number;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  otherDeductions: number;
  remittance: {
    payeStatus: "PENDING" | "REMITTED";
    ssnitStatus: "PENDING" | "REMITTED";
    payeRemittedAt: string | null;
    ssnitRemittedAt: string | null;
    payePaymentMethod: "BANK" | "CASH" | null;
    ssnitPaymentMethod: "BANK" | "CASH" | null;
    payeReference: string | null;
    ssnitReference: string | null;
  };
};

export type MonthlyRemittanceEmployeeBreakdownInput = {
  employeeId: string;
  employeeName: string;
  email: string | null;
  department: string | null;
  position: string | null;
  grossPay: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  ssnitTotal: number;
};

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function buildMonthlyRemittanceCsvRows(summary: MonthlyRemittanceCsvInput) {
  const ssnitTotal = round2(Number(summary.ssnitEmployee || 0) + Number(summary.ssnitEmployer || 0));
  const rows: string[][] = [
    ["Month", String(summary.monthKey || "")],
    ["Runs", String(Number(summary.runCount || 0))],
    ["Payslips", String(Number(summary.payslipCount || 0))],
    ["Employees", String(Number(summary.employeeCount || 0))],
    ["Gross", String(Number(summary.totalGross || 0).toFixed(2))],
    ["Net", String(Number(summary.totalNet || 0).toFixed(2))],
    ["OtherDeductions", String(Number(summary.otherDeductions || 0).toFixed(2))],
    [],
    ["Liability", "Amount", "Status", "PaymentMethod", "RemittedAt", "Reference"],
    [
      "PAYE",
      String(Number(summary.payeTax || 0).toFixed(2)),
      String(summary.remittance.payeStatus || "PENDING"),
      String(summary.remittance.payePaymentMethod || ""),
      String(summary.remittance.payeRemittedAt || ""),
      String(summary.remittance.payeReference || ""),
    ],
    [
      "SSNIT",
      String(ssnitTotal.toFixed(2)),
      String(summary.remittance.ssnitStatus || "PENDING"),
      String(summary.remittance.ssnitPaymentMethod || ""),
      String(summary.remittance.ssnitRemittedAt || ""),
      String(summary.remittance.ssnitReference || ""),
    ],
    ["SSNITEmployee", String(Number(summary.ssnitEmployee || 0).toFixed(2)), "", "", "", ""],
    ["SSNITEmployer", String(Number(summary.ssnitEmployer || 0).toFixed(2)), "", "", "", ""],
  ];
  return rows;
}

export function buildPayeScheduleCsvRows(rows: MonthlyRemittanceEmployeeBreakdownInput[]) {
  return [
    ["EmployeeId", "EmployeeName", "Email", "Department", "Position", "GrossPay", "PAYE"],
    ...rows.map((row) => [
      row.employeeId,
      row.employeeName,
      row.email || "",
      row.department || "",
      row.position || "",
      Number(row.grossPay || 0).toFixed(2),
      Number(row.payeTax || 0).toFixed(2),
    ]),
  ];
}

export function buildSsnitScheduleCsvRows(rows: MonthlyRemittanceEmployeeBreakdownInput[]) {
  return [
    ["EmployeeId", "EmployeeName", "Email", "Department", "Position", "EmployeeSSNIT", "EmployerSSNIT", "SSNITTotal"],
    ...rows.map((row) => [
      row.employeeId,
      row.employeeName,
      row.email || "",
      row.department || "",
      row.position || "",
      Number(row.ssnitEmployee || 0).toFixed(2),
      Number(row.ssnitEmployer || 0).toFixed(2),
      Number(row.ssnitTotal || 0).toFixed(2),
    ]),
  ];
}

export function buildGraPayeFilingCsvRows(rows: MonthlyRemittanceEmployeeBreakdownInput[]) {
  return [
    ["Employee ID", "Employee Name", "Department", "Gross Pay", "PAYE Withheld"],
    ...rows.map((row) => [
      row.employeeId,
      row.employeeName,
      row.department || "",
      Number(row.grossPay || 0).toFixed(2),
      Number(row.payeTax || 0).toFixed(2),
    ]),
  ];
}

export function buildSsnitFilingCsvRows(rows: MonthlyRemittanceEmployeeBreakdownInput[]) {
  return [
    ["Employee ID", "Employee Name", "Employee SSNIT", "Employer SSNIT", "Total SSNIT"],
    ...rows.map((row) => [
      row.employeeId,
      row.employeeName,
      Number(row.ssnitEmployee || 0).toFixed(2),
      Number(row.ssnitEmployer || 0).toFixed(2),
      Number(row.ssnitTotal || 0).toFixed(2),
    ]),
  ];
}
