import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");
const createRoutePath = path.join(repoRoot, "src", "app", "api", "admin", "hr", "payroll", "route.ts");
const statusRoutePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "payroll",
  "[id]",
  "route.ts",
);
const detailGenerateRoutePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "payroll",
  "[id]",
  "generate",
  "route.ts",
);
const filteredExportRoutePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "payroll",
  "[id]",
  "export-filtered",
  "route.ts",
);
const payrollDetailPagePath = path.join(
  repoRoot,
  "src",
  "app",
  "(admin)",
  "admin",
  "hr",
  "payroll",
  "[id]",
  "page.tsx",
);

function readSource(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

test("payroll create route enforces draft-only creation and blocks manual totals/status overrides", () => {
  const source = readSource(createRoutePath);
  assert.match(source, /Manual status and total overrides are not allowed when creating payroll runs\./);
  assert.match(source, /status:\s*"DRAFT"/);
  assert.match(source, /totalGross:\s*0/);
  assert.match(source, /totalNet:\s*0/);
});

test("payroll list route reuses shared bank-export readiness checks", () => {
  const source = readSource(createRoutePath);
  assert.match(source, /summarizeMissingBankDetails/);
  assert.match(source, /bankName: true/);
  assert.match(source, /bankCode: true/);
  assert.match(source, /bankBranch: true/);
  assert.match(source, /bankAccountName: true/);
  assert.match(source, /bankAccountNumber: true/);
});

test("payroll status route rejects finalize when run has no payslips", () => {
  const source = readSource(statusRoutePath);
  assert.match(source, /Cannot finalize run without at least one payslip\./);
  assert.match(source, /return NextResponse\.json\(\{ error: message \}, \{ status: 400 \}\);/);
});

test("payroll status route records detail-page audit metadata and expense creation separately", () => {
  const source = readSource(statusRoutePath);
  assert.match(source, /action: "PAYROLL_STATUS_UPDATE"/);
  assert.match(source, /action: "PAYROLL_EXPENSE_CREATE"/);
  assert.match(source, /sourcePage: "admin\/hr\/payroll\/\[id\]"/);
  assert.match(source, /operation: "create_expense_entry"/);
});

test("payroll detail generate route supports preview and manual mode when policy auto-calculation is off", () => {
  const source = readSource(detailGenerateRoutePath);
  assert.match(source, /previewOnly: z\.boolean\(\)\.optional\(\)/);
  assert.match(source, /parsed\.data\.autoCalculation === true/);
  assert.match(
    source,
    /Use manual tax and SSNIT inputs or turn it on in HR Settings\./,
  );
  assert.match(source, /return NextResponse\.json\(\{ \.\.\.result, previewOnly: true \}\);/);
  assert.doesNotMatch(source, /Turn it on before generating paystubs\./);
});

test("payroll filtered export includes YTD columns and shared YTD totals", () => {
  const source = readSource(filteredExportRoutePath);
  assert.match(source, /getPayrollRunYtdTotalsForEmployees/);
  assert.match(source, /"YTD Gross"/);
  assert.match(source, /"YTD Net"/);
  assert.match(source, /"YTD Tax"/);
  assert.match(source, /"YTD Pension"/);
});

test("payroll detail page uses confirmation dialogs for destructive lifecycle actions", () => {
  const source = readSource(payrollDetailPagePath);
  assert.match(source, /type PendingRunAction/);
  assert.match(source, /openRunActionConfirm\("FINALIZE"\)/);
  assert.match(source, /openRunActionConfirm\("CANCEL"\)/);
  assert.match(source, /openRunActionConfirm\("MARK_PAID"\)/);
  assert.match(source, /openRunActionConfirm\("CREATE_EXPENSE"\)/);
  assert.match(source, /This will remove all payslips currently attached to this draft run\./);
});

test("payroll detail page surfaces guided dialogs, audit chips, and row-level links", () => {
  const source = readSource(payrollDetailPagePath);
  assert.match(source, /Payroll policy/);
  assert.match(source, /Run input/);
  assert.match(source, /Employee and base pay/);
  assert.match(source, /Extra earnings/);
  assert.match(source, /getPayrollAuditChips/);
  assert.match(source, /Open paystub/);
  assert.match(source, /Open staff profile/);
  assert.match(source, /Bank details missing/);
  assert.match(source, /sticky top-3/);
  assert.match(source, /No payslips match this filter\./);
  assert.match(source, /Show all missing employees/);
});
