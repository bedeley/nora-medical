import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockLeaveApis(page, trackers) {
  const employees = [
    { id: "emp-1", firstName: "Nora", lastName: "Admin" },
    { id: "emp-2", firstName: "Sam", lastName: "Nurse" },
  ];

  const rows = [
    {
      id: "leave-1",
      employeeId: "emp-1",
      type: "ANNUAL",
      status: "REQUESTED",
      startDate: "2026-03-20T00:00:00.000Z",
      endDate: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-19T12:00:00.000Z",
      cancelledAt: null,
      reason: "Vacation",
      employee: employees[0],
    },
    {
      id: "leave-2",
      employeeId: "emp-2",
      type: "SICK",
      status: "APPROVED",
      startDate: "2026-03-25T00:00:00.000Z",
      endDate: "2026-03-27T00:00:00.000Z",
      updatedAt: "2026-03-24T09:00:00.000Z",
      cancelledAt: null,
      reason: "Medical review",
      employee: employees[1],
    },
  ];

  await page.route("**/api/admin/hr/employees", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: employees }),
    });
  });

  await page.route("**/api/admin/hr/settings?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        values: {
          "hr.workweekDays": 5,
        },
      }),
    });
  });

  await page.route("**/api/admin/hr/settings", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "hr.workweekDays", value: 5 }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/admin/hr/leave?**", async (route) => {
    const url = new URL(route.request().url());
    trackers.leaveUrls.push(url.toString());
    const activeToday = url.searchParams.get("activeToday") === "1";
    const status = String(url.searchParams.get("status") || "all").toUpperCase();
    const pageNum = Number(url.searchParams.get("page") || "1");
    const pageSize = Number(url.searchParams.get("pageSize") || "25");

    let filtered = rows.slice();
    if (activeToday) {
      filtered = filtered.filter((row) => row.status === "APPROVED");
    } else if (status !== "ALL" && status !== "") {
      filtered = filtered.filter((row) => row.status === status);
    }

    const start = (pageNum - 1) * pageSize;
    const pagedRows = filtered.slice(start, start + pageSize);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: pagedRows,
        total: filtered.length,
        page: pageNum,
        pageSize,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      }),
    });
  });

  await page.route("**/api/admin/hr/leave/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    trackers.patchPayloads.push(route.request().postDataJSON() || {});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

test.describe("HR leave page", () => {
  test("loads leave controls, supports active-today filter, and pagination jump", async ({ page }) => {
    const trackers = { leaveUrls: [], patchPayloads: [] };
    await mockLeaveApis(page, trackers);
    await page.goto("/admin/hr/leave");

    await expect(page.getByRole("heading", { name: /leave tracking/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ add leave/i })).toBeVisible();
    await expect(page.getByText(/requested/i).first()).toBeVisible();
    await expect(page.getByText(/approved/i).first()).toBeVisible();
    await expect(page.getByText(/cancelled/i).first()).toBeVisible();

    await page.getByRole("button", { name: /show active today/i }).click();
    await expect(page.getByRole("button", { name: /showing active today/i })).toBeVisible();
    await expect.poll(() => trackers.leaveUrls.some((url) => url.includes("activeToday=1"))).toBe(true);

    const jumpInput = page.locator('input[type="number"]').last();
    await jumpInput.fill("3");
    await page.getByRole("button", { name: /^go$/i }).click();
    await expect(page.getByText(/page 1 of 1/i)).toBeVisible();
  });

  test("requires decision note in modal before rejecting leave", async ({ page }) => {
    const trackers = { leaveUrls: [], patchPayloads: [] };
    await mockLeaveApis(page, trackers);
    await page.goto("/admin/hr/leave");

    await page.getByRole("button", { name: /^reject$/i }).first().click();
    await expect(page.getByRole("heading", { name: /reject leave request/i })).toBeVisible();
    await page.getByRole("button", { name: /^confirm$/i }).click();
    await expect(page.getByText(/a short note is required/i)).toBeVisible();

    await page.getByPlaceholder(/enter note/i).fill("Not enough balance");
    await page.getByRole("button", { name: /^confirm$/i }).click();
    await expect.poll(() => trackers.patchPayloads.length).toBe(1);
    expect(trackers.patchPayloads[0]).toMatchObject({
      status: "REJECTED",
      decisionNote: "Not enough balance",
      expectedUpdatedAt: "2026-03-19T12:00:00.000Z",
    });
  });
});
