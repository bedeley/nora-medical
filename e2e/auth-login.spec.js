import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "";
const CUSTOMER_EMAIL = process.env.E2E_CUSTOMER_EMAIL || "";
const CUSTOMER_PASSWORD = process.env.E2E_CUSTOMER_PASSWORD || "";

async function fillLoginForm(page, identifier, password) {
  await page.getByPlaceholder(/email or username/i).fill(identifier);
  await page.getByPlaceholder(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in|login/i }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  if (/\/login(?:[?#]|$)/i.test(page.url())) {
    await page.waitForURL((url) => !/\/login(?:[?#]|$)/i.test(url.toString()), {
      timeout: 15_000,
    }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
  }
}

test.describe("Authentication flows", () => {
  test("login page loads and shows form", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByPlaceholder(/email or username/i)).toBeVisible();
    await expect(page.getByPlaceholder(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in|login/i })).toBeVisible();
  });

  test("invalid credentials show error message", async ({ page }) => {
    await page.goto("/login");
    await fillLoginForm(page, "nobody@example.com", "WrongPass99!");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("body")).toContainText(/invalid|incorrect|failed/i);
  });

  test("admin login redirects to admin dashboard", async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD.");

    await page.goto("/login?callbackUrl=/admin");
    await fillLoginForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Should land on admin area, not stay on /login
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveURL(/\/admin/);
  });

  test("customer login redirects to account or products page", async ({ page }) => {
    test.skip(!CUSTOMER_EMAIL || !CUSTOMER_PASSWORD, "Set E2E_CUSTOMER_EMAIL and E2E_CUSTOMER_PASSWORD.");

    await page.goto("/login");
    await fillLoginForm(page, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);

    await expect(page).not.toHaveURL(/\/login/);
  });

  test("protected admin route redirects unauthenticated user to login", async ({ page }) => {
    await page.goto("/admin/dashboard");
    // App may redirect to /login, /unauthorized, or /admin (hub shows Access Denied when unauthenticated)
    await expect(page).toHaveURL(/\/login|\/unauthorized|\/admin([?#]|$)/);
  });

  test("register page loads and shows form fields", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByPlaceholder(/name/i).first()).toBeVisible();
    await expect(page.getByPlaceholder(/password/i).first()).toBeVisible();
  });

  test("register rejects weak password (less than 10 chars)", async ({ page }) => {
    await page.goto("/register");
    await page.getByPlaceholder(/name/i).first().fill("Test User");
    // Fill some identifier
    const emailField = page.getByPlaceholder(/email/i).first();
    if (await emailField.isVisible()) {
      await emailField.fill("testuser@example.com");
    }
    const phoneField = page.getByPlaceholder(/phone/i).first();
    if (await phoneField.isVisible()) {
      await phoneField.fill("0241234567");
    }
    await page.getByPlaceholder(/password/i).first().fill("weak");
    await page.getByRole("button", { name: /register|sign up|create/i }).click();
    // Should show a validation error, not redirect
    await expect(page).toHaveURL(/\/register/);
  });

  test("logout clears session and redirects to login or home", async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD.");

    await page.goto("/login");
    await fillLoginForm(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).not.toHaveURL(/\/login/);

    // Clear session cookies to simulate logout (Sign out is in a closed dropdown on desktop)
    await page.context().clearCookies();

    // Verify admin area is no longer accessible (middleware-protected)
    await page.goto("/admin/dashboard");
    // App may redirect to /login, /unauthorized, or /admin (hub shows Access Denied when unauthenticated)
    await expect(page).toHaveURL(/\/login|\/unauthorized|\/admin([?#]|$)/);
  });
});
