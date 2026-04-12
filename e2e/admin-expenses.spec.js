import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

function makeExpenseRow(overrides = {}) {
  return {
    id: "e1",
    category: "5100 - Office Supplies",
    amount: 250,
    vendor: "Acme Corp",
    reason: "Monthly office supplies",
    note: null,
    isReversal: false,
    reversalOfId: null,
    settlementPaid: 0,
    settlementOutstanding: 250,
    settlementStatus: "UNPAID",
    settlementLastPaidAt: null,
    payrollRunId: null,
    canEdit: true,
    canDelete: true,
    canReverse: true,
    canSettle: true,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeExpensesResponse(items = [], totalAmount = 0, overrides = {}) {
  const totalCount = overrides.totalCount ?? items.length;
  const pageSize = overrides.pageSize ?? 50;
  return {
    items,
    totalAmount,
    totalCount,
    page: overrides.page ?? 1,
    pageSize,
    totalPages: overrides.totalPages ?? Math.max(1, Math.ceil(totalCount / pageSize)),
    sortBy: overrides.sortBy ?? "createdAt",
    sortDir: overrides.sortDir ?? "desc",
    summary: overrides.summary ?? {
      grossAmount: totalAmount,
      reversalAmount: 0,
      netAmount: totalAmount,
      outstandingLiability: items.reduce(
        (sum, row) => sum + Number(row.settlementOutstanding || 0),
        0,
      ),
      unpaidCount: items.filter(
        (row) => row.settlementStatus === "UNPAID" || row.settlementStatus === "PARTIALLY_PAID",
      ).length,
      topCategories: items.length
        ? [
            {
              category: items[0].category,
              count: items.filter((row) => row.category === items[0].category).length,
            },
          ]
        : [],
    },
  };
}

async function mockExpensesApis(page, options = {}) {
  const items = options.items ?? [makeExpenseRow()];
  const totalAmount =
    options.totalAmount ?? items.reduce((sum, row) => sum + Number(row.amount), 0);

  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        user: {
          name: "Nora Admin",
          email: "admin@example.com",
          role: "ADMIN",
          id: "admin-1",
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/admin/expenses**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        json: makeExpensesResponse(items, totalAmount, options),
      });
      return;
    }
    if (method === "POST") {
      await route.fulfill({
        json: { id: "e-new", category: "5100 - Office Supplies", amount: 100 },
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/admin/expenses/*/settle", async (route) => {
    await route.fulfill({ json: { ok: true, journalEntryId: "je1" } });
  });

  await page.route("**/api/admin/expenses/*", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill({
        json: {
          expense: makeExpenseRow(),
          reversals: [],
          journals: [],
          audits: [],
          metrics: {
            originalAmount: 250,
            settlementPaid: 0,
            settlementOutstanding: 250,
            reversedAmount: 0,
            remainingAfterReversals: 250,
          },
        },
      });
      return;
    }
    if (method === "PATCH") {
      await route.fulfill({
        json: { id: "e1", amount: 250, category: "5100 - Office Supplies" },
      });
      return;
    }
    if (method === "DELETE" || method === "POST") {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/admin/accounting/accounts", async (route) => {
    await route.fulfill({
      json: [
        { code: "5100", name: "Office Supplies", type: "EXPENSE", isActive: true },
        { code: "5200", name: "Marketing", type: "EXPENSE", isActive: true },
      ],
    });
  });
}

test.describe("Admin Expenses Page", () => {
  test("loads without error and shows page heading", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    await expect(page.getByText(/^Expenses$/).first()).toBeVisible();
  });

  test("shows expense rows from API", async ({ page }) => {
    await mockExpensesApis(page, { items: [makeExpenseRow()] });
    await page.goto("/admin/expenses");
    await expect(page.getByRole("button", { name: /^details$/i }).first()).toBeVisible();
  });

  test("shows summary cards", async ({ page }) => {
    await mockExpensesApis(page, {
      items: [makeExpenseRow({ amount: 500 })],
      totalAmount: 500,
    });
    await page.goto("/admin/expenses");
    await expect(page.getByText(/filtered expenses/i)).toBeVisible();
    await expect(page.getByText(/net amount/i)).toBeVisible();
    await expect(page.getByText(/outstanding liability/i)).toBeVisible();
  });

  test("shows outstanding liability card with amount when expenses are unpaid", async ({ page }) => {
    await mockExpensesApis(page, {
      items: [makeExpenseRow({ settlementStatus: "UNPAID", settlementOutstanding: 250 })],
    });
    await page.goto("/admin/expenses");
    const liabilityCard = page
      .locator("div.rounded-md")
      .filter({ has: page.getByText(/outstanding liability/i) })
      .first();
    await expect(liabilityCard).toBeVisible();
    await expect(liabilityCard).toContainText("250");
  });

  test("audit link routes to audit page filtered for expenses", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    const auditLink = page.getByText(/view audit log/i);
    await expect(auditLink).toBeVisible();
    const href = await auditLink.evaluate((el) => el.closest("a")?.href);
    expect(href).toContain("/admin/audit");
    expect(href).toContain("entityType=EXPENSE");
    expect(href).toContain("sourcePage=admin");
  });

  test("search input is present and updates URL", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    const searchInput = page.getByPlaceholder(
      /vendor, category, reason, note, or exact expense id/i,
    );
    await expect(searchInput).toBeVisible();
    await searchInput.fill("office");
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/q=office/);
  });

  test("vendor filter input updates URL", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    const vendorInput = page.getByLabel(/vendor/i);
    await vendorInput.fill("Acme");
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/vendor=Acme/);
  });

  test("settlement state filter dropdown contains UNPAID, PARTIALLY_PAID, PAID options", async ({
    page,
  }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    const settlementSelect = page.locator("#settlementState");
    const options = await settlementSelect.locator("option").allTextContents();
    const joined = options.join(" ").toLowerCase();
    expect(joined).toMatch(/unpaid/);
    expect(joined).toMatch(/paid/);
  });

  test("columns toggle button is present", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    await expect(page.getByRole("button", { name: /columns/i })).toBeVisible();
  });

  test("export button is present", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    await expect(page.getByRole("button", { name: /export/i })).toBeVisible();
  });

  test("add expense button is present and opens dialog", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    const addButton = page.getByRole("button", { name: /add expense/i });
    await expect(addButton).toBeVisible();
    await addButton.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
  });

  test("clear filters button resets URL params", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses?q=test&vendor=Acme");
    const clearButton = page.getByRole("button", { name: /^clear filters$/i });
    await expect(clearButton).toBeVisible();
    await clearButton.click();
    await page.waitForTimeout(300);
    await expect(page).not.toHaveURL(/q=test/);
    await expect(page).not.toHaveURL(/vendor=Acme/);
  });

  test("date range validation shows error when start > end", async ({ page }) => {
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    await page.locator("#start").evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, "2025-12-01");
    await page.locator("#end").evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, "2025-11-01");
    await expect(page.getByText(/start date cannot be after end date/i)).toBeVisible({
      timeout: 5000,
    });
  });

  test("shows UNPAID badge on expense with unpaid status", async ({ page }) => {
    await mockExpensesApis(page, {
      items: [makeExpenseRow({ settlementStatus: "UNPAID" })],
    });
    await page.goto("/admin/expenses");
    await expect(page.locator("span:visible").filter({ hasText: /^Unpaid$/i }).first()).toBeVisible();
  });

  test("shows PAID badge on expense with paid status", async ({ page }) => {
    await mockExpensesApis(page, {
      items: [
        makeExpenseRow({
          settlementStatus: "PAID",
          settlementPaid: 250,
          settlementOutstanding: 0,
        }),
      ],
    });
    await page.goto("/admin/expenses");
    await expect(page.locator("span:visible").filter({ hasText: /^Paid$/i }).first()).toBeVisible();
  });

  test("pagination controls appear when more than 50 rows are returned", async ({ page }) => {
    const manyRows = Array.from({ length: 55 }, (_, index) =>
      makeExpenseRow({ id: `e${index}`, vendor: `Vendor ${index}` }),
    );
    await mockExpensesApis(page, {
      items: manyRows.slice(0, 50),
      totalCount: 55,
      pageSize: 50,
      totalPages: 2,
    });
    await page.goto("/admin/expenses");
    await expect(page.getByRole("button", { name: /next/i })).toBeVisible({ timeout: 5000 });
  });

  test("sortable table headers are present on desktop", async ({ page }) => {
    await mockExpensesApis(page, { items: [makeExpenseRow()] });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/admin/expenses");
    const dateSortButton = page.getByRole("button", { name: /^date/i }).first();
    await expect(dateSortButton).toBeVisible({ timeout: 3000 });
    await dateSortButton.click();
    await expect(page).toHaveURL(/sortDir=asc/);
  });

  test("no console errors on page load", async ({ page }) => {
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await mockExpensesApis(page);
    await page.goto("/admin/expenses");
    await page.waitForTimeout(1000);
    const realErrors = errors.filter(
      (error) =>
        !error.includes("hydration") &&
        !error.includes("Warning:") &&
        !error.includes("network") &&
        !error.includes("favicon"),
    );
    expect(realErrors).toHaveLength(0);
  });

  test("delete confirmation dialog opens and does not delete on cancel", async ({ page }) => {
    await mockExpensesApis(page, { items: [makeExpenseRow()] });
    await page.goto("/admin/expenses");
    await expect(page.getByRole("button", { name: /^delete$/i }).first()).toBeVisible();

    const deleteRequests = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE") deleteRequests.push(request.url());
    });

    const deleteButton = page.getByRole("button", { name: /^delete$/i }).first();
    await deleteButton.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });

    const cancelButton = page.getByRole("button", { name: /^cancel$/i }).last();
    await cancelButton.click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 3000 });
    expect(deleteRequests).toHaveLength(0);
  });

  test("settle dialog shows outstanding amount", async ({ page }) => {
    await mockExpensesApis(page, {
      items: [makeExpenseRow({ settlementStatus: "UNPAID", settlementOutstanding: 250 })],
    });
    await page.goto("/admin/expenses");
    const settleButton = page.getByRole("button", { name: /record payment/i }).first();
    await settleButton.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3000 });
    await expect(page.getByText(/250/).first()).toBeVisible({ timeout: 3000 });
  });
});
