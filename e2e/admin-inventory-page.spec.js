import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin inventory page", () => {
  test("shows clear result copy and opens a prefilled purchase form from the item link", async ({
    page,
  }) => {
    await page.goto("/admin/inventory");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(
      /application error|server error/i,
    );
    await expect(page.getByText("Inventory Valuation")).toBeVisible();
    await expect(
      page.getByText(/products match current filters/i).first(),
    ).toBeVisible();

    const itemLink = page
      .locator('table tbody a[href*="/admin/purchases?product="][href*="new=1"]')
      .filter({ hasText: /\S/ })
      .first();

    await expect(itemLink).toBeVisible();
    const itemText = (await itemLink.textContent())?.trim() || "";
    await expect(itemLink).toHaveAttribute("href", /[?&]new=1/);

    await itemLink.click();
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/admin\/purchases\?product=.*(?:&|^)new=1/);
    await expect(page.locator("#purchase-form-panel")).toBeVisible();
    await expect(page.locator("#purchase-form")).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide form" })).toBeVisible();
    await expect(page.locator("#product")).not.toHaveValue("");
    await expect(page.locator("#qty")).toBeVisible();

    if (itemText) {
      const productValue = await page.locator("#product").inputValue();
      expect(productValue.toLowerCase()).toContain(
        itemText.toLowerCase().slice(0, Math.min(itemText.length, 12)),
      );
    }
  });
});
