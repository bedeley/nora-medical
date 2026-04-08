import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin inventory and purchases", () => {
  test("inventory page loads without errors", async ({ page }) => {
    await page.goto("/admin/inventory");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/admin\/inventory/);
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("products page loads without errors", async ({ page }) => {
    await page.goto("/admin/products");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("inventory lots page loads without errors", async ({ page }) => {
    await page.goto("/admin/inventory-lots");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("inventory movements page loads without errors", async ({ page }) => {
    await page.goto("/admin/movements");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("stock adjustments page loads without errors", async ({ page }) => {
    await page.goto("/admin/stock-adjustments");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("purchases list page loads without errors", async ({ page }) => {
    await page.goto("/admin/purchases");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("suppliers page loads without errors", async ({ page }) => {
    await page.goto("/admin/suppliers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("inventory valuation page loads without errors", async ({ page }) => {
    await page.goto("/admin/accounting/inventory-valuation");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("inventory planning page loads without errors", async ({ page }) => {
    await page.goto("/admin/inventory-planning");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });
});
