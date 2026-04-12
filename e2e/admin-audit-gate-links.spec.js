import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const MOCK_FILTERS = {
  actions: [],
  entityTypes: [],
  actors: [],
};

const MOCK_AUDIT_RESPONSE = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  summary: {
    needsReview: 0,
    critical: 0,
    reviewedToday: 0,
    overdueCritical: 0,
    overdueHigh: 0,
    overdueMedium: 0,
    archiveReminder: 0,
    archiveEscalation: 0,
    archiveNeedsAssignment: 0,
    eligibleForArchiveUnreviewed: 0,
    openTasks: 0,
    inProgressTasks: 0,
    overdueTasks: 0,
  },
  riskSettings: {
    mode: "editable",
    reviewSlaHours: { critical: 24, high: 72, medium: 168 },
    archiveWindowDays: { reminder: 14, escalation: 3 },
    thresholds: {},
  },
  settingsMode: "editable",
  settingsEditable: true,
};

async function mockAdminSession(page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        user: {
          name: "Nora Admin",
          email: "admin@example.com",
          role: "ADMIN",
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
  });
}

async function mockStaffSession(page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        user: {
          name: "Nora Staff",
          email: "staff@example.com",
          role: "STAFF",
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
  });
}

async function mockAuditApis(page) {
  await page.route("**/api/admin/audit/filters", async (route) => {
    await route.fulfill({ json: MOCK_FILTERS });
  });
  await page.route("**/api/admin/audit/saved-filters**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/admin/audit/reviewer-performance?*", async (route) => {
    await route.fulfill({ json: { days: 30, items: [] } });
  });
  await page.route("**/api/admin/audit/notifications?*", async (route) => {
    await route.fulfill({
      json: {
        items: [],
        counts: { overdueReview: 0, overdueTask: 0, archiveEscalation: 0 },
      },
    });
  });
  await page.route("**/api/admin/audit?*", async (route) => {
    await route.fulfill({ json: MOCK_AUDIT_RESPONSE });
  });
}

test.describe("Admin audit gate and page links", () => {
  test("products and purchases pages expose admin-only audit links with page-specific filters", async ({
    page,
  }) => {
    await mockAdminSession(page);
    await mockAuditApis(page);

    await page.goto("/admin/products");
    await page.waitForLoadState("networkidle");
    const productsLink = page.getByRole("link", { name: "View Audit Log" });
    await expect(productsLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fproducts",
    );
    await productsLink.click();
    await expect(page).toHaveURL(/\/admin\/audit\?sourcePage=admin%2Fproducts/);
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();

    await page.goto("/admin/purchases");
    await page.waitForLoadState("networkidle");
    const purchasesLink = page.getByRole("link", { name: "View Audit Log" });
    await expect(purchasesLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fpurchases",
    );
    await purchasesLink.click();
    await expect(page).toHaveURL(/\/admin\/audit\?sourcePage=admin%2Fpurchases/);
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
  });

  test("non-admin users are blocked by the audit page gate", async ({ page }) => {
    let auditApiCalls = 0;
    await mockStaffSession(page);
    await page.route("**/api/admin/audit/**", async (route) => {
      auditApiCalls += 1;
      await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    });
    await page.route("**/api/admin/audit?*", async (route) => {
      auditApiCalls += 1;
      await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
    });

    await page.goto("/admin/audit?sourcePage=admin/products");
    await expect(page.getByText("Access Restricted")).toBeVisible();
    await expect(
      page.getByText("The audit log is restricted to admin users."),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Audit Log" }),
    ).toHaveCount(0);
    expect(auditApiCalls).toBe(0);
  });
});
