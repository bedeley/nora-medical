const { test, expect } = require("@playwright/test");

async function signIn(page) {
  const email = process.env.E2E_ADMIN_EMAIL || "";
  const password = process.env.E2E_ADMIN_PASSWORD || "";
  test.skip(!email || !password, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for admin login.");

  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|login/i }).click();
  await page.waitForURL(/\/admin/);
}

test.describe("Accounting Reconciliations Page", () => {
  test("keyboard shortcuts help + search focus", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");

    await page.keyboard.press("?");
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    await page.getByRole("button", { name: /close/i }).click();

    await page.keyboard.press("/");
    await expect(page.getByLabel("Search")).toBeFocused();
  });

  test("bulk close dialog opens and shows dry-run area", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");

    await page.getByText(/Select page/i).click();
    await page.getByRole("button", { name: /Close selected/i }).click();
    await expect(page.getByText(/Confirm Bulk Close/i)).toBeVisible();
    await expect(page.getByText(/dry-run/i)).toBeVisible();
  });

  test("bulk ZIP export button is reachable", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");
    await expect(page.getByRole("button", { name: /Export detailed CSVs/i })).toBeVisible();
  });
});
