import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin product profit and loss page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/admin/product-pl?**", async (route) => {
      const url = new URL(route.request().url());
      const requestedPage = Number(url.searchParams.get("page") || "1");
      const pageSize = Number(url.searchParams.get("pageSize") || "25");

      const rows = [
        {
          productId: "prod-a",
          name: "Alpha Syringe",
          qty: 9,
          revenue: 180,
          costTotal: 90,
          weightedCost: 10,
          profit: 90,
          margin: 50,
          rank: 1,
        },
        {
          productId: "prod-b",
          name: "Beta Gloves",
          qty: 6,
          revenue: 120,
          costTotal: 72,
          weightedCost: 12,
          profit: 48,
          margin: 40,
          rank: 2,
        },
        {
          productId: "prod-c",
          name: "Gamma Gauze",
          qty: 2,
          revenue: 30,
          costTotal: 24,
          weightedCost: 12,
          profit: 6,
          margin: 20,
          rank: 3,
        },
      ];

      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const currentPage = Math.min(requestedPage, totalPages);
      const startIdx = (currentPage - 1) * pageSize;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          range: "month",
          start: null,
          end: null,
          total,
          page: currentPage,
          pageSize,
          periodTotals: {
            revenue: 330,
            cost: 186,
            profit: 144,
            qty: 17,
            margin: 43.6,
            productCount: 3,
          },
          rows: rows.slice(startIdx, startIdx + pageSize),
        }),
      });
    });
  });

  test("renders the current filter shell and summary sections", async ({ page }) => {
    await page.goto("/admin/profit-loss/products");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: /product performance \(p&l\)/i })).toBeVisible();
    await expect(page.getByText(/^filters$/i)).toBeVisible();
    await expect(page.getByText(/all products in period/i)).toBeVisible();
    await expect(page.getByText(/performance details/i)).toBeVisible();
    await expect(page.getByText(/all products in period/i)).toBeVisible();
    await expect(page.getByText(/net qty sold/i)).toBeVisible();
    await expect(page.getByText(/total revenue/i)).toBeVisible();
    await expect(page.getByText(/total profit/i)).toBeVisible();
  });

  test("normalizes an out-of-range page from the API and keeps data visible", async ({ page }) => {
    await page.goto("/admin/profit-loss/products?page=999&pageSize=2");
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole("cell", { name: "Gamma Gauze" })).toBeVisible();
    await expect(page.getByText(/showing 1 of 3 products/i)).toBeVisible();
  });
});
