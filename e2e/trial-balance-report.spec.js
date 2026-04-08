import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockTrialBalanceApis(page) {
  await page.route("**/api/admin/accounting/periods", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "p1",
          name: "March 2026",
          startDate: "2026-03-01T00:00:00.000Z",
          endDate: "2026-03-31T23:59:59.999Z",
          status: "OPEN",
        },
      ]),
    });
  });

  await page.route("**/api/admin/accounting/reports/trial-balance?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        range: { start: "2026-03-01", end: "2026-03-31" },
        totals: [
          {
            accountId: "acc-1",
            code: "1000",
            name: "Cash",
            type: "ASSET",
            openingDebit: 1000,
            openingCredit: 0,
            movementDebit: 200,
            movementCredit: 50,
            closingDebit: 1150,
            closingCredit: 0,
            unusualBalance: false,
            patternSeverity: "NONE",
            patternNote: null,
          },
        ],
        summary: {
          openingDebit: 1000,
          openingCredit: 0,
          movementDebit: 200,
          movementCredit: 50,
          closingDebit: 1150,
          closingCredit: 0,
        },
      }),
    });
  });
}

test.describe("Trial balance report page", () => {
  test("loads new controls and shows last refreshed label", async ({ page }) => {
    await mockTrialBalanceApis(page);
    await page.goto("/admin/accounting/reports/trial-balance");

    await expect(page.getByRole("heading", { name: /trial balance/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /this month/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /last month/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /current fiscal period/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /export csv/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /view export audit logs/i })).toBeVisible();
    await expect(page.getByText(/shortcuts: alt\+1 this month/i)).toBeVisible();
    await expect(page.getByText(/last refreshed:/i)).toBeVisible();
  });

  test("supports date preset keyboard shortcuts", async ({ page }) => {
    await mockTrialBalanceApis(page);
    await page.goto("/admin/accounting/reports/trial-balance");

    const startInput = page.locator('input[type="date"]').nth(0);
    const endInput = page.locator('input[type="date"]').nth(1);
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

    await page.getByRole("heading", { name: /trial balance/i }).click();
    await page.keyboard.press("Alt+1");
    await expect(startInput).toHaveValue(thisMonthStart);
    await expect(endInput).toHaveValue(thisMonthEnd);

    await page.keyboard.press("Alt+2");
    await expect(startInput).toHaveValue(lastMonthStart);
    await expect(endInput).toHaveValue(lastMonthEnd);

    await page.keyboard.press("Alt+3");
    await expect(startInput).toHaveValue("2026-03-01");
    await expect(endInput).toHaveValue("2026-03-31");
  });

  test("exports CSV with correlation ID feedback", async ({ page }) => {
    await mockTrialBalanceApis(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
    });

    let sawCorrelationId = false;
    await page.route("**/api/admin/accounting/reports/trial-balance/export?**", async (route) => {
      const url = new URL(route.request().url());
      const correlationId = url.searchParams.get("correlationId");
      sawCorrelationId = Boolean(correlationId && correlationId.length > 10);
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="trial-balance-2026-03-01-2026-03-31.csv"',
        },
        body: "Code,Account\n1000,Cash\n",
      });
    });

    await page.goto("/admin/accounting/reports/trial-balance");
    await page.getByRole("button", { name: /export csv/i }).click();
    await expect.poll(() => sawCorrelationId).toBe(true);
    await expect(page.getByText(/csv export complete\. correlation id/i)).toBeVisible();
  });
});
