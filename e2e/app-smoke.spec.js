import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin app smoke", () => {
  test("loads core admin routes without fatal errors", async ({ page }) => {
    const pageErrors = [];
    const isIgnorablePageError = (message) =>
      /__nextjs_original-stack-frames/i.test(message) &&
      /access control checks/i.test(message);
    page.on("pageerror", (err) => {
      const message = String(err?.message || err);
      if (isIgnorablePageError(message)) return;
      pageErrors.push(message);
    });

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
