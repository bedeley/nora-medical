import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockReviewsApis(page, trackers) {
  const employees = [
    { id: "emp-1", firstName: "Nora", lastName: "Admin", hireDate: "2025-01-15T00:00:00.000Z" },
    { id: "emp-2", firstName: "Sam", lastName: "Nurse", hireDate: "2024-05-10T00:00:00.000Z" },
  ];
  const reviewRows = [
    {
      id: "rev-1",
      employeeId: "emp-1",
      rating: "MEETS",
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2026-03-31T00:00:00.000Z",
      summary: "Solid quarter.",
      strengths: "Dependable execution.",
      improvements: "Faster follow-through on escalations.",
      goals: "Improve handoff quality.",
      employee: employees[0],
      workflowStatus: "SUBMITTED",
      workflowArchived: false,
      workflowAcknowledgedAt: null,
      workflowAcknowledgedBy: null,
    },
    {
      id: "rev-2",
      employeeId: "emp-2",
      rating: "EXCEEDS",
      periodStart: "2025-10-01T00:00:00.000Z",
      periodEnd: "2025-12-31T00:00:00.000Z",
      summary: "Very strong performance.",
      strengths: "Ownership and mentoring.",
      improvements: "Maintain pace under load.",
      goals: "Lead cross-team project.",
      employee: employees[1],
      workflowStatus: "DRAFT",
      workflowArchived: false,
      workflowAcknowledgedAt: null,
      workflowAcknowledgedBy: null,
    },
  ];

  await page.addInitScript(() => {
    window.open = () => null;
  });

  await page.route("**/api/admin/hr/employees", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: employees }),
    });
  });

  await page.route("**/api/admin/hr/settings?keys=hr.reviewCadence", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ values: { "hr.reviewCadence": "quarterly" } }),
    });
  });

  await page.route("**/api/admin/hr/settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/admin/hr/reviews/bulk-workflow", async (route) => {
    const payload = route.request().postDataJSON();
    trackers.bulkPayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        successCount: payload.reviewIds.length,
        failureCount: 0,
        updatedReviewIds: payload.reviewIds,
        failures: [],
      }),
    });
  });

  await page.route("**/api/admin/hr/reviews/reminder-actions", async (route) => {
    const payload = route.request().postDataJSON();
    trackers.reminderActions.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/admin/hr/reviews/[id]", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/admin/hr/reviews?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: reviewRows,
        total: reviewRows.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      }),
    });
  });

  await page.route("**/api/admin/hr/reviews", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: reviewRows }),
    });
  });
}

test.describe("HR reviews page", () => {
  test("loads new review history controls", async ({ page }) => {
    const trackers = { bulkPayloads: [], reminderActions: [] };
    await mockReviewsApis(page, trackers);
    await page.goto("/admin/hr/reviews");

    await expect(page.getByRole("heading", { name: /performance reviews/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /review audit log/i })).toBeVisible();
    await expect(page.getByText(/review reminders/i)).toBeVisible();
    await expect(page.getByText(/review history/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /save preset/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /rename preset/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /delete preset/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /clear filters/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /select all visible/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^archive selected$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^unarchive selected$/i })).toBeVisible();
  });

  test("submits bulk archive operation and logs reminder actions", async ({ page }) => {
    const trackers = { bulkPayloads: [], reminderActions: [] };
    await mockReviewsApis(page, trackers);
    await page.goto("/admin/hr/reviews");

    page.on("dialog", (dialog) => dialog.accept());

    await page.locator('input[aria-label="Select review rev-1"]').check();
    await page.getByRole("button", { name: /^archive selected$/i }).click();

    await expect.poll(() => trackers.bulkPayloads.length).toBeGreaterThan(0);
    expect(trackers.bulkPayloads[0]).toMatchObject({
      operation: "ARCHIVE",
      reviewIds: ["rev-1"],
    });

    await page.getByRole("button", { name: /view history/i }).first().click();
    await page.getByRole("button", { name: /last review audit/i }).first().click();
    await page.getByRole("button", { name: /start review/i }).first().click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/add performance review/i)).toBeVisible();
    await expect.poll(() => trackers.reminderActions.map((item) => item.actionType)).toEqual(
      expect.arrayContaining(["OPEN_HISTORY", "OPEN_LAST_REVIEW_AUDIT", "START_REVIEW"]),
    );
  });
});
