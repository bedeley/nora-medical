import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const MOCK_FILTERS = {
  actions: ["ORDER_CREATE", "PAYMENT_REFUND", "USER_LOGIN", "USER_LOGIN_FAILED"],
  entityTypes: ["ORDER", "PAYMENT", "USER"],
  actors: [
    {
      id: "admin-1",
      name: "Nora Admin",
      email: "admin@example.com",
      role: "ADMIN",
    },
  ],
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

function createAuditRow(overrides = {}) {
  return {
    id: "audit-log-1",
    actor: null,
    action: "USER_LOGIN_FAILED",
    entityType: "USER",
    entityId: "user-1",
    meta: {
      reason: "The password did not match the account.",
    },
    outcome: "FAILED",
    createdAt: "2026-04-07T12:00:00.000Z",
    ...overrides,
  };
}

async function mockAuditApis(page, options = {}) {
  const savedFilters = [...(options.savedFilters || [])];
  let lastAuditQuery = "";

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

  await page.route("**/api/admin/audit/filters", async (route) => {
    await route.fulfill({ json: MOCK_FILTERS });
  });

  await page.route("**/api/admin/audit/saved-filters", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const row = {
        id: body.name.toLowerCase().replace(/\s+/g, "-"),
        name: body.name,
        state: body.state,
        isShared: Boolean(body.isShared),
        canEdit: true,
        owner: {
          id: "admin-1",
          name: "Nora Admin",
          email: "admin@example.com",
        },
        createdAt: "2026-04-07T12:00:00.000Z",
        updatedAt: "2026-04-07T12:00:00.000Z",
      };
      const existingIndex = savedFilters.findIndex((entry) => entry.name === row.name);
      if (existingIndex >= 0) {
        savedFilters[existingIndex] = row;
      } else {
        savedFilters.unshift(row);
      }
      await route.fulfill({ json: row });
      return;
    }

    await route.fulfill({ json: { items: savedFilters } });
  });

  await page.route("**/api/admin/audit/reviewer-performance?*", async (route) => {
    await route.fulfill({ json: { days: 30, items: [] } });
  });

  await page.route("**/api/admin/audit/notifications?*", async (route) => {
    await route.fulfill({
      json: {
        items: [],
        counts: {
          overdueReview: 0,
          overdueTask: 0,
          archiveEscalation: 0,
        },
      },
    });
  });

  await page.route("**/api/admin/audit?*", async (route) => {
    const url = new URL(route.request().url());
    lastAuditQuery = url.search;
    const payload = options.auditResponse
      ? options.auditResponse(url)
      : MOCK_AUDIT_RESPONSE;
    await route.fulfill({ json: payload });
  });

  return {
    getLastAuditQuery() {
      return lastAuditQuery;
    },
  };
}

function labeledSelect(page, label) {
  return page
    .locator("div.space-y-1", { has: page.getByText(label, { exact: true }) })
    .locator("select")
    .first();
}

test.describe("/admin/audit", () => {
  test("loads the page and opens/closes advanced filters", async ({ page }) => {
    await mockAuditApis(page);

    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "Audit Log" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Advanced filters/ })).toBeVisible();

    await page.getByRole("button", { name: /^Advanced filters/ }).click();
    await expect(page.getByRole("heading", { name: "Advanced filters" })).toBeVisible();

    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("heading", { name: "Advanced filters" })).toBeHidden();
  });

  test("security presets clear conflicting visible filters and apply the auth slice", async ({ page }) => {
    await mockAuditApis(page);

    await page.goto("/admin/audit");

    const entityTypeSelect = labeledSelect(page, "Entity type");
    const actionSelect = labeledSelect(page, "Action");
    const riskModeSelect = labeledSelect(page, "Risk mode");
    const queuePresetSelect = labeledSelect(page, "Queue preset");

    await entityTypeSelect.selectOption("PAYMENT");
    await riskModeSelect.selectOption("critical");
    await queuePresetSelect.selectOption("critical_unreviewed");
    await expect(entityTypeSelect).toHaveValue("PAYMENT");
    await expect(riskModeSelect).toHaveValue("critical");
    await expect(queuePresetSelect).toHaveValue("critical_unreviewed");

    await page.getByRole("button", { name: /^Advanced filters/ }).click();
    await page.getByRole("button", { name: "Successful logins" }).click();

    await expect(entityTypeSelect).toHaveValue("");
    await expect(riskModeSelect).toHaveValue("all");
    await expect(queuePresetSelect).toHaveValue("all");
    await expect(actionSelect).toHaveValue("USER_LOGIN");

    const outcomeSelect = page
      .locator("label", { has: page.getByText("Outcome", { exact: true }) })
      .locator("select")
      .first();
    await expect(outcomeSelect).toHaveValue("SUCCESS");
  });

  test("outcome filtering updates the query and narrows the audit table", async ({ page }) => {
    const api = await mockAuditApis(page, {
      auditResponse(url) {
        if (url.searchParams.get("outcome") === "FAILED") {
          return {
            ...MOCK_AUDIT_RESPONSE,
            items: [createAuditRow()],
            total: 1,
          };
        }
        return MOCK_AUDIT_RESPONSE;
      },
    });

    await page.goto("/admin/audit");
    await page.getByRole("button", { name: /^Advanced filters/ }).click();

    const outcomeSelect = page
      .locator("label", { has: page.getByText("Outcome", { exact: true }) })
      .locator("select")
      .first();

    await outcomeSelect.selectOption("FAILED");
    await page.getByRole("button", { name: "Close" }).first().click();

    await expect(page.getByRole("button", { name: "Outcome Failed x" })).toBeVisible();
    await expect(page.getByText("No activity found for the current filters.")).toBeHidden();
    await expect(page.getByRole("cell", { name: "User Login Failed" })).toBeVisible();
    await expect.poll(() => api.getLastAuditQuery()).toContain("outcome=FAILED");
  });

  test("saved filters preserve and restore advanced audit state", async ({ page }) => {
    await mockAuditApis(page);

    await page.goto("/admin/audit");

    const actionSelect = labeledSelect(page, "Action");

    await page.getByRole("button", { name: /^Advanced filters/ }).click();

    const outcomeSelect = page
      .locator("label", { has: page.getByText("Outcome", { exact: true }) })
      .locator("select")
      .first();
    const sourcePageSelect = page.getByLabel("Source page");

    await actionSelect.selectOption("USER_LOGIN_FAILED");
    await outcomeSelect.selectOption("FAILED");
    await sourcePageSelect.selectOption("admin/users");
    await page.getByPlaceholder("Ex: Refund checks - last 30 days").fill("Failed login triage");
    await page.getByRole("button", { name: "Save filter" }).click();
    await page.getByRole("button", { name: "Close" }).first().click();

    await expect(page.getByRole("button", { name: /^Saved filters$/ })).toBeVisible();
    await page.getByRole("button", { name: "Clear all", exact: true }).click();
    await expect(actionSelect).toHaveValue("");

    await page.getByRole("button", { name: /^Saved filters$/ }).click();
    await page.getByRole("button", { name: "Failed login triage" }).click();

    await expect(actionSelect).toHaveValue("USER_LOGIN_FAILED");
    await expect(page.getByRole("button", { name: "Outcome Failed x" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Page Users & Roles x" })).toBeVisible();
  });
});
