import { test, expect } from "@playwright/test";

async function signIn(page) {
  const email = process.env.E2E_ADMIN_EMAIL || "";
  const password = process.env.E2E_ADMIN_PASSWORD || "";
  test.skip(!email || !password, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for admin login.");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto("/login?callbackUrl=/admin");
    if (!page.url().includes("/login")) break;
    await page.getByPlaceholder(/email or username/i).waitFor({ state: "visible", timeout: 10000 });
    await page.getByPlaceholder(/email or username/i).fill(email);
    await page.getByPlaceholder(/^password$/i).fill(password);
    await page.getByRole("button", { name: /sign in|login/i }).click();
    await page.waitForLoadState("networkidle");
    await page.goto("/admin");
    if (page.url().includes("/admin")) break;
    await page.waitForTimeout(1000);
  }
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin/);
}

async function mockStaffApis(page, trackers) {
  const employee = {
    id: "emp-1",
    firstName: "Nora",
    lastName: "Admin",
    email: "nora@example.com",
    phone: "1234567890",
    department: "Operations",
    position: "Coordinator",
    status: "ACTIVE",
    updatedAt: "2026-03-26T10:00:00.000Z",
    hireDate: "2025-01-01T00:00:00.000Z",
    terminationDate: null,
    bankName: "Nora Bank",
    bankAccountName: "Nora Admin",
    bankAccountNumber: "00112233",
    bankCode: "123",
    bankBranch: "Main",
    compensations: [],
    issues: [],
    onboardingTasks: [
      {
        id: "task-1",
        title: "Submit ID",
        status: "PENDING",
        dueDate: "2026-03-30T00:00:00.000Z",
        completedAt: null,
        updatedAt: "2026-03-26T09:00:00.000Z",
      },
    ],
  };

  await page.route("**/api/admin/hr/employees/emp-1", async (route) => {
    if (route.request().method() === "PATCH") {
      trackers.employeePatchPayloads.push(route.request().postDataJSON() || {});
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(employee) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(employee) });
  });

  await page.route("**/api/admin/hr/payslips?employeeId=emp-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) });
  });
  await page.route("**/api/admin/hr/reviews?employeeId=emp-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) });
  });
  await page.route("**/api/admin/hr/documents?employeeId=emp-1", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) });
  });
  await page.route("**/api/admin/hr/leave?employeeId=emp-1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            id: "leave-1",
            employeeId: "emp-1",
            type: "ANNUAL",
            status: "REQUESTED",
            startDate: "2026-03-28T00:00:00.000Z",
            endDate: "2026-03-29T00:00:00.000Z",
            updatedAt: "2026-03-26T10:05:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/admin/hr/settings?keys=hr.workweekDays", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ values: { "hr.workweekDays": 5 } }),
    });
  });
  await page.route("**/api/admin/audit?**employeeId=emp-1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "log-1",
          action: "HR_EMPLOYEE_UPDATE",
          createdAt: "2026-03-26T11:00:00.000Z",
          actor: { name: "Nora Admin", email: "nora@example.com" },
          meta: {
            section: "contact-details",
            operation: "update_contact_details",
            resultSummary: "Employee profile updated successfully.",
          },
        },
      ]),
    });
  });

  await page.route("**/api/admin/hr/onboarding/task-1", async (route) => {
    trackers.taskPatchPayloads.push(route.request().postDataJSON() || {});
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/admin/hr/leave/leave-1", async (route) => {
    trackers.leavePatchPayloads.push(route.request().postDataJSON() || {});
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

test.describe("HR staff profile page", () => {
  test("enforces save guards and sends conflict-safe contact payload", async ({ page }) => {
    const trackers = { employeePatchPayloads: [], taskPatchPayloads: [], leavePatchPayloads: [] };
    await signIn(page);
    await mockStaffApis(page, trackers);
    await page.goto("/admin/hr/staff/emp-1");

    const editContact = page.getByRole("button", { name: /^edit$/i }).nth(1);
    const saveContact = page.getByRole("button", { name: /save contact/i });
    await expect(page.getByPlaceholder(/email address/i)).toBeDisabled();
    await expect(saveContact).toHaveCount(0);
    await editContact.click();
    await expect(page.getByPlaceholder(/email address/i)).toBeEnabled();
    await page.getByPlaceholder(/email address/i).fill("nora.updated@example.com");
    await expect(saveContact).toBeEnabled();
    await saveContact.click();

    await expect.poll(() => trackers.employeePatchPayloads.length).toBe(1);
    expect(trackers.employeePatchPayloads[0]).toMatchObject({
      sourcePage: "/admin/hr/staff/emp-1",
      section: "contact-details",
      operation: "update_contact_details",
      expectedUpdatedAt: "2026-03-26T10:00:00.000Z",
    });
    await expect(page.getByText(/recent profile activity/i)).toBeVisible();
  });

  test("supports onboarding toggle and leave decision flow from profile", async ({ page }) => {
    const trackers = { employeePatchPayloads: [], taskPatchPayloads: [], leavePatchPayloads: [] };
    await signIn(page);
    await mockStaffApis(page, trackers);
    await page.goto("/admin/hr/staff/emp-1");

    await page.getByRole("checkbox").first().check();
    await expect.poll(() => trackers.taskPatchPayloads.length).toBe(1);
    expect(trackers.taskPatchPayloads[0]).toMatchObject({
      status: "COMPLETE",
      sourcePage: "/admin/hr/staff/emp-1",
    });

    await page.getByRole("button", { name: /^reject$/i }).click();
    await page.getByPlaceholder(/decision note/i).fill("Insufficient leave balance");
    await page.getByRole("button", { name: /^confirm$/i }).click();
    await expect.poll(() => trackers.leavePatchPayloads.length).toBe(1);
    expect(trackers.leavePatchPayloads[0]).toMatchObject({
      status: "REJECTED",
      decisionNote: "Insufficient leave balance",
      expectedUpdatedAt: "2026-03-26T10:05:00.000Z",
    });
  });
});
