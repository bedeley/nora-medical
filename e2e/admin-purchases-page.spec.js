import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin purchases page", () => {
  test("renders purchases tools without client or server errors", async ({ page }) => {
    await page.goto("/admin/purchases");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByText("Record restocks and update weighted-average cost")).toBeVisible();
    await expect(page.locator("#purchase-form-panel")).toBeVisible();

    const purchaseForm = page.locator("#purchase-form");
    if (!(await purchaseForm.isVisible())) {
      await page.getByRole("button", { name: "Show form" }).click();
    }
    await expect(purchaseForm).toBeVisible();

    await page.getByRole("button", { name: "Export" }).click();
    await expect(page.getByRole("menuitem", { name: "Export CSV" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Export summary CSV" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Export summary PDF" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Saved filters" }).click();
    await page.getByRole("menuitem", { name: "Save current filter" }).click();
    await expect(page.getByRole("dialog")).toContainText("Save current filter");
    await page.getByLabel("Filter name").fill("Playwright purchases smoke");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.locator("#supplierFilter").fill("Playwright Supplier");
    await expect(page.getByRole("button", { name: /Supplier: Playwright Supplier/i })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("button", { name: /Supplier: Playwright Supplier/i })).toHaveCount(0);
  });
});
