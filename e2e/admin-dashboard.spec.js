import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

test.describe("Admin dashboard redesign", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/admin/dashboard?groupBy=day");
    await page.waitForLoadState("networkidle");
  });

  test("renders the redesigned dashboard shell and actions", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText(/track revenue, expenses, and cash flow at a glance/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /refresh/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^csv$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^pdf$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
    await expect(page.getByText(/^financial reporting$/i)).toBeVisible();
    await expect(page.getByText(/cash \(payment-date basis\)/i)).toBeVisible();
    await expect(page.getByText(/^operational context$/i)).toBeVisible();
    await expect(page.getByText(/^ledger alignment$/i)).toBeVisible();
    await expect(page.getByText(/metric definitions/i)).toBeVisible();
  });

  test("shows redesigned context cards and quick links", async ({ page }) => {
    await expect(page.getByText(/open period/i)).toBeVisible();
    await expect(page.getByText(/latest vat filing/i)).toBeVisible();
    await expect(page.getByText(/integrity status/i)).toBeVisible();
    await expect(page.getByRole("link", { name: /review outstanding/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /review pending momo/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /open integrity/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Health", exact: true })).toBeVisible();
  });

  test("updates the URL when groupBy changes", async ({ page }) => {
    await expect(page).toHaveURL(/groupBy=day/);
    await page.getByRole("button", { name: /^month$/i }).click();
    await expect(page).toHaveURL(/groupBy=month/);
    await expect(page.getByText(/\(month\)/i)).toBeVisible();
  });

  test("syncs customer and category filters to the URL and reset clears them", async ({ page }) => {
    const customerInput = page.getByPlaceholder(/filter by customer name/i);
    const categoryInput = page.getByPlaceholder(/filter by category/i);

    await customerInput.fill("Acme Clinic");
    await categoryInput.fill("Payroll");

    await expect(page).toHaveURL(/customer=Acme(\+|%20)Clinic/);
    await expect(page).toHaveURL(/category=Payroll/);
    await expect(page.getByText(/2 active/i)).toBeVisible();

    await page.getByRole("button", { name: /^reset$/i }).click();

    await expect(customerInput).toHaveValue("");
    await expect(categoryInput).toHaveValue("");
    await expect(page).toHaveURL(/\/admin\/dashboard\?groupBy=day$/);
  });

  test("opens the raw data dialog", async ({ page }) => {
    await page.getByRole("button", { name: /raw data/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/raw data records/i)).toBeVisible();
    await expect(
      dialog.locator("table").or(dialog.getByText(/no records found\./i)),
    ).toBeVisible();
  });

  test("exports CSV with the active dashboard filters", async ({ page }) => {
    await page.getByPlaceholder(/filter by customer name/i).fill("Acme Clinic");
    await page.getByPlaceholder(/filter by category/i).fill("Payroll");
    await page.getByRole("button", { name: /^month$/i }).click();

    await expect(page).toHaveURL(/customer=Acme(\+|%20)Clinic/);
    await expect(page).toHaveURL(/category=Payroll/);
    await expect(page).toHaveURL(/groupBy=month/);

    const [request, download] = await Promise.all([
      page.waitForRequest((req) => {
        const url = new URL(req.url());
        return (
          url.pathname === "/api/admin/summary" &&
          url.searchParams.get("format") === "csv" &&
          url.searchParams.get("groupBy") === "month" &&
          url.searchParams.get("customer") === "Acme Clinic" &&
          url.searchParams.get("category") === "Payroll"
        );
      }),
      page.waitForEvent("download"),
      page.getByRole("button", { name: /^csv$/i }).click(),
    ]);

    expect(request.method()).toBe("GET");
    expect(download.suggestedFilename()).toMatch(/^nora_dashboard_month_\d+\.csv$/);
  });

  test("exports PDF for the active dashboard grouping", async ({ page }) => {
    await page.getByRole("button", { name: /^month$/i }).click();
    await expect(page).toHaveURL(/groupBy=month/);

    const [request, download] = await Promise.all([
      page.waitForRequest((req) => {
        const url = new URL(req.url());
        return (
          url.pathname === "/api/admin/summary" &&
          url.searchParams.get("format") === "pdf" &&
          url.searchParams.get("groupBy") === "month"
        );
      }),
      page.waitForEvent("download"),
      page.getByRole("button", { name: /^pdf$/i }).click(),
    ]);

    expect(request.method()).toBe("GET");
    expect(download.suggestedFilename()).toMatch(/^nora_revenue_month_\d+\.pdf$/);
  });
});
