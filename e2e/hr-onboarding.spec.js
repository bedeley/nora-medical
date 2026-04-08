import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("HR onboarding page", () => {
  test("warns before leaving with unsaved onboarding changes", async ({ page }) => {
    await page.route("**/api/admin/hr/employees?onboarding=pending**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rows: [],
          total: 0,
          summary: { pendingOnboarding: 0 },
        }),
      });
    });

    await page.goto("/admin/hr/onboarding?source=hr");
    await page.getByLabel("First name").fill("Later");

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toMatch(/unsaved onboarding changes/i);
      await dialog.dismiss();
    });

    await page.getByRole("link", { name: /open users & roles/i }).click();
    await expect(page).toHaveURL(/\/admin\/hr\/onboarding/);
    await expect(page.getByText(/you have unsaved onboarding changes/i)).toBeVisible();
  });

  test("submits centralized employee creation payload", async ({ page }) => {
    const trackers = { createPayloads: [] };

    await page.route("**/api/admin/hr/employees?onboarding=pending**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          rows: [
            {
              id: "emp-pending",
              firstName: "Later",
              lastName: "Hire",
              department: "Sales",
              position: "Representative",
              hireDate: "2026-04-02T00:00:00.000Z",
              onboarding: {
                status: "pending",
                summary: "Imported from hiring pipeline and waiting for HR completion.",
                missingFields: [],
                hasPendingMarker: true,
              },
            },
          ],
          total: 1,
          summary: { pendingOnboarding: 1 },
        }),
      });
    });

    await page.route("**/api/admin/hr/employees", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      trackers.createPayloads.push(route.request().postDataJSON() || {});
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "emp-new" }),
      });
    });

    await page.goto("/admin/hr/onboarding?source=hr");

    await expect(page.getByRole("heading", { name: /start employee onboarding/i })).toBeVisible();
    await expect(page.getByText(/1 employee record still need onboarding attention/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /Resume onboarding/i })).toHaveCount(1);
    await page.getByLabel("First name").fill("Nora");
    await page.getByLabel("Last name").fill("Central");
    await page.getByLabel("Department").fill("HR");
    await page.getByLabel("Position").fill("Coordinator");
    await page.getByLabel("Hire date").fill("2026-04-04");
    await page.getByLabel("Email").fill("nora.central@example.com");
    await page.getByLabel("Phone").fill("0241234567");
    await page.getByRole("button", { name: /create and open staff profile/i }).click();

    await expect.poll(() => trackers.createPayloads.length).toBe(1);
    expect(trackers.createPayloads[0]).toMatchObject({
      firstName: "Nora",
      lastName: "Central",
      department: "HR",
      position: "Coordinator",
      hireDate: "2026-04-04",
      email: "nora.central@example.com",
      phone: "0241234567",
      sourcePage: "admin/hr/onboarding",
      section: "employee-onboarding",
      operation: "create_employee_onboarding",
    });
  });

  test("loads hired employee handoff and patches onboarding completion", async ({ page }) => {
    const trackers = { patchPayloads: [] };

    await page.route("**/api/admin/hr/employees/emp-hired", async (route) => {
      if (route.request().method() === "PATCH") {
        trackers.patchPayloads.push(route.request().postDataJSON() || {});
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "emp-hired" }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "emp-hired",
          firstName: "Ama",
          lastName: "Mensah",
          email: "ama@example.com",
          phone: "0240000001",
          department: "Nursing",
          position: "Ward Nurse",
          status: "ACTIVE",
          hireDate: "2026-04-01T00:00:00.000Z",
          notes: "Auto-created from hiring pipeline",
          bankName: "",
          bankAccountName: "",
          bankAccountNumber: "",
          bankCode: "",
          bankBranch: "",
          updatedAt: "2026-04-04T12:00:00.000Z",
        }),
      });
    });

    await page.goto("/admin/hr/onboarding?source=hiring&employeeId=emp-hired&applicationId=application-1");

    await expect(page.getByRole("heading", { name: /complete employee onboarding/i })).toBeVisible();
    await expect(page.getByText(/came from the hiring pipeline/i)).toBeVisible();
    await page.getByLabel("Bank name").fill("GCB");
    await page.getByLabel("Account name").fill("Ama Mensah");
    await page.getByLabel("Account number").fill("12345678");
    await page.getByLabel("Bank code").fill("GCB001");
    await page.getByLabel("Bank branch").fill("Accra Central");
    await page.getByRole("button", { name: /save and open staff profile/i }).click();

    await expect.poll(() => trackers.patchPayloads.length).toBe(1);
    expect(trackers.patchPayloads[0]).toMatchObject({
      sourcePage: "admin/hr/onboarding",
      section: "employee-onboarding",
      operation: "complete_employee_onboarding",
      expectedUpdatedAt: "2026-04-04T12:00:00.000Z",
      bankName: "GCB",
      bankAccountName: "Ama Mensah",
      bankAccountNumber: "12345678",
      bankCode: "GCB001",
      bankBranch: "Accra Central",
    });
  });
});
