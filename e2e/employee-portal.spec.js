import { expect, test } from "@playwright/test";

async function signInAccount(page) {
  const email = process.env.E2E_ADMIN_EMAIL || "";
  const password = process.env.E2E_ADMIN_PASSWORD || "";
  test.skip(!email || !password, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for portal login.");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto("/login?callbackUrl=/account");
    if (!page.url().includes("/login")) break;
    await page.getByPlaceholder(/email or username/i).waitFor({ state: "visible", timeout: 10000 });
    await page.getByPlaceholder(/email or username/i).fill(email);
    await page.getByPlaceholder(/^password$/i).fill(password);
    await page.getByRole("button", { name: /sign in|login/i }).click();
    await page.waitForLoadState("networkidle");
    await page.goto("/account");
    if (page.url().includes("/account")) break;
    await page.waitForTimeout(1000);
  }

  await page.goto("/account");
  await expect(page).toHaveURL(/\/account/);
}

test.describe("Employee portal", () => {
  test("opens the portal from account and shows the main employee self-service sections", async ({ page }) => {
    await signInAccount(page);

    const openPortal = page.getByRole("link", { name: /open employee portal/i }).first();
    await expect(openPortal).toBeVisible();
    await openPortal.click();

    await expect(page).toHaveURL(/\/account\/employee$/);
    await expect(page.getByText("Employee portal", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Profile and employment" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pay and documents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leave and onboarding" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Reviews" })).toBeVisible();
    await expect(page.getByRole("button", { name: /request update/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /request leave/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /view all paystubs/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /view all documents/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /view full leave history/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /view all review summaries/i })).toBeVisible();
  });

  test("opens the dedicated employee portal history pages and self-service dialogs", async ({ page }) => {
    await signInAccount(page);
    await page.goto("/account/employee");

    await page.getByRole("button", { name: /request update/i }).click();
    await expect(page.getByRole("dialog", { name: /request contact update/i })).toBeVisible();
    await page.getByRole("button", { name: /^cancel$/i }).click();

    await page.getByRole("button", { name: /request leave/i }).click();
    await expect(page.getByRole("dialog", { name: /request leave/i })).toBeVisible();
    await page.getByRole("button", { name: /^cancel$/i }).click();

    await page.goto("/account/employee/paystubs");
    await expect(page.getByText("All paystubs", { exact: true })).toBeVisible();

    await page.goto("/account/employee/documents");
    await expect(page.getByText("All HR documents", { exact: true })).toBeVisible();

    await page.goto("/account/employee/leave");
    await expect(page.getByText("Leave history and requests", { exact: true })).toBeVisible();

    await page.goto("/account/employee/reviews");
    await expect(page.getByText("All review summaries", { exact: true })).toBeVisible();
  });
});
