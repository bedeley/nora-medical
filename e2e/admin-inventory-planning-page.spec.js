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

async function mockInventoryPlanningApis(page) {
  await page.route("**/api/admin/settings/app?key=*", async (route) => {
    const url = new URL(route.request().url());
    const key = url.searchParams.get("key");
    const value =
      key === "inventoryPlanning.autoRecompute"
        ? "daily"
        : key === "inventoryPlanning.defaultReorderPoint"
          ? 12
          : null;

    await route.fulfill({
      json: {
        key,
        value,
        updatedAt: "2026-04-09T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/admin/inventory-planning", async (route) => {
    await route.fulfill({
      json: {
        rows: [
          {
            id: "prod-1",
            name: "Exam Gloves",
            sku: "GLV-1",
            category: "PPE",
            supplier: "Safe Hands",
            stock: 20,
            reserved: 3,
            onOrder: 8,
            available: 25,
            plan: {
              reorderPoint: 10,
              fallbackReorderPoint: 6,
              safetyStock: 4,
              leadTimeDays: 7,
              reviewPeriodDays: 30,
              minOrderQty: 5,
              approvalThresholdQty: 12,
              targetStock: 18,
            },
            effectivePlan: {
              reorderPoint: 10,
              safetyStock: 4,
              leadTimeDays: 7,
              reviewPeriodDays: 30,
              minOrderQty: 5,
              approvalThresholdQty: 12,
              targetStock: 18,
            },
            planSource: "manual",
            demand: {
              periodStart: "2026-02-01T00:00:00.000Z",
              periodEnd: "2026-04-01T00:00:00.000Z",
              capturedAt: "2026-04-09T00:00:00.000Z",
              unitsSold: 60,
              avgDailyDemand: "1.0000",
            },
            suggestion: {
              id: "sug-1",
              suggestedQty: 15,
              reason: "Demand trend supports a reorder",
              createdAt: "2026-04-09T00:00:00.000Z",
            },
          },
        ],
        meta: { lastRecomputeAt: "2026-04-09T00:00:00.000Z" },
      },
    });
  });

  await page.route("**/api/admin/inventory-planning/prod-1", async (route) => {
    await route.fulfill({
      json: {
        row: {
          id: "prod-1",
          name: "Exam Gloves",
          sku: "GLV-1",
          category: "PPE",
          supplier: "Safe Hands",
          stock: 20,
          reserved: 3,
          onOrder: 8,
          available: 25,
          plan: {
            reorderPoint: 10,
            fallbackReorderPoint: 6,
            safetyStock: 4,
            leadTimeDays: 7,
            reviewPeriodDays: 30,
            minOrderQty: 5,
            approvalThresholdQty: 12,
            targetStock: 18,
          },
          effectivePlan: {
            reorderPoint: 10,
            safetyStock: 4,
            leadTimeDays: 7,
            reviewPeriodDays: 30,
            minOrderQty: 5,
            approvalThresholdQty: 12,
            targetStock: 18,
          },
          planSource: "manual",
          demand: {
            periodStart: "2026-02-01T00:00:00.000Z",
            periodEnd: "2026-04-01T00:00:00.000Z",
            capturedAt: "2026-04-09T00:00:00.000Z",
            unitsSold: 60,
            avgDailyDemand: "1.0000",
          },
          suggestion: {
            id: "sug-1",
            suggestedQty: 15,
            reason: "Demand trend supports a reorder",
            createdAt: "2026-04-09T00:00:00.000Z",
          },
        },
      },
    });
  });
}

test.describe("Admin inventory planning page", () => {
  test("overview and detail pages expose page-scoped audit links", async ({ page }) => {
    await mockAdminSession(page);
    await mockInventoryPlanningApis(page);
    await mockAuditApis(page);

    await page.goto("/admin/inventory-planning");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByRole("heading", { name: "Inventory Planning" })).toBeVisible();
    await expect(
      page.getByText(/Review reorder risk, demand coverage, and suggested restocks across the catalog/i),
    ).toBeVisible();
    await expect(page.getByText("Exam Gloves")).toBeVisible();

    const overviewAuditLink = page.getByRole("link", { name: "Open audit log" });
    await expect(overviewAuditLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Finventory-planning",
    );

    await page.getByRole("link", { name: "Review" }).click();
    await page.waitForLoadState("networkidle");

    await expect(page).toHaveURL(/\/admin\/inventory-planning\/prod-1$/);
    await expect(page.getByRole("heading", { name: "Exam Gloves" })).toBeVisible();

    const detailAuditLink = page.getByRole("link", { name: "Open audit log" });
    await expect(detailAuditLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Finventory-planning%2Fprod-1",
    );

    await detailAuditLink.click();

    await expect(page).toHaveURL(/\/admin\/audit\?sourcePage=admin%2Finventory-planning%2Fprod-1/);
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
  });
});
