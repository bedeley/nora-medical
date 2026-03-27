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

async function mockCompensationApis(page) {
  await page.route("**/api/admin/hr/employees", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          { id: "emp-1", firstName: "Nora", lastName: "Admin" },
          { id: "emp-2", firstName: "Sam", lastName: "Nurse" },
        ],
      }),
    });
  });

  await page.route("**/api/admin/hr/compensation?**", async (route) => {
    const url = new URL(route.request().url());
    const status = String(url.searchParams.get("status") || "ALL").toUpperCase();
    const rows =
      status === "PENDING"
        ? [
            {
              id: "comp-1",
              employeeId: "emp-1",
              baseSalary: 1200,
              allowances: 100,
              deductions: 50,
              bonus: 0,
              currency: "GHS",
              effectiveDate: "2026-03-01T00:00:00.000Z",
              status: "PENDING",
            },
          ]
        : [
            {
              id: "comp-1",
              employeeId: "emp-1",
              baseSalary: 1200,
              allowances: 100,
              deductions: 50,
              bonus: 0,
              currency: "GHS",
              effectiveDate: "2026-03-01T00:00:00.000Z",
              status: "PENDING",
            },
            {
              id: "comp-2",
              employeeId: "emp-2",
              baseSalary: 1500,
              allowances: 0,
              deductions: 100,
              bonus: 25,
              currency: "GHS",
              effectiveDate: "2026-02-01T00:00:00.000Z",
              status: "ACTIVE",
            },
          ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows,
        total: rows.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        filters: {
          status,
          search: url.searchParams.get("search") || null,
        },
      }),
    });
  });

  await page.route("**/api/admin/hr/payroll", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            id: "run-draft",
            periodStart: "2026-03-01T00:00:00.000Z",
            periodEnd: "2026-03-31T00:00:00.000Z",
            status: "DRAFT",
            runType: "REGULAR",
            totalGross: 2200,
            totalNet: 2000,
            payslipCount: 2,
            expense: null,
          },
          {
            id: "run-finalized",
            periodStart: "2026-02-01T00:00:00.000Z",
            periodEnd: "2026-02-28T00:00:00.000Z",
            status: "FINALIZED",
            runType: "REGULAR",
            totalGross: 2100,
            totalNet: 1900,
            payslipCount: 2,
            expense: { id: "exp-1" },
          },
        ],
      }),
    });
  });

  await page.route("**/api/admin/hr/payroll/cron/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true }),
    });
  });
}

test.describe("HR compensation page", () => {
  test("loads server-side controls and summary cards", async ({ page }) => {
    await signIn(page);
    await mockCompensationApis(page);
    await page.goto("/admin/hr/compensation");

    await expect(page.getByRole("heading", { name: /compensation & payroll/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh data/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /export csv/i })).toBeVisible();
    await expect(page.getByPlaceholder(/search employee id, name, or email/i)).toBeVisible();
    await expect(page.getByText(/pending approvals/i)).toBeVisible();
    await expect(page.getByText(/open draft runs/i)).toBeVisible();
    await expect(page.getByText(/latest run/i)).toBeVisible();
    await expect(page.getByText(/page 1 of 1/i)).toBeVisible();
  });

  test("shows strict payroll actions and supports period presets", async ({ page }) => {
    await signIn(page);
    await mockCompensationApis(page);
    await page.goto("/admin/hr/compensation");

    await expect(page.getByRole("button", { name: /finalize run/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /cancel draft/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /mark paid/i })).toBeVisible();
    await expect(page.getByText(/draft runs can be finalized or cancelled/i)).toBeVisible();
    await expect(page.getByText(/finalized runs can be marked paid/i)).toBeVisible();

    await page.getByRole("button", { name: /show advanced/i }).click();
    await page.getByRole("button", { name: /^\+ payroll run$/i }).click();

    const startInput = page.locator('input[type="date"]').first();
    const endInput = page.locator('input[type="date"]').nth(1);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

    await page.getByRole("button", { name: /this month/i }).click();
    await expect(startInput).toHaveValue(thisMonthStart);
    await expect(endInput).toHaveValue(thisMonthEnd);

    await page.getByRole("button", { name: /last month/i }).click();
    await expect(startInput).toHaveValue(lastMonthStart);
    await expect(endInput).toHaveValue(lastMonthEnd);
  });
});
