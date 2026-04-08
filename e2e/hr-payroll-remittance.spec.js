import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockRemittanceApis(page) {
  const summaryPayload = {
    monthKey: "2026-03",
    periodStart: "2026-03-01T00:00:00.000Z",
    periodEnd: "2026-03-31T23:59:59.999Z",
    runCount: 1,
    payslipCount: 2,
    employeeCount: 2,
    totalGross: 3000,
    totalNet: 2620,
    payeTax: 160,
    ssnitEmployee: 160,
    ssnitEmployer: 390,
    otherDeductions: 60,
    remittancePolicy: {
      requireReference: false,
    },
    employeeBreakdown: [
      {
        payrollRunId: "run-1",
        employeeId: "emp-1",
        employeeName: "Kwesi Yeboah",
        email: "kwesi@example.com",
        department: "Sales",
        position: "Rep",
        grossPay: 1500,
        payeTax: 80,
        ssnitEmployee: 80,
        ssnitEmployer: 195,
        ssnitTotal: 275,
      },
      {
        payrollRunId: "run-1",
        employeeId: "emp-2",
        employeeName: "Ama Owusu",
        email: "ama@example.com",
        department: "Sales",
        position: "Rep",
        grossPay: 1500,
        payeTax: 80,
        ssnitEmployee: 80,
        ssnitEmployer: 195,
        ssnitTotal: 275,
      },
    ],
    remittance: {
      payeStatus: "REMITTED",
      ssnitStatus: "PENDING",
      payeRemittedAt: "2026-03-26T16:30:00.000Z",
      ssnitRemittedAt: null,
      payeReference: "PAYE-REF-123",
      ssnitReference: null,
      updatedBy: "admin-1",
      updatedByLabel: "Nora Admin (bedeley@yahoo.com)",
      updatedAt: "2026-03-26T16:30:00.000Z",
    },
  };

  await page.route("**/api/admin/hr/payroll/statutory/summary?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(summaryPayload),
    });
  });

  await page.route("**/api/admin/hr/payroll/statutory/register?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ rows: [summaryPayload] }),
    });
  });

  await page.route("**/api/admin/hr/payroll/statutory/summary", async (route) => {
    const req = route.request();
    if (req.method() !== "PATCH") return route.fallback();
    const body = JSON.parse(req.postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...summaryPayload,
        remittance: {
          ...summaryPayload.remittance,
          payeStatus: body.kind === "PAYE" ? body.status : summaryPayload.remittance.payeStatus,
          ssnitStatus: body.kind === "SSNIT" ? body.status : summaryPayload.remittance.ssnitStatus,
        },
      }),
    });
  });
}

test.describe("HR payroll remittance page", () => {
  test("shows remittance snapshot and allows pending liability to be marked remitted", async ({ page }) => {
    await mockRemittanceApis(page);
    await page.goto("/admin/hr/payroll/remittance");

    await expect(page.getByRole("heading", { name: /payroll remittance register/i })).toBeVisible();
    await expect(page.getByText(/last updated:/i)).toBeVisible();
    await expect(page.getByText(/updated by:/i)).toBeVisible();
    await expect(page.getByText(/last remittance action:/i)).toBeVisible();

    const payeRow = page.getByRole("row", { name: /PAYE tax/i });
    await expect(payeRow.getByRole("button", { name: /mark remitted/i })).toBeDisabled();

    const ssnitRow = page.getByRole("row", { name: /SSNIT \(employee \+ employer\)/i });
    await expect(ssnitRow.getByRole("button", { name: /mark remitted/i })).toBeEnabled();
    await ssnitRow.getByRole("button", { name: /mark remitted/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/choose payment method for journal posting/i)).toBeVisible();
    await dialog.getByRole("button", { name: /^cancel$/i }).click();
    await expect(dialog).not.toBeVisible();
  });
});
