import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..", "..");
const employeesRoutePath = path.join(repoRoot, "src", "app", "api", "admin", "hr", "employees", "route.ts");
const employeeUpdateRoutePath = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "admin",
  "hr",
  "employees",
  "[id]",
  "route.ts",
);
const staffPagePath = path.join(repoRoot, "src", "app", "(admin)", "admin", "hr", "staff", "page.tsx");

function readSource(filePath: string) {
  return fs.readFileSync(filePath, "utf8");
}

test("staff employees route exposes linked-account readiness in rows and summary", () => {
  const source = readSource(employeesRoutePath);
  assert.match(source, /id: true,\s*role: true/);
  assert.match(source, /linkedAccount: linkedCount/);
  assert.match(source, /unlinkedAccount: Math\.max\(0, totalAll - linkedCount\)/);
  assert.match(source, /missingBankDetails: missingBankCount/);
  assert.match(source, /accountLinkRaw = searchParams\.get\("accountLink"\)/);
  assert.match(source, /userId: \{ not: null \}/);
});

test("staff employee update route accepts statusReason for status audit context", () => {
  const source = readSource(employeeUpdateRoutePath);
  assert.match(source, /statusReason: z\.string\(\)\.optional\(\)\.or\(z\.literal\(""\)\)/);
  assert.match(source, /reason: parsed\.data\.statusReason\?\.trim\(\) \|\| null/);
});

test("staff directory page shows retry state and confirms status changes", () => {
  const source = readSource(staffPagePath);
  assert.match(source, /Staff workspace/);
  assert.match(source, /Attention needed/);
  assert.match(source, /Directory tools/);
  assert.match(source, /Recent staff activity/);
  assert.match(source, /Staff directory data could not be loaded\./);
  assert.match(source, /The staff list is unavailable right now\./);
  assert.match(source, /Confirm status change/);
  assert.match(source, /Reason for this change/);
  assert.match(source, /This note is stored in the audit log with the staff-directory status change\./);
  assert.match(source, /Linked accounts/);
  assert.match(source, /No linked user account/);
  assert.match(source, /Missing bank details/);
  assert.match(source, /All account states/);
  assert.match(source, /Linked account/);
  assert.match(source, /No linked account/);
  assert.match(source, /Missing key fields/);
  assert.match(source, /Name A-Z/);
  assert.match(source, /Most recent hire/);
  assert.match(source, /Download error list/);
  assert.match(source, /Preview first rows/);
  assert.match(source, /Portal-ready rows/);
  assert.match(source, /Missing bank detail rows/);
  assert.match(source, /Optional staff note/);
  assert.match(source, /Employee portal access can be linked later from Users & Roles/);
  assert.match(source, /Open payslips/);
  assert.match(source, /Open compensation/);
  assert.match(source, /Create linked user/);
  assert.match(source, /Open Users &amp; Roles/);
  assert.match(source, /scrollToEmployeesTable/);
  assert.match(source, /MoreHorizontal/);
});
