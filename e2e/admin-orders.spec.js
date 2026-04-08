import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin orders management", () => {
  test("orders list page loads without errors", async ({ page }) => {
    await page.goto("/admin/orders");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/admin\/orders/);
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("new order page loads", async ({ page }) => {
    await page.goto("/admin/orders/new");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("OTC (walk-in) order page loads", async ({ page }) => {
    await page.goto("/admin/orders/otc");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("payments page loads without errors", async ({ page }) => {
    await page.goto("/admin/payments");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("customers list page loads without errors", async ({ page }) => {
    await page.goto("/admin/customers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("returns page loads without errors", async ({ page }) => {
    await page.goto("/admin/returns");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("order detail opens from list", async ({ page }) => {
    await page.goto("/admin/orders");
    await page.waitForLoadState("networkidle");

    // Try to open the first order in the list
    const firstOrderLink = page.getByRole("link", { name: /INV-|#\d+/i }).first();
    if (await firstOrderLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstOrderLink.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/admin\/orders\//);
      await expect(page.locator("body")).not.toContainText(/application error/i);
    }
  });
});
