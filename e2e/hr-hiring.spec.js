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

async function mockHiringApis(page, trackers) {
  const jobs = [
    {
      id: "job-1",
      title: "Ward Nurse",
      department: "Nursing",
      status: "OPEN",
      openedAt: "2026-03-10T00:00:00.000Z",
      closedAt: null,
      updatedAt: "2026-03-10T08:00:00.000Z",
    },
  ];
  const applicants = [
    {
      id: "applicant-1",
      firstName: "Ama",
      lastName: "Mensah",
      email: "ama@example.com",
      phone: "0240000001",
      updatedAt: "2026-03-12T08:00:00.000Z",
    },
    {
      id: "applicant-2",
      firstName: "Kofi",
      lastName: "Owusu",
      email: "kofi@example.com",
      phone: "0240000002",
      updatedAt: "2026-03-12T09:00:00.000Z",
    },
  ];
  const applications = [
    {
      id: "application-1",
      stage: "SCREENING",
      notes: "",
      createdAt: "2026-03-12T10:00:00.000Z",
      updatedAt: "2026-03-12T10:00:00.000Z",
      applicant: applicants[0],
      jobPosting: jobs[0],
    },
    {
      id: "application-2",
      stage: "APPLIED",
      notes: "",
      createdAt: "2026-03-12T11:00:00.000Z",
      updatedAt: "2026-03-12T11:00:00.000Z",
      applicant: applicants[1],
      jobPosting: jobs[0],
    },
  ];

  await page.route("**/api/admin/hr/jobs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: jobs }),
    });
  });

  await page.route("**/api/admin/hr/applicants?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: applicants }),
    });
  });

  await page.route("**/api/admin/hr/applications", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: applications }),
    });
  });

  await page.route("**/api/admin/hr/applications/bulk", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const payload = route.request().postDataJSON() || {};
    trackers.bulkPayloads.push(payload);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        updatedCount: 1,
        skippedCount: 1,
        updated: [{ id: "application-1", from: "SCREENING", to: "INTERVIEW" }],
        skipped: [{ id: "application-2", reason: "Move to Screening before Interview." }],
      }),
    });
  });
}

test.describe("HR hiring page", () => {
  test("loads hiring controls and summary cards", async ({ page }) => {
    const trackers = { bulkPayloads: [] };
    await signIn(page);
    await mockHiringApis(page, trackers);
    await page.goto("/admin/hr/hiring");

    await expect(page.getByRole("heading", { name: /hiring pipeline/i })).toBeVisible();
    await expect(page.getByText(/open jobs/i).first()).toBeVisible();
    await expect(page.getByText(/active pipeline/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /import applicants/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ job posting/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ applicant/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ application/i })).toBeVisible();
    await expect(page.getByText(/last updated:/i)).toBeVisible();
  });

  test("sends conflict-safe bulk payload and renders skipped details", async ({ page }) => {
    const trackers = { bulkPayloads: [] };
    await signIn(page);
    await mockHiringApis(page, trackers);
    await page.goto("/admin/hr/hiring");

    await expect(page.getByRole("cell", { name: /Ama Mensah/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Kofi Owusu/i }).first()).toBeVisible();

    const appCheckboxes = page.locator("tbody tr input[type='checkbox']");
    await appCheckboxes.nth(0).check();
    await appCheckboxes.nth(1).check();

    await page.getByRole("button", { name: /apply to selected/i }).click();

    await expect.poll(() => trackers.bulkPayloads.length).toBe(1);
    expect(trackers.bulkPayloads[0]).toMatchObject({
      ids: ["application-1", "application-2"],
      stage: "SCREENING",
      operation: "bulk_update_application_stage",
    });
    expect(trackers.bulkPayloads[0].expectedUpdatedAtById).toMatchObject({
      "application-1": "2026-03-12T10:00:00.000Z",
      "application-2": "2026-03-12T11:00:00.000Z",
    });

    await expect(page.getByText(/skipped applications/i)).toBeVisible();
    await expect(page.getByText(/Kofi Owusu: Move to Screening before Interview./i)).toBeVisible();
  });
});
