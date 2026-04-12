import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin stock adjustments and supplier payments pages", () => {
  test("stock adjustments page renders key tools and audit links", async ({ page }) => {
    await page.goto("/admin/stock-adjustments");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByRole("heading", { name: "Stock adjustments" })).toBeVisible();
    await expect(page.getByText("New adjustment")).toBeVisible();
    await expect(page.getByText("Recent adjustments")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open adjustment audit" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fstock-adjustments",
    );
    await expect(page.getByPlaceholder("Search by name or SKU")).toBeVisible();
  });

  test("supplier payments page renders key tools and audit links", async ({ page }) => {
    await page.goto("/admin/supplier-payments");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByRole("heading", { name: "Supplier Payments" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open audit log" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fsupplier-payments",
    );
    await expect(page.getByText("Pending payment approvals", { exact: true })).toBeVisible();
    await expect(page.getByText("Payables Ledger", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /export/i }).click();
    await expect(page.getByRole("menuitem", { name: "Current view — CSV" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Summary snapshot — CSV" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
