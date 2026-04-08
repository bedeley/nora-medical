import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Employee portal", () => {
  test("opens the portal from account and shows the main employee self-service sections", async ({ page }) => {
    await page.goto("/account");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/account/);

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
    await page.goto("/account/employee");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/account\/employee/);

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
