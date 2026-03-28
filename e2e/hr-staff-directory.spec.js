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

async function mockStaffDirectoryApis(page, trackers) {
  const staffPayload = {
    rows: [
      {
        id: "emp-1",
        firstName: "Ama",
        lastName: "Boateng",
        email: "ama@example.com",
        phone: "0240000001",
        department: "Finance",
        position: "Analyst",
        status: "ACTIVE",
        hireDate: "2025-01-02T00:00:00.000Z",
        updatedAt: "2026-03-26T10:00:00.000Z",
        user: { id: "user-1", role: "STAFF" },
      },
      {
        id: "emp-2",
        firstName: "Kofi",
        lastName: "Mensah",
        email: "kofi@example.com",
        phone: "0240000002",
        department: "",
        position: "Coordinator",
        status: "ACTIVE",
        hireDate: "",
        updatedAt: "2026-03-25T09:30:00.000Z",
        user: null,
      },
    ],
    page: 1,
    pageSize: 25,
    total: 2,
    totalPages: 1,
    departmentOptions: ["Finance"],
    summary: {
      total: 2,
      active: 2,
      onLeave: 0,
      suspended: 0,
      terminated: 0,
      missingProfile: 1,
      missingBankDetails: 1,
      linkedAccount: 1,
      unlinkedAccount: 1,
    },
  };

  await page.route("**/api/admin/hr/employees/views", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route("**/api/admin/hr/employees?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(staffPayload),
    });
  });

  await page.route("**/api/admin/audit?**sourcePage=admin%2Fhr%2Fstaff**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        rows: [
          {
            id: "activity-1",
            action: "HR_EMPLOYEE_IMPORT",
            entityType: "EMPLOYEE",
            entityId: "bulk",
            createdAt: "2026-03-27T12:00:00.000Z",
            actor: { id: "admin-1", name: "Nora Admin", email: "nora@example.com", role: "ADMIN" },
            meta: JSON.stringify({
              resultSummary: "Employee import completed successfully.",
              operation: "import_employees_csv",
            }),
          },
          {
            id: "activity-2",
            action: "HR_EMPLOYEE_UPDATE",
            entityType: "EMPLOYEE",
            entityId: "emp-2",
            createdAt: "2026-03-27T11:00:00.000Z",
            actor: { id: "admin-1", name: "Nora Admin", email: "nora@example.com", role: "ADMIN" },
            meta: JSON.stringify({
              resultSummary: "Employee profile updated successfully.",
              operation: "update_employee_details",
            }),
          },
        ],
      }),
    });
  });

  await page.route("**/api/admin/users", async (route) => {
    trackers.userPayloads.push(route.request().postDataJSON() || {});
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "user-new",
        email: "kofi@example.com",
        role: "STAFF",
        employeeId: "emp-2",
        inviteUrl: "http://localhost:3000/invite?userId=user-new",
        channel: "email",
      }),
    });
  });

  await page.route("**/api/admin/hr/employees/import", async (route) => {
    trackers.importPayloads.push(route.request().postDataJSON() || {});
    const body = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        created: body?.dryRun ? 2 : 2,
        skipped: 0,
        valid: 2,
        dryRun: Boolean(body?.dryRun),
        errors: [],
        resultSummary: body?.dryRun
          ? "Preview complete: 2 would be created, 0 skipped, 0 error(s)."
          : "Import complete: 2 created, 0 skipped, 0 error(s).",
      }),
    });
  });
}

test.describe("HR staff directory page", () => {
  test("shows recent staff activity and creates a linked user from the row menu", async ({ page }) => {
    const trackers = { userPayloads: [], importPayloads: [] };
    await signIn(page);
    await mockStaffDirectoryApis(page, trackers);
    await page.goto("/admin/hr/staff");

    await expect(page.getByText("Recent staff activity", { exact: true })).toBeVisible();
    await expect(page.getByText("Employee import completed successfully.", { exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: /No linked account/i })).toBeVisible();

    await page.getByRole("button", { name: /More actions for Kofi Mensah/i }).click();
    await page.getByRole("menuitem", { name: /Create linked user/i }).click();

    const linkedUserDialog = page.getByRole("dialog", { name: /Create linked user/i });
    await expect(linkedUserDialog).toBeVisible();
    await expect(linkedUserDialog.locator('input[value="Kofi Mensah"]')).toBeVisible();
    await expect(linkedUserDialog.locator('input[value="kofi@example.com"]')).toBeVisible();
    await expect(linkedUserDialog.locator('input[value="0240000002"]')).toBeVisible();
    await page.getByRole("button", { name: /^Create linked user$/i }).click();

    await expect.poll(() => trackers.userPayloads.length).toBe(1);
    expect(trackers.userPayloads[0]).toMatchObject({
      name: "Kofi Mensah",
      email: "kofi@example.com",
      phone: "0240000002",
      role: "STAFF",
      employeeId: "emp-2",
      sourcePage: "admin/hr/staff",
      section: "account-link",
      operation: "create_linked_user",
    });
  });

  test("shows richer import readiness preview before import", async ({ page }) => {
    const trackers = { userPayloads: [], importPayloads: [] };
    await signIn(page);
    await mockStaffDirectoryApis(page, trackers);
    await page.goto("/admin/hr/staff");

    await page.getByRole("button", { name: /Import CSV/i }).click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "employees.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "firstName,lastName,email,phone,department,position,status,hireDate,bankName,bankAccountName,bankAccountNumber,bankCode,bankBranch",
          "Yaw,Mensimah,yaw@example.com,0241111111,Sales,Representative,ACTIVE,2026-03-01,,, , ,",
          "Esi,Owusu,,0242222222,,Coordinator,ACTIVE,,,Esi Owusu,1234567890,ABC,Main",
        ].join("\n"),
      ),
    });

    await expect(page.getByText("Portal-ready rows", { exact: true })).toBeVisible();
    await expect(page.getByText("Missing bank detail rows", { exact: true })).toBeVisible();
    await expect(page.getByText(/Core profile: Missing/i)).toBeVisible();
    await expect(page.getByText(/Bank ready: No/i).first()).toBeVisible();

    await page.getByRole("button", { name: /Preview import/i }).click();
    await expect.poll(() => trackers.importPayloads.length).toBe(1);
    expect(trackers.importPayloads[0]).toMatchObject({ dryRun: true });
    await expect(
      page
        .getByRole("dialog", { name: /Import Employees/i })
        .getByText("Preview complete: 2 would be created, 0 skipped, 0 error(s).", { exact: true }),
    ).toBeVisible();
  });
});
