import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

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
    {
      id: "application-3",
      stage: "HIRED",
      notes: "",
      employeeId: "emp-ama-hired",
      onboarding: {
        status: "pending",
        summary: "Imported from hiring pipeline and waiting for HR completion.",
      },
      createdAt: "2026-03-13T11:00:00.000Z",
      updatedAt: "2026-03-13T11:00:00.000Z",
      applicant: {
        id: "applicant-3",
        firstName: "Esi",
        lastName: "Addo",
        email: "esi@example.com",
        phone: "0240000003",
        updatedAt: "2026-03-13T10:00:00.000Z",
      },
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

  await page.route("**/api/admin/hr/applications**", async (route) => {
    const url = new URL(route.request().url());
    const showHired = url.searchParams.get("showHired") === "1";
    const rows = showHired ? applications : applications.filter((row) => row.stage !== "HIRED");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows,
        total: rows.length,
        lastUpdatedAt: "2026-03-12T11:00:00.000Z",
        summary: {
          total: applications.length,
          active: 2,
          applied: 1,
          screening: 1,
          interview: 0,
          offer: 0,
          hired: 1,
          rejected: 0,
          withdrawn: 0,
        },
      }),
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
    await mockHiringApis(page, trackers);
    await page.goto("/admin/hr/hiring");

    await expect(page.getByRole("heading", { name: /hiring pipeline/i })).toBeVisible();
    await expect(page.getByText(/open roles/i).first()).toBeVisible();
    await expect(page.getByText(/active pipeline/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /import applicants/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ job posting/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ applicant/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /\+ application/i })).toBeVisible();
    await expect(page.getByText(/last updated:/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /copy view link/i })).toBeVisible();
  });

  test("sends conflict-safe bulk payload and renders skipped details", async ({ page }) => {
    const trackers = { bulkPayloads: [] };
    await mockHiringApis(page, trackers);
    await page.goto("/admin/hr/hiring");

    const applicationsSection = page.locator("#applications");
    await expect(applicationsSection.getByRole("cell", { name: /Ama Mensah/i }).first()).toBeVisible();
    await expect(applicationsSection.getByRole("cell", { name: /Kofi Owusu/i }).first()).toBeVisible();

    const appCheckboxes = applicationsSection.locator("table tbody tr input[type='checkbox']");
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

  test("shows resume onboarding for hired applications", async ({ page }) => {
    const trackers = { bulkPayloads: [] };
    await mockHiringApis(page, trackers);
    await page.goto("/admin/hr/hiring");

    await page.getByLabel(/Show hired applications/i).check();
    const applicationsSection = page.locator("#applications");
    await expect(applicationsSection).toContainText("Esi Addo");
    await expect(applicationsSection).toContainText("Onboarding pending");
    await expect(applicationsSection.getByRole("button", { name: /Resume onboarding/i }).first()).toBeVisible();
  });
});
