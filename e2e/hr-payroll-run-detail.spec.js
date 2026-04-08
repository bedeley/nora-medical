import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockPayrollRunApis(page) {
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

  await page.route("**/api/admin/hr/payroll/run-draft", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "run-draft",
        periodStart: "2026-03-01T00:00:00.000Z",
        periodEnd: "2026-03-31T00:00:00.000Z",
        status: "DRAFT",
        runType: "REGULAR",
        totalGross: 1800,
        totalNet: 1600,
        expense: null,
        payslips: [
          {
            id: "slip-1",
            employeeId: "emp-1",
            grossPay: 1000,
            netPay: 900,
            lineItems: { tax: 100, pension: 0 },
            employee: {
              firstName: "Nora",
              lastName: "Admin",
              bankName: "Nora Bank",
              bankAccountNumber: "1234",
            },
          },
          {
            id: "slip-2",
            employeeId: "emp-2",
            grossPay: 800,
            netPay: 700,
            lineItems: { tax: 100, pension: 0 },
            employee: {
              firstName: "Sam",
              lastName: "Nurse",
              bankName: "",
              bankAccountNumber: "",
            },
          },
        ],
        ytdTotals: {
          "emp-1": { gross: 3000, net: 2700, deductions: 300, tax: 300, pension: 0 },
          "emp-2": { gross: 2500, net: 2200, deductions: 300, tax: 300, pension: 0 },
        },
      }),
    });
  });

  await page.route("**/api/admin/audit?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      String(url.searchParams.get("sourcePage")) === "admin/hr/payroll/[id]" &&
      String(url.searchParams.get("payrollRunId")) === "run-draft"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "audit-1",
            action: "PAYROLL_STATUS_UPDATE",
            createdAt: "2026-03-25T12:30:00.000Z",
            actor: { id: "admin-1", name: "Nora Admin", role: "ADMIN" },
            meta: {
              status: "SUCCESS",
              section: "run-actions",
              operation: "finalize_run",
              resultSummary: "Payroll run finalized successfully.",
            },
          },
        ]),
      });
      return;
    }
    await route.fallback();
  });
}

test.describe("HR payroll run detail page", () => {
  test("shows audit history and missing bank details drill-down", async ({ page }) => {
    await mockPayrollRunApis(page);
    await page.goto("/admin/hr/payroll/run-draft");

    await expect(page.getByText(/payroll control/i)).toBeVisible();
    await expect(page.getByText("Recent Payroll Activity", { exact: true })).toBeVisible();
    await expect(page.getByText("Payroll run finalized", { exact: true })).toBeVisible();
    await expect(page.getByText(/payroll run finalized successfully/i)).toBeVisible();
    await expect(page.getByText("Missing Bank Details", { exact: true })).toBeVisible();
    await expect(page.getByText(/employee\(s\) need bank name, bank code/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /update staff bank details/i }).first()).toBeVisible();
  });

  test("supports paystub search and clear filters controls", async ({ page }) => {
    await mockPayrollRunApis(page);
    await page.goto("/admin/hr/payroll/run-draft");

    const searchInput = page.getByPlaceholder(/search employee name or id/i);
    await searchInput.fill("nora");
    await expect(page.getByRole("row", { name: /nora admin/i })).toBeVisible();
    await expect(page.getByRole("row", { name: /sam nurse/i })).toHaveCount(0);

    await page.getByRole("button", { name: /clear filters/i }).click();
    await expect(searchInput).toHaveValue("");
    await expect(page.getByRole("row", { name: /nora admin/i })).toBeVisible();
    await expect(page.getByRole("row", { name: /sam nurse/i })).toBeVisible();
  });
});
