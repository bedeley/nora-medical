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

test.describe("Audit source page filter guardrails", () => {
  test("sourcePage from URL is shown and clear filters resets it", async ({ page }) => {
    await signIn(page);
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

