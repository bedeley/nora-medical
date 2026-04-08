import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("HR settings page", () => {
  test("loads and saves workweek policy through confirm dialog", async ({ page }) => {
    const settings = {
      "hr.workweekDays": 5,
      "hr.reviewCadence": "quarterly",
      "hr.payroll.ghana.autoStatutoryCalc": true,
      "hr.payroll.ghana.enablePaye": true,
      "hr.payroll.ghana.enableSsnitEmployee": true,
      "hr.payroll.ghana.enableSsnitEmployer": true,
      "hr.payroll.ghana.ssnitEmployeeRate": 5.5,
      "hr.payroll.ghana.ssnitEmployerRate": 13,
      "hr.payroll.ghana.taxableAllowancePercent": 100,
      "hr.payroll.ghana.payeBands": [
        { limit: 490, rate: 0 },
        { limit: 110, rate: 5 },
        { limit: 130, rate: 10 },
        { limit: 3166.67, rate: 17.5 },
        { limit: 16000, rate: 25 },
        { limit: 30520, rate: 30 },
        { limit: null, rate: 35 },
      ],
      "hr.payroll.remittance.requireReference": false,
    };

    const postBodies = [];

    await page.route("**/api/admin/hr/settings?**", async (route) => {
      const nowIso = new Date().toISOString();
      const meta = Object.keys(settings).reduce((acc, key) => {
        acc[key] = { createdAt: nowIso, updatedAt: nowIso };
        return acc;
      }, {});
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ values: settings, meta }),
      });
    });

    await page.route("**/api/admin/hr/settings", async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const body = JSON.parse(req.postData() || "{}");
      postBodies.push(body);
      if (body?.key) settings[body.key] = body.value;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          key: body.key,
          value: body.value,
          updatedAt: new Date().toISOString(),
        }),
      });
    });

    await page.goto("/admin/hr/settings");
    await expect(page.getByRole("heading", { name: /hr settings/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /save ghana payroll settings/i })).toBeVisible();

    const workweekSelect = page.locator("button").filter({ hasText: /5-day week \(Mon-Fri\)/i }).first();
    await workweekSelect.click();
    await page.getByRole("option", { name: /6-day week \(Mon-Sat\)/i }).click();

    await page.getByRole("button", { name: /save workweek setting/i }).click();
    const saveDialog = page.getByRole("dialog");
    await expect(saveDialog).toBeVisible();
    await expect(saveDialog.getByText(/this will save/i)).toBeVisible();
    await saveDialog.getByRole("button", { name: /confirm save/i }).click();

    await expect.poll(() => postBodies.length, { timeout: 8000 }).toBeGreaterThan(0);
    expect(postBodies.some((entry) => entry?.key === "hr.workweekDays")).toBeTruthy();
  });
});
