/**
 * Visual regression tests — screenshot baselines for key pages.
 *
 * First run: `pnpm playwright test visual-regression --update-snapshots`
 * Subsequent runs: `pnpm playwright test visual-regression`
 *
 * Screenshots are stored in e2e/snapshots/ and should be committed to git.
 * CI must run on the same OS/browser version to get deterministic pixel diffs.
 */
import { test, expect } from "@playwright/test";

// ── Public / storefront pages ─────────────────────────────────────────────

test.describe("Visual regression – storefront", () => {
  test("products catalog page", async ({ page }) => {
    await page.goto("/products");
    await page.waitForLoadState("networkidle");
    // Mask dynamic elements that change between runs
    await expect(page).toHaveScreenshot("products-catalog.png", {
      fullPage: true,
      mask: [page.locator("[data-testid='cart-count']")],
      maxDiffPixelRatio: 0.02,
    });
  });

  test("login page", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("login-page.png", {
      maxDiffPixelRatio: 0.01,
    });
  });

  test("register page", async ({ page }) => {
    await page.goto("/register");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("register-page.png", {
      maxDiffPixelRatio: 0.01,
    });
  });
});

// ── Admin pages ────────────────────────────────────────────────────────────

test.describe("Visual regression – admin", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("admin dashboard", async ({ page }) => {
    await page.goto("/admin/dashboard?groupBy=day");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/margin trend/i)).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot("admin-dashboard.png", {
      fullPage: true,
      // Mask live counters / timestamps that change between runs
      mask: [
        page.locator("time"),
        page.locator("[data-testid='live-count']"),
      ],
      maxDiffPixelRatio: 0.03,
      timeout: 15000,
    });
  });

  test("accounting overview page", async ({ page }) => {
    await page.goto("/admin/accounting");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("admin-accounting.png", {
      fullPage: true,
      mask: [page.locator("time")],
      maxDiffPixelRatio: 0.03,
    });
  });

  test("orders list page", async ({ page }) => {
    await page.goto("/admin/orders");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("admin-orders.png", {
      fullPage: true,
      mask: [page.locator("time"), page.locator("td:has(time)")],
      maxDiffPixelRatio: 0.03,
    });
  });

  test("inventory list page", async ({ page }) => {
    await page.goto("/admin/inventory");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("admin-inventory.png", {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });
});
