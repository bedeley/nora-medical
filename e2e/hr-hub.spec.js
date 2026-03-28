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

async function mockHrHubApis(page, trackers) {
  const summaryPayload = {
    people: {
      total: 12,
      active: 9,
      onLeave: 2,
      missingProfiles: 3,
      linkedEmployees: 8,
      unlinkedEmployees: 4,
    },
    hiring: {
      openRoles: 5,
    },
    issues: {
      open: 4,
    },
    leave: {
      pendingRequests: 2,
    },
    payroll: {
      latestRun: {
        id: "run-1",
        status: "DRAFT",
        runType: "REGULAR",
        periodStart: "2026-03-01T00:00:00.000Z",
        periodEnd: "2026-03-31T00:00:00.000Z",
        payslipCount: 7,
        missingBankDetailsCount: 1,
        hasExpenseEntry: false,
      },
    },
    portal: {
      linkedEmployees: 8,
      visibleDocuments: 6,
      visibleReviewSummaries: 3,
      awaitingVisibilityReviewSummaries: 2,
    },
    recentActivity: [
      {
        id: "activity-1",
        action: "HR_EMPLOYEE_UPDATE",
        entityType: "EMPLOYEE",
        entityId: "emp-1",
        createdAt: "2026-03-27T12:00:00.000Z",
        actor: { id: "admin-1", name: "Nora Admin", email: "nora@example.com", role: "ADMIN" },
        meta: JSON.stringify({
          resultSummary: "Employee profile updated successfully.",
          operation: "update_employee",
        }),
      },
      {
        id: "activity-2",
        action: "PAYROLL_RUN_CREATE",
        entityType: "PAYROLL_RUN",
        entityId: "run-1",
        createdAt: "2026-03-27T11:00:00.000Z",
        actor: { id: "admin-1", name: "Nora Admin", email: "nora@example.com", role: "ADMIN" },
        meta: JSON.stringify({
          resultSummary: "Payroll run created successfully.",
          operation: "create_run",
        }),
      },
      {
        id: "activity-3",
        action: "HR_LEAVE_CREATE",
        entityType: "LEAVE_REQUEST",
        entityId: "leave-1",
        createdAt: "2026-03-27T10:00:00.000Z",
        actor: { id: "admin-1", name: "Nora Admin", email: "nora@example.com", role: "ADMIN" },
        meta: JSON.stringify({
          resultSummary: "Leave request created successfully.",
          operation: "create_leave_request",
        }),
      },
    ],
  };

  await page.route("**/api/admin/hr/settings?keys=hr.workweekDays", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ values: { "hr.workweekDays": 5 } }),
    });
  });

  await page.route("**/api/admin/hr/summary", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryPayload),
    });
  });

  await page.route("**/api/admin/hr/employees", async (route) => {
    if (route.request().method() === "POST") {
      trackers.employeePayloads.push(route.request().postDataJSON() || {});
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "emp-new" }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/admin/hr/payroll", async (route) => {
    if (route.request().method() === "POST") {
      trackers.payrollPayloads.push(route.request().postDataJSON() || {});
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "run-new" }),
      });
      return;
    }
    await route.fallback();
  });
}

function toIsoDateTime(dateOnly, endOfDay = false) {
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  return new Date(`${dateOnly}${suffix}`).toISOString();
}

test.describe("HR hub page", () => {
  test("shows grouped hub sections and trims recent activity to two items", async ({ page }) => {
    const trackers = { employeePayloads: [], payrollPayloads: [] };
    await signIn(page);
    await mockHrHubApis(page, trackers);
    await page.goto("/admin/hr");

    await expect(page.getByText("HR workspace", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "People operations" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Payroll and performance" })).toBeVisible();
    await expect(page.getByText("Attention needed", { exact: true })).toBeVisible();
    await expect(page.getByText("Employee portal oversight", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent HR activity", { exact: true })).toBeVisible();
    await expect(page.getByText("Employee profile updated successfully.", { exact: true })).toBeVisible();
    await expect(page.getByText("Payroll run created successfully.", { exact: true })).toBeVisible();
    await expect(page.getByText("Leave request created successfully.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /open hr audit/i })).toBeVisible();
  });

  test("submits add employee and create payroll run quick actions", async ({ page }) => {
    const trackers = { employeePayloads: [], payrollPayloads: [] };
    await signIn(page);
    await mockHrHubApis(page, trackers);
    await page.goto("/admin/hr");

    await page.getByRole("button", { name: /add employee/i }).click();
    await page.getByPlaceholder(/first name/i).fill("Nora");
    await page.getByPlaceholder(/last name/i).fill("Hub");
    await page.getByPlaceholder(/^email$/i).fill("hub@example.com");
    await page.getByPlaceholder(/department/i).fill("HR");
    await page.getByRole("button", { name: /create employee/i }).click();

    await expect.poll(() => trackers.employeePayloads.length).toBe(1);
    expect(trackers.employeePayloads[0]).toMatchObject({
      firstName: "Nora",
      lastName: "Hub",
      email: "hub@example.com",
      department: "HR",
    });

    await page.getByRole("button", { name: /create payroll run/i }).click();
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2026-04-01");
    await dateInputs.nth(1).fill("2026-04-30");
    await page.getByRole("button", { name: /^create payroll run$/i }).last().click();

    await expect.poll(() => trackers.payrollPayloads.length).toBe(1);
    expect(trackers.payrollPayloads[0]).toMatchObject({
      periodStart: toIsoDateTime("2026-04-01"),
      periodEnd: toIsoDateTime("2026-04-30", true),
    });
  });
});
