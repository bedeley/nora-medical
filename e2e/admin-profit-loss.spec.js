import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin profit and loss page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/admin/settings/app?key=accounting.reporting.useLedger", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ value: false }),
      });
    });

    await page.route("**/api/admin/summary?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: {
            totalRevenue: 1000,
            totalRefunds: 50,
            netRevenue: 950,
            totalCOGS: 400,
            totalExpense: 250,
            profit: 300,
            margin: 31.6,
            totalTaxCollected: 50,
            totalDiscounts: 20,
            discountedOrders: 2,
            expenseBreakdown: [{ category: "Payroll", amount: 150 }],
          },
          trend: [
            {
              date: "2026-03-01",
              revenue: 400,
              refunds: 20,
              netRevenue: 380,
              cogs: 160,
              expense: 100,
              payrollExpense: 60,
              profit: 120,
              margin: 31.6,
              cashIn: 200,
              cashOut: 20,
              netCash: 180,
              outstanding: 50,
              orderCount: 4,
              averageOrderValue: 95,
              deliveredCount: 3,
              partiallyDeliveredCount: 0,
              returnedCount: 1,
              pendingCount: 0,
            },
            {
              date: "2026-03-02",
              revenue: 600,
              refunds: 30,
              netRevenue: 570,
              cogs: 240,
              expense: 150,
              payrollExpense: 90,
              profit: 180,
              margin: 31.6,
              cashIn: 300,
              cashOut: 30,
              netCash: 270,
              outstanding: 50,
              orderCount: 6,
              averageOrderValue: 95,
              deliveredCount: 4,
              partiallyDeliveredCount: 1,
              returnedCount: 0,
              pendingCount: 1,
            },
          ],
          groupBy: "day",
        }),
      });
    });

    await page.route("**/api/admin/accounting/reports/ledger-summary?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          summary: {
            totalRevenue: 980,
            totalRefunds: 48,
            netRevenue: 932,
            totalCOGS: 390,
            totalExpense: 240,
            profit: 302,
            margin: 32.4,
            totalTaxCollected: 49,
            totalDiscounts: 18,
            discountedOrders: 2,
            expenseBreakdown: [{ category: "Payroll", amount: 145 }],
          },
          trend: [
            {
              date: "2026-03-01",
              revenue: 390,
              refunds: 18,
              netRevenue: 372,
              cogs: 155,
              expense: 95,
              payrollExpense: 58,
              profit: 122,
              margin: 32.8,
              cashIn: 195,
              cashOut: 18,
              netCash: 177,
              outstanding: 0,
              orderCount: 0,
              averageOrderValue: 0,
              deliveredCount: 0,
              partiallyDeliveredCount: 0,
              returnedCount: 0,
              pendingCount: 0,
            },
            {
              date: "2026-03-02",
              revenue: 590,
              refunds: 30,
              netRevenue: 560,
              cogs: 235,
              expense: 145,
              payrollExpense: 87,
              profit: 180,
              margin: 32.1,
              cashIn: 295,
              cashOut: 30,
              netCash: 265,
              outstanding: 0,
              orderCount: 0,
              averageOrderValue: 0,
              deliveredCount: 0,
              partiallyDeliveredCount: 0,
              returnedCount: 0,
              pendingCount: 0,
            },
          ],
          groupBy: "day",
        }),
      });
    });

    await page.goto("/admin/profit-loss");
    await page.waitForLoadState("networkidle");
  });

  test("renders financial, operational, and alignment sections", async ({ page }) => {
    await expect(page.getByRole("heading", { name: /profit & loss/i })).toBeVisible();
    await expect(page.getByText(/^report view$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /operational view/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /posted ledger view/i })).toBeVisible();
    await expect(page.getByText(/^financial kpis$/i)).toBeVisible();
    await expect(page.getByText(/^ledger alignment$/i)).toBeVisible();
    await expect(page.getByText(/^operational context$/i)).toBeVisible();
    await expect(page.getByText(/^expense breakdown$/i)).toBeVisible();
  });

  test("switches to posted ledger view and updates the URL", async ({ page }) => {
    await expect(page.getByText(/current source: operational view/i)).toBeVisible();

    await page.getByRole("button", { name: /posted ledger view/i }).click();

    await expect(page).toHaveURL(/source=ledger/);
    await expect(page.getByText(/current source: posted ledger view/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /open accounting reports/i })).toBeVisible();
    await expect(page.getByText(/these kpis are sourced from posted journal entries/i)).toBeVisible();
  });
});
