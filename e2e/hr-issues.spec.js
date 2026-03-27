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

async function mockIssuesApis(page, trackers) {
  const employees = [
    { id: "emp-1", firstName: "Nora", lastName: "Admin" },
    { id: "emp-2", firstName: "Sam", lastName: "Nurse" },
  ];
  const issues = [
    {
      id: "iss-1",
      employeeId: "emp-1",
      employee: employees[0],
      type: "Attendance concern",
      severity: "HIGH",
      status: "IN_PROGRESS",
      description: "Repeated late arrivals",
      resolution: null,
      openedAt: "2026-03-01T00:00:00.000Z",
      createdAt: "2026-03-01T00:00:00.000Z",
      closedAt: null,
    },
  ];

  await page.route("**/api/admin/hr/employees", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: employees }),
    });
  });

  await page.route("**/api/admin/hr/issues/bulk-workflow", async (route) => {
    trackers.bulkPayloads.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ successCount: 1, failureCount: 0, failures: [] }),
    });
  });

  await page.route("**/api/admin/hr/issues?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: issues, total: 1, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  await page.route("**/api/admin/hr/issues", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: issues, total: 1, page: 1, pageSize: 25, totalPages: 1 }),
    });
  });

  await page.route("**/api/admin/hr/reports/issues?**", async (route) => {
    trackers.exportUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="hr_issues_test.csv"',
      },
      body: "IssueId,Employee\niss-1,Nora Admin\n",
    });
  });
}

test.describe("HR issues page", () => {
  test("shows core controls and resolution dialog for bulk close", async ({ page }) => {
    const trackers = { bulkPayloads: [], exportUrls: [] };
    await signIn(page);
    await mockIssuesApis(page, trackers);
    await page.goto("/admin/hr/issues");

    await expect(page.getByRole("heading", { name: /staff issues/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /issues audit log/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /save preset/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /copy filter link/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /export current view/i })).toBeVisible();

    await page.locator('input[aria-label="Select issue iss-1"]').check();
    await page.getByRole("button", { name: /close selected/i }).click();
    await expect(page.getByText(/bulk resolution note/i)).toBeVisible();

    await page.getByPlaceholder(/enter one resolution note/i).fill("Issue resolved with written warning.");
    await page.getByRole("button", { name: /^apply$/i }).click();

    await expect.poll(() => trackers.bulkPayloads.length).toBe(1);
    expect(trackers.bulkPayloads[0]).toMatchObject({
      targetStatus: "CLOSED",
      issueIds: ["iss-1"],
    });
  });
});
