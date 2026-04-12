import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockBanksPageApis(page, { role = "ADMIN", onCsvRequest } = {}) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        user: {
          name: role === "ACCOUNTANT" ? "Accountant" : "Admin",
          email: role === "ACCOUNTANT" ? "accountant@example.com" : "admin@example.com",
          role,
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/admin/accounting/banks", async (route) => {
    await route.fulfill({
      json: [
        {
          id: "bank-1",
          name: "Main Operating",
          bankName: "Nora Bank",
          accountNumberMasked: "***1234",
          currency: "GHS",
          isActive: true,
        },
      ],
    });
  });

  await page.route("**/api/admin/accounting/accounts", async (route) => {
    await route.fulfill({
      json: [{ id: "acc-1", code: "1000", name: "Cash at Bank" }],
    });
  });

  await page.route("**/api/admin/accounting/banks/bank-1/rules", async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route("**/api/admin/accounting/banks/bank-1/import-runs", async (route) => {
    await route.fulfill({ json: [] });
  });

  await page.route("**/api/admin/accounting/banks/bank-1/transactions?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("format") === "csv") {
      onCsvRequest?.(url);
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "date,type,amount,description,reference,matched\n2026-04-01,CREDIT,250.00,Wire transfer,WIRE-001,false\n",
      });
      return;
    }

    await route.fulfill({
      json: {
        total: 1,
        page: Number(url.searchParams.get("page") || "1"),
        pageSize: Number(url.searchParams.get("pageSize") || "20"),
        totalPages: 1,
        sortBy: url.searchParams.get("sortBy") || "postedAt",
        sortDir: url.searchParams.get("sortDir") || "desc",
        summary: { total: 1, matched: 0, unmatched: 1 },
        rows: [
          {
            id: "txn-1",
            postedAt: "2026-04-01T00:00:00.000Z",
            amount: 250,
            description: "Wire transfer",
            reference: "WIRE-001",
            type: "CREDIT",
            matched: false,
          },
        ],
      },
    });
  });
}

test.describe("Admin accounting banks page", () => {
  test("renders the server-driven shell and exports filtered CSV with the active filters", async ({ page }) => {
    let csvUrl = null;
    await mockBanksPageApis(page, {
      role: "ADMIN",
      onCsvRequest: (url) => {
        csvUrl = url;
      },
    });

    await page.goto("/admin/accounting/banks?bankId=bank-1");

    await expect(page.getByRole("heading", { name: "Bank Accounts" })).toBeVisible();
    await expect(page.getByText("Showing transactions for:")).toBeVisible();
    await expect(page.getByText("Transactions", { exact: true })).toBeVisible();
    await expect(page.getByText("Unmatched", { exact: true })).toBeVisible();

    await page.getByPlaceholder("Description, reference, amount, type...").fill("wire");
    await page.getByRole("button", { name: "Unmatched only: Off" }).click();
    await page.getByLabel("From date").fill("2026-04-01");
    await page.getByRole("button", { name: "Export filtered CSV" }).click();

    await expect.poll(() => Boolean(csvUrl)).toBe(true);
    expect(csvUrl.searchParams.get("format")).toBe("csv");
    expect(csvUrl.searchParams.get("q")).toBe("wire");
    expect(csvUrl.searchParams.get("unmatchedOnly")).toBe("1");
    expect(csvUrl.searchParams.get("from")).toBe("2026-04-01");
  });

  test("hides admin-only delete actions for accountants while keeping the page usable", async ({ page }) => {
    await mockBanksPageApis(page, { role: "ACCOUNTANT" });

    await page.goto("/admin/accounting/banks?bankId=bank-1");

    await expect(page.getByText("Delete actions require ADMIN role.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete selected" })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Wire transfer/i }).getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Test rules" })).toBeVisible();
  });
});
