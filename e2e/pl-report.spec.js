import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("P&L report page", () => {
  test("loads core controls and accessibility labels", async ({ page }) => {
    await page.goto("/admin/accounting/reports/pl");

    await expect(page.getByRole("heading", { name: /profit & loss/i })).toBeVisible();
    await expect(page.getByLabel("Report start date")).toBeVisible();
    await expect(page.getByLabel("Report end date")).toBeVisible();
    await expect(page.getByLabel("Year to date toggle")).toBeVisible();
    await expect(page.getByRole("button", { name: /queue p&l csv/i })).toBeVisible();
    await expect(page.getByText(/Last refreshed:/i)).toBeVisible();
  });

  test("warns before internal navigation with unsaved variance note", async ({ page }) => {
    let plCall = 0;
    await page.route("**/api/admin/accounting/periods", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "p1", name: "2026 Fiscal Year", startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-12-31T23:59:59.999Z", status: "OPEN" },
        ]),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.pl.varianceNotes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "accounting.reports.pl.varianceNotes", value: {}, updatedAt: "2026-03-20T10:00:00.000Z" }),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.pl.varianceThresholdPct", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "accounting.reports.pl.varianceThresholdPct", value: 0, updatedAt: "2026-03-20T10:00:00.000Z" }),
      });
    });
    await page.route("**/api/admin/accounting/reports/pl?**", async (route) => {
      plCall += 1;
      const payload =
        plCall === 1
          ? { income: [{ accountId: "a1", code: "4000", name: "Sales", debit: 0, credit: 1000 }], expenses: [], incomeTotal: 1000, expenseTotal: 0, netProfit: 1000 }
          : { income: [{ accountId: "a1", code: "4000", name: "Sales", debit: 0, credit: 100 }], expenses: [], incomeTotal: 100, expenseTotal: 0, netProfit: 100 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });

    await page.goto("/admin/accounting/reports/pl");
    await page.getByLabel("Variance explanation note").fill("Unsaved explanation");

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/unsaved variance note changes/i);
      await dialog.dismiss();
    });
    await page.getByRole("link", { name: /open fiscal periods/i }).click();
    await expect(page).toHaveURL(/\/admin\/accounting\/reports\/pl/);
  });

  test("shows conflict guidance when variance note save is stale", async ({ page }) => {
    let plCall = 0;
    await page.route("**/api/admin/accounting/periods", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "p1", name: "2026 Fiscal Year", startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-12-31T23:59:59.999Z", status: "OPEN" },
        ]),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.pl.varianceNotes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: "accounting.reports.pl.varianceNotes",
          value: { "2026-01-01|2026-12-31": "Old note" },
          updatedAt: "2026-03-20T10:00:00.000Z",
        }),
      });
    });
    await page.route("**/api/admin/settings/app?key=accounting.reports.pl.varianceThresholdPct", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "accounting.reports.pl.varianceThresholdPct", value: 0, updatedAt: "2026-03-20T10:00:00.000Z" }),
      });
    });
    await page.route("**/api/admin/accounting/reports/pl?**", async (route) => {
      plCall += 1;
      const payload =
        plCall === 1
          ? { income: [{ accountId: "a1", code: "4000", name: "Sales", debit: 0, credit: 1000 }], expenses: [], incomeTotal: 1000, expenseTotal: 0, netProfit: 1000 }
          : { income: [{ accountId: "a1", code: "4000", name: "Sales", debit: 0, credit: 100 }], expenses: [], incomeTotal: 100, expenseTotal: 0, netProfit: 100 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    });
    await page.route("**/api/admin/settings/app", async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Setting accounting.reports.pl.varianceNotes changed since you opened the page. Refresh and try again." }),
      });
    });

    await page.goto("/admin/accounting/reports/pl");
    await page.getByLabel("Variance explanation note").fill("New explanation");
    await page.getByRole("button", { name: /save note/i }).click();
    await expect(page.getByText(/updated by someone else/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /reload latest note/i })).toBeVisible();
  });

  test("hydrates filters from URL and supports copy report link", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.resolve() },
      });
    });
    await page.goto("/admin/accounting/reports/pl?start=2026-02-01&end=2026-02-15&rangeMode=ytd&share=1");
    await expect(page.getByLabel("Report start date")).toHaveValue("2026-02-01");
    await expect(page.getByLabel("Report end date")).toHaveValue("2026-02-15");
    await expect(page.getByLabel("Year to date toggle")).toBeChecked();
    await page.getByRole("button", { name: /copy report link/i }).click();
    await expect(page.getByText(/report link copied/i)).toBeVisible();
  });

  test("shows export history metadata and details panel", async ({ page }) => {
    await page.route("**/api/admin/accounting/reports/pl/export/jobs?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobs: [
            {
              id: "pl-export-abc",
              type: "pl_csv",
              status: "FAILED",
              downloadUrl: "/api/admin/accounting/reports/pl/export?job=1",
              failReason: "Simulated export failure for test verification.",
              rangeSummary: "2026-01-01 to 2026-01-31",
              start: "2026-01-01",
              end: "2026-01-31",
              requestedBy: "Nora Admin",
              createdAt: Date.now(),
              expiresAt: Date.now() + 300000,
            },
          ],
          stats: {
            lastSuccessfulAt: Date.now() - 3600000,
            topRangeSummary: "2026-01-01 to 2026-01-31",
            topRangeCount: 3,
            jobsInLast30Days: 5,
          },
        }),
      });
    });
    await page.route("**/api/admin/accounting/reports/pl/export/jobs/pl-export-abc", async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, jobId: "pl-export-abc", status: "FAILED" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto("/admin/accounting/reports/pl");
    await expect(page.getByText(/most used range:/i)).toBeVisible();
    await expect(page.getByText(/requested by nora admin/i)).toBeVisible();
    await page.getByRole("button", { name: /view details/i }).click();
    await expect(page.getByText(/export job details/i)).toBeVisible();
    await expect(page.getByText(/failure reason:/i)).toBeVisible();
    await page.getByRole("button", { name: /simulate failed status/i }).click();
    await expect(page.getByText(/simulated failed export status/i)).toBeVisible();
  });
});
