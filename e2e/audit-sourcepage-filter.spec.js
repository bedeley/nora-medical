import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Audit source page filter guardrails", () => {
  test("sourcePage from URL is shown and clear filters resets it", async ({ page }) => {
    await page.goto("/admin/audit?sourcePage=admin/hr/hiring");

    const sourcePageSelect = page
      .locator("div.space-y-1", { has: page.getByText("Source page", { exact: true }) })
      .locator("select")
      .first();
    await expect(sourcePageSelect).toBeVisible();
    await expect(sourcePageSelect).toHaveValue("admin/hr/hiring");

    const clearFiltersButton = page.getByRole("button", { name: /^Clear filters$/ }).first();
    await clearFiltersButton.focus();
    await clearFiltersButton.press("Enter");
    await expect(sourcePageSelect).toHaveValue("");
  });
});
