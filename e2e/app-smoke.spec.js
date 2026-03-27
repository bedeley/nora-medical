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

test.describe("Admin app smoke", () => {
  test("loads core admin routes without fatal errors", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (err) => {
      pageErrors.push(String(err?.message || err));
    });

    await signIn(page);

    const routes = [
      "/admin",
      "/admin/accounting",
      "/admin/accounting/reports/trial-balance",
      "/admin/accounting/reports/balance-sheet",
      "/admin/hr",
      "/admin/hr/compensation",
      "/admin/hr/reviews",
      "/admin/hr/payroll",
    ];

    for (const route of routes) {
      await test.step(`visit ${route}`, async () => {
        await page.goto(route);
        await page.waitForLoadState("networkidle");
        await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        await expect(page.locator("body")).not.toContainText(/application error|internal server error/i);
      });
    }

    expect(pageErrors, `Uncaught page errors detected: ${pageErrors.join(" | ")}`).toEqual([]);
  });
});
