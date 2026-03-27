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

async function mockBalanceSheetSettings(page, toleranceValue = 0.01) {
  await page.route("**/api/admin/settings/app?key=accounting.reports.balanceSheet.balanceTolerance", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        key: "accounting.reports.balanceSheet.balanceTolerance",
        value: toleranceValue,
        updatedAt: "2026-03-25T10:00:00.000Z",
      }),
    });
  });
  await page.route("**/api/admin/settings/app?key=accounting.reports.balanceSheet.deltaWarningThresholdPct", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        key: "accounting.reports.balanceSheet.deltaWarningThresholdPct",
        value: 10,
        updatedAt: "2026-03-25T10:00:00.000Z",
      }),
    });
  });
}

test.describe("Balance sheet report page", () => {
  test("shows report error state when API fails", async ({ page }) => {
    await signIn(page);

    await page.route("**/api/admin/accounting/periods", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await mockBalanceSheetSettings(page, 0.01);
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0];
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input || "");
        if (url.includes("/api/admin/accounting/reports/balance-sheet")) {
          return new Response(JSON.stringify({ error: "Balance sheet service unavailable." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalFetch(...args);
      };
    });

    await page.goto("/admin/accounting/reports/balance-sheet");
    await expect(page.getByText(/report error/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/balance sheet service unavailable/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  });

  test("shows imbalance state and correlation ID", async ({ page }) => {
    await signIn(page);

    await page.route("**/api/admin/accounting/periods", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await mockBalanceSheetSettings(page, 0.01);
    await page.route("**/api/admin/accounting/reports/balance-sheet*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          asOf: "2026-03-25",
          assets: [{ accountId: "a1", code: "1000", name: "Cash", debit: 1000, credit: 0 }],
          liabilities: [{ accountId: "l1", code: "2000", name: "Payables", debit: 0, credit: 600 }],
          equity: [{ accountId: "e1", code: "3000", name: "Capital", debit: 0, credit: 300 }],
          totals: {
            assets: 1000,
            liabilities: 600,
            equity: 300,
            liabilitiesPlusEquity: 900,
          },
        }),
      });
    });

    await page.goto("/admin/accounting/reports/balance-sheet");
    await expect(page.getByText(/not balanced/i)).toBeVisible();
    await expect(page.getByText(/export and audit correlation id:/i)).toBeVisible();
  });

  test("saves balance tolerance and shows audit confirmation", async ({ page }) => {
    await signIn(page);

    let toleranceUpdatedAt = "2026-03-25T10:00:00.000Z";
    let toleranceValue = 0.01;
    await page.route("**/api/admin/accounting/periods", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    });
    await page.route("**/api/admin/accounting/reports/balance-sheet*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          asOf: "2026-03-25",
          assets: [{ accountId: "a1", code: "1000", name: "Cash", debit: 1000, credit: 0 }],
          liabilities: [{ accountId: "l1", code: "2000", name: "Payables", debit: 0, credit: 600 }],
          equity: [{ accountId: "e1", code: "3000", name: "Capital", debit: 0, credit: 300 }],
          totals: {
            assets: 1000,
            liabilities: 600,
            equity: 300,
            liabilitiesPlusEquity: 900,
          },
        }),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.balanceSheet.balanceTolerance", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "accounting.reports.balanceSheet.balanceTolerance",
          value: toleranceValue,
          updatedAt: toleranceUpdatedAt,
        }),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.balanceSheet.deltaWarningThresholdPct", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "accounting.reports.balanceSheet.deltaWarningThresholdPct",
          value: 10,
          updatedAt: "2026-03-25T10:00:00.000Z",
        }),
      });
    });
    await page.route("**/api/admin/settings/app", async (route) => {
      const body = route.request().postDataJSON();
      toleranceValue = Number(body?.value || toleranceValue);
      toleranceUpdatedAt = "2026-03-25T10:10:00.000Z";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "accounting.reports.balanceSheet.balanceTolerance",
          value: toleranceValue,
          updatedAt: toleranceUpdatedAt,
        }),
      });
    });

    await page.goto("/admin/accounting/reports/balance-sheet");
    await page.getByLabel("Balance tolerance").fill("200");
    await page.getByRole("button", { name: /save tolerance/i }).click();
    await expect(page.getByText(/balance tolerance saved/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /view audit log/i })).toBeVisible();
    await expect(page.getByText(/balanced\. assets match liabilities plus equity\./i)).toBeVisible();
  });
});
