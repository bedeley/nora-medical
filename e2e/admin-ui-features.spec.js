/**
 * E2E tests for admin UI features added in Phase 4:
 * - Command Palette (Cmd/Ctrl + K)
 * - AdminBreadcrumb navigation
 * - Accounting dashboard KPI cards
 */
import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function openCommandPalette(page) {
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
  });
}

test.describe("Command Palette (Cmd+K)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/accounting/reconciliations");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /open command palette/i })).toBeVisible();
  });

  test("opens on Ctrl+K and shows search dialog", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await expect(dialog).toHaveCount(0);
    await openCommandPalette(page);
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel(/search admin pages/i)).toBeFocused();
  });

  test("opens on the Search trigger button", async ({ page }) => {
    await page.getByRole("button", { name: /open command palette/i }).click();
    await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible();
  });

  test("closes on Escape", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await openCommandPalette(page);
    await expect(dialog).toBeVisible();
    await page.getByLabel(/search admin pages/i).press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  test("filters results when typing", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await openCommandPalette(page);
    await expect(dialog).toBeVisible();

    await page.getByLabel(/search admin pages/i).fill("orders");
    const options = dialog.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThan(0);
    expect((await options.first().textContent())?.toLowerCase()).toMatch(/order/i);
  });

  test("shows 'No pages found' for unmatched query", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await openCommandPalette(page);
    await page.getByLabel(/search admin pages/i).fill("zzznothingmatches999");
    await expect(dialog.getByText(/no pages found/i)).toBeVisible();
  });

  test("navigates to selected page on Enter", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    const searchInput = page.getByLabel(/search admin pages/i);
    await openCommandPalette(page);
    await searchInput.fill("orders");
    await expect(dialog.getByRole("option").first()).toBeVisible();
    await searchInput.press("Enter");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/admin\/.+/);
  });

  test("navigates on option click and closes dialog", async ({ page }) => {
    const dialog = page.getByRole("dialog", { name: /command palette/i });
    await openCommandPalette(page);
    await page.getByLabel(/search admin pages/i).fill("inventory");
    const firstOption = dialog.getByRole("option").first();
    await expect(firstOption).toBeVisible();
    await firstOption.click();
    await page.waitForLoadState("networkidle");
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/admin\/.+/);
  });
});

test.describe("AdminBreadcrumb navigation", () => {
  test("breadcrumb is absent on the /admin root page", async ({ page }) => {
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("navigation", { name: /breadcrumb/i })).not.toBeVisible();
  });

  test("breadcrumb shows on /admin/orders", async ({ page }) => {
    await page.goto("/admin/orders");
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link")).toBeVisible();
    const currentCrumb = nav.locator("[aria-current='page']");
    await expect(currentCrumb).toBeVisible();
    await expect(currentCrumb).toContainText(/orders/i);
  });

  test("breadcrumb ancestor link navigates back", async ({ page }) => {
    await page.goto("/admin/accounting/aging");
    await page.waitForLoadState("networkidle");
    const nav = page.getByRole("navigation", { name: /breadcrumb/i });
    await expect(nav).toBeVisible();
    const accountingLink = nav.getByRole("link", { name: /accounting/i });
    if (await accountingLink.isVisible()) {
      await accountingLink.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/admin\/accounting/);
    }
  });
});

test.describe("Accounting dashboard", () => {
  test("shows KPI metric cards", async ({ page }) => {
    await page.goto("/admin/accounting");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/cash on hand/i)).toBeVisible();
    await expect(page.getByText(/bank balance/i)).toBeVisible();
    await expect(page.getByText(/accounts receivable/i)).toBeVisible();
    await expect(page.getByText(/accounts payable/i)).toBeVisible();
  });

  test("KPI card links navigate to sub-pages", async ({ page }) => {
    await page.goto("/admin/accounting");
    await page.waitForLoadState("networkidle");
    const bankBalanceLink = page.getByRole("link", { name: /bank balance/i });
    if (await bankBalanceLink.isVisible()) {
      await bankBalanceLink.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/admin\/accounting\/banks/);
    }
  });

  test("Quick Actions buttons are visible", async ({ page }) => {
    await page.goto("/admin/accounting");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("link", { name: /journal entry/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /AR aging|AR\/AP aging/i })).toBeVisible();
  });
});
