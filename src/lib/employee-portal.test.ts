import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_LEAVE_PAGE,
  EMPLOYEE_PORTAL_PAYSTUB_PAGE,
  EMPLOYEE_PORTAL_PAYSTUBS_PAGE,
  EMPLOYEE_PORTAL_REVIEWS_PAGE,
  normalizeEmployeePortalSourcePage,
} from "@/lib/employee-portal";

test("normalizeEmployeePortalSourcePage keeps known employee portal pages", () => {
  assert.equal(normalizeEmployeePortalSourcePage(EMPLOYEE_PORTAL_HOME_PAGE), EMPLOYEE_PORTAL_HOME_PAGE);
  assert.equal(
    normalizeEmployeePortalSourcePage(`/${EMPLOYEE_PORTAL_PAYSTUB_PAGE}`),
    EMPLOYEE_PORTAL_PAYSTUB_PAGE,
  );
  assert.equal(normalizeEmployeePortalSourcePage(EMPLOYEE_PORTAL_PAYSTUBS_PAGE), EMPLOYEE_PORTAL_PAYSTUBS_PAGE);
  assert.equal(normalizeEmployeePortalSourcePage(EMPLOYEE_PORTAL_DOCUMENTS_PAGE), EMPLOYEE_PORTAL_DOCUMENTS_PAGE);
  assert.equal(normalizeEmployeePortalSourcePage(EMPLOYEE_PORTAL_LEAVE_PAGE), EMPLOYEE_PORTAL_LEAVE_PAGE);
  assert.equal(normalizeEmployeePortalSourcePage(EMPLOYEE_PORTAL_REVIEWS_PAGE), EMPLOYEE_PORTAL_REVIEWS_PAGE);
});

test("normalizeEmployeePortalSourcePage falls back to portal home", () => {
  assert.equal(normalizeEmployeePortalSourcePage(""), EMPLOYEE_PORTAL_HOME_PAGE);
  assert.equal(normalizeEmployeePortalSourcePage("account/employee/other"), EMPLOYEE_PORTAL_HOME_PAGE);
});

test("employee portal loader does not silently cap core employee history sections", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/employee-portal.ts"), "utf8");
  assert.doesNotMatch(source, /payslips:\s*{[\s\S]*?take:\s*12/);
  assert.doesNotMatch(source, /leaveRequests:\s*{[\s\S]*?take:\s*12/);
  assert.doesNotMatch(source, /documents:\s*{[\s\S]*?take:\s*12/);
  assert.doesNotMatch(source, /reviews:\s*employeePortalReviewsEnabled\(\)\s*\?\s*{[\s\S]*?take:\s*12/);
});
