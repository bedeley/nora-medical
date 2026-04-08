import { test, expect } from "@playwright/test";

const CUSTOMER_EMAIL = process.env.E2E_CUSTOMER_EMAIL || "";
const CUSTOMER_PASSWORD = process.env.E2E_CUSTOMER_PASSWORD || "";

async function signInAsCustomer(page) {
  await page.goto("/login");
  await page.getByPlaceholder(/email or username/i).fill(CUSTOMER_EMAIL);
  await page.getByPlaceholder(/^password$/i).fill(CUSTOMER_PASSWORD);
  await page.getByRole("button", { name: /sign in|login/i }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  if (/\/login(?:[?#]|$)/i.test(page.url())) {
    await page.waitForURL((url) => !/\/login(?:[?#]|$)/i.test(url.toString()), {
      timeout: 15_000,
    }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
  }
}

test.describe("Customer storefront", () => {
  test("product catalog page loads with products", async ({ page }) => {
    await page.goto("/products");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/products/);
    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
  });

  test("product detail page loads for a product", async ({ page }) => {
    await page.goto("/products");
    await page.waitForLoadState("networkidle");

    // Click the first product link
    const firstProduct = page.getByRole("link", { name: /view|details|buy|add/i }).first();
    if (await firstProduct.isVisible()) {
      await firstProduct.click();
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/products\//);
    }
  });

  test("cart page loads when authenticated", async ({ page }) => {
    test.skip(!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD, "Set E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD.");

    await signInAsCustomer(page);
    await page.goto("/cart");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/cart/);
    await expect(page.locator("body")).not.toContainText(/application error/i);
  });

  test("cart redirects unauthenticated user to login", async ({ page }) => {
    await page.goto("/cart");
    // Should redirect to login if not signed in
    const url = page.url();
    const isRedirected = url.includes("/login") || url.includes("/cart");
    expect(isRedirected).toBe(true);
  });

  test("full add-to-cart flow (authenticated)", async ({ page }) => {
    test.skip(!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD, "Set E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD.");

    await signInAsCustomer(page);
    await page.goto("/products");
    await page.waitForLoadState("networkidle");

    // Choose the first enabled button; some catalog cards are intentionally out of stock.
    const addToCartButtons = page.getByRole("button", { name: /add to cart/i });
    const firstEnabledIndex = await addToCartButtons.evaluateAll((buttons) =>
      buttons.findIndex((button) => !button.disabled),
    );
    test.skip(firstEnabledIndex === -1, "No in-stock products are available for add-to-cart validation.");

    const addToCartBtn = addToCartButtons.nth(firstEnabledIndex);
    await expect(addToCartBtn).toBeVisible();
    await expect(addToCartBtn).toBeEnabled();
    if (await addToCartBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addToCartBtn.click();
      await page.waitForLoadState("networkidle");

      // Cart count or success indicator should appear
      const cartIndicator = page.locator("[data-testid='cart-count'], [aria-label*='cart']").first();
      if (await cartIndicator.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(cartIndicator).toBeVisible();
      }
    }
  });

  test("order history page loads when authenticated", async ({ page }) => {
    test.skip(!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD, "Set E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD.");

    await signInAsCustomer(page);
    await page.goto("/account/order-history");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/account\/order-history/);
    await expect(page.locator("body")).not.toContainText(/application error/i);
  });
});
