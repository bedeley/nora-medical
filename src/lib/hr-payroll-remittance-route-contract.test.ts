import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");
const routePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "payroll",
  "statutory",
  "summary",
  "route.ts",
);
const exportLogRoutePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "payroll",
  "statutory",
  "export-log",
  "route.ts",
);
const remittancePagePath = path.join(
  repoRoot,
  "src",
  "app",
  "(admin)",
  "admin",
  "hr",
  "payroll",
  "remittance",
  "page.tsx",
);

function readSource() {
  return fs.readFileSync(routePath, "utf8");
}
function readExportLogSource() {
  return fs.readFileSync(exportLogRoutePath, "utf8");
}
function readRemittancePageSource() {
  return fs.readFileSync(remittancePagePath, "utf8");
}

test("remittance route requires payment method when setting remitted", () => {
  const source = readSource();
  assert.match(source, /Select payment method: bank or cash\./);
  assert.match(source, /status === "REMITTED" && !paymentMethod/);
});

test("remittance route forbids reverting remitted status to pending", () => {
  const source = readSource();
  assert.match(source, /Remitted status is locked and cannot be changed back to pending\./);
  assert.match(source, /status === "PENDING"/);
});

test("remittance route audit metadata keeps compact liability-focused fields", () => {
  const source = readSource();
  assert.match(source, /liability:/);
  assert.match(source, /month:/);
  assert.match(source, /before:\s*{\s*status:/s);
  assert.match(source, /after:\s*{\s*status:/s);
  assert.match(source, /schedule:\s*{\s*employeeCount:/s);
});

test("remittance summary GET includes employee breakdown schedule", () => {
  const source = readSource();
  assert.match(source, /getMonthlyStatutoryEmployeeBreakdown/);
  assert.match(source, /employeeBreakdown/);
});

test("remittance summary and UI include actor label fallback for last action", () => {
  const routeSource = readSource();
  const pageSource = readRemittancePageSource();
  assert.match(routeSource, /toActorLabel/);
  assert.match(routeSource, /updatedByLabel/);
  assert.match(pageSource, /updatedByLabel \|\| summary\.remittance\.updatedBy \|\| "System"/);
});

test("remittance export-log route records liability-specific audit metadata", () => {
  const source = readExportLogSource();
  assert.match(source, /HR_PAYROLL_REMITTANCE_EXPORT_CSV/);
  assert.match(source, /sourcePage/);
  assert.match(source, /section:\s*"statutory-remittance"/);
  assert.match(source, /operation/);
  assert.match(source, /resultSummary/);
});
