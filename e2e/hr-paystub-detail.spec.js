import { expect, test } from "@playwright/test";

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

async function mockPaystubApis(page, state) {
  await page.route("**/api/admin/hr/payslips/slip-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        payslip: {
          id: "slip-1",
          employeeId: "emp-1",
          payrollRunId: "run-1",
          grossPay: 1800,
          netPay: 1450,
          createdAt: "2026-03-27T10:15:00.000Z",
          lineItems: {
            tax: 200,
            pension: 99,
            employerSsnit: 117,
            taxableAllowances: 50,
            nonTaxableAllowances: 20,
            chargeableIncome: 1730,
            deductions: 350,
          },
          employee: {
            id: "emp-1",
            firstName: "Nora",
            lastName: "Admin",
            email: "staff@example.com",
            department: "HR",
            position: "Payroll Lead",
          },
          payrollRun: {
            id: "run-1",
            periodStart: "2026-03-01T00:00:00.000Z",
            periodEnd: "2026-03-31T00:00:00.000Z",
            status: "FINALIZED",
            runType: "REGULAR",
          },
        },
        ytdTotals: {
          gross: 9000,
          net: 7200,
          deductions: 1800,
          tax: 1200,
          pension: 600,
        },
      }),
    });
  });

  await page.route("**/api/admin/audit?**", async (route) => {
    const url = new URL(route.request().url());
    if (
      String(url.searchParams.get("entityType")) === "PAYSLIP" &&
      String(url.searchParams.get("entityId")) === "slip-1"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "audit-1",
            action: "PAYSLIP_EMAIL",
            createdAt: "2026-03-27T11:00:00.000Z",
            actor: { id: "admin-1", name: "Nora Admin", role: "ADMIN" },
            meta: {
              status: "SUCCESS",
              section: "paystub-actions",
              operation: "send_paystub_email",
              resultSummary: "Paystub emailed to staff@example.com successfully.",
              after: {
                recipientEmail: "staff@example.com",
                fileName: "paystub-slip-1.pdf",
                byteSize: 15432,
                delivery: "email",
              },
            },
          },
          {
            id: "audit-2",
            action: "PAYSLIP_PDF_DOWNLOAD",
            createdAt: "2026-03-27T10:40:00.000Z",
            actor: { id: "admin-1", name: "Nora Admin", role: "ADMIN" },
            meta: {
              status: "SUCCESS",
              section: "paystub-actions",
              operation: "download_paystub_pdf",
              resultSummary: "Paystub PDF downloaded successfully.",
              after: {
                fileName: "paystub-slip-1.pdf",
                byteSize: 15432,
                delivery: "download",
              },
            },
          },
        ]),
      });
      return;
    }

    await route.fallback();
  });

  await page.route("**/api/admin/hr/payslips/slip-1/email", async (route) => {
    state.emailRequests += 1;
    state.lastEmailPayload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/admin/hr/payslips/slip-1/pdf", async (route) => {
    state.pdfRequests += 1;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="paystub-slip-1.pdf"',
      },
      body: "%PDF-1.4 mock",
    });
  });

  await page.route("**/api/admin/hr/payslips/slip-1/print", async (route) => {
    state.printRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

test.describe("HR paystub detail page", () => {
  test("shows the redesigned paystub detail with context links and activity", async ({ page }) => {
    const state = {
      emailRequests: 0,
      pdfRequests: 0,
      printRequests: 0,
      lastEmailPayload: null,
    };

    await signIn(page);
    await mockPaystubApis(page, state);
    await page.goto("/admin/hr/paystubs/slip-1");

    await expect(page.getByRole("heading", { name: "Paystub" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^download pdf$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^print$/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /open payroll run/i })).toHaveAttribute(
      "href",
      "/admin/hr/payroll/run-1",
    );
    await expect(page.getByRole("link", { name: /open employee profile/i })).toHaveAttribute(
      "href",
      "/admin/hr/staff/emp-1",
    );
    await expect(page.getByText(/recent paystub activity/i)).toBeVisible();
    await expect(page.getByText("Paystub emailed", { exact: true })).toBeVisible();
    await expect(page.getByText(/recipient: staff@example\.com/i)).toBeVisible();
    await expect(page.getByText(/file: paystub-slip-1\.pdf/i).first()).toBeVisible();
    await expect(page.getByText(/paystub pdf downloaded successfully/i)).toBeVisible();
  });

  test("supports emailing, downloading, and printing the paystub", async ({ page }) => {
    const state = {
      emailRequests: 0,
      pdfRequests: 0,
      printRequests: 0,
      lastEmailPayload: null,
    };

    await page.addInitScript(() => {
      window.__printCalls = 0;
      window.__copiedText = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.__copiedText = value;
          },
        },
      });
      window.print = () => {
        window.__printCalls += 1;
      };
    });

    await signIn(page);
    await mockPaystubApis(page, state);
    await page.goto("/admin/hr/paystubs/slip-1");

    await page.getByRole("button", { name: /^email$/i }).click();
    const dialog = page.getByRole("dialog", { name: /email paystub/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[type="email"]')).toHaveValue("staff@example.com");
    await page.getByRole("button", { name: /send paystub/i }).click();
    await expect.poll(() => state.emailRequests).toBe(1);
    await expect.poll(() => state.lastEmailPayload?.email).toBe("staff@example.com");

    await page.getByRole("button", { name: /^download pdf$/i }).click();
    await expect.poll(() => state.pdfRequests).toBe(1);

    await page.getByRole("button", { name: /copy link/i }).click();
    await expect
      .poll(() => page.evaluate(() => window.__copiedText))
      .toContain("/admin/hr/paystubs/slip-1");

    await page.getByRole("button", { name: /^print$/i }).click();
    await expect.poll(() => state.printRequests).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__printCalls)).toBe(1);
  });
});
