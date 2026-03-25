import { test, expect } from "@playwright/test";

async function signIn(page) {
  const email = process.env.E2E_ADMIN_EMAIL || "";
  const password = process.env.E2E_ADMIN_PASSWORD || "";
  test.skip(!email || !password, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for admin login.");

  await page.goto("/login");
  await page.getByPlaceholder(/email or username/i).fill(email);
  await page.getByPlaceholder(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in|login/i }).click();
  await page.waitForURL(/\/($|admin)/);
  await page.goto("/admin");
  await page.waitForURL(/\/admin/);
}

test.describe("Accounting Reconciliations Page", () => {
  test("keyboard shortcuts help + search focus", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");

    await page.keyboard.press("?");
    await expect(page.getByText(/Keyboard Shortcuts/i)).toBeVisible();
    await page.getByRole("button", { name: /close/i }).click();

    await page.keyboard.press("/");
    await expect(page.getByLabel("Search")).toBeFocused();
  });

  test("bulk close dialog opens and shows dry-run area", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");

    await page.getByText(/Select page/i).click();
    await page.getByRole("button", { name: /Close selected/i }).click();
    await expect(page.getByText(/Confirm Bulk Close/i)).toBeVisible();
    await expect(page.getByText(/dry-run/i)).toBeVisible();
  });

  test("bulk ZIP export button is reachable", async ({ page }) => {
    await signIn(page);
    await page.goto("/admin/accounting/reconciliations");
    await expect(page.getByRole("button", { name: /Export detailed CSVs/i })).toBeVisible();
  });
});

test.describe("Reconciliation Workspace Enhancements", () => {
  test("auto-match exact shows skip report and supports CSV download", async ({ page }) => {
    await signIn(page);
    const recId = "rec-skip";
    const bankId = "bank-1";

    await page.route(`**/api/admin/accounting/reconciliations/${recId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: recId,
          bankAccountId: bankId,
          bankAccount: { id: bankId, name: "Primary Operating Account", currency: "GHS" },
          periodStart: "2026-03-01T00:00:00.000Z",
          periodEnd: "2026-03-31T23:59:59.999Z",
          status: "IN_PROGRESS",
          lines: [],
        }),
      });
    });
    await page.route(`**/api/admin/accounting/banks/${bankId}/transactions`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "txn-1",
            postedAt: "2026-03-12T00:00:00.000Z",
            amount: 100,
            description: "TXN NO EXACT LINE",
            reference: "REF-1",
            type: "CREDIT",
            matched: false,
          },
        ]),
      });
    });
    await page.route("**/api/admin/accounting/journal", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "je-1",
            entryDate: "2026-03-10T00:00:00.000Z",
            status: "POSTED",
            memo: "seed",
            lines: [
              {
                id: "jl-1",
                accountId: "acct-1010",
                debit: 200,
                credit: 0,
                description: "bank line",
                account: { code: "1010", name: "1010 Bank" },
              },
            ],
          },
        ]),
      });
    });
    await page.route(`**/api/admin/accounting/banks/${bankId}/rules`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route(`**/api/admin/accounting/reconciliations/${recId}/activity`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.goto(`/admin/accounting/reconciliations/${recId}`);
    await page.getByRole("button", { name: /Auto-match exact amounts/i }).click();
    await page.getByRole("button", { name: /Run auto-match/i }).click();

    await expect(page.getByRole("heading", { name: /Last auto-match result/i })).toBeVisible();
    const downloadButton = page.getByRole("button", { name: /Download skip report/i });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/auto-match-skips-\d{4}-\d{2}-\d{2}\.csv/i);
  });

  test("undo last auto-match batch sends UNMATCHED updates", async ({ page }) => {
    await signIn(page);
    const recId = "rec-undo";
    const bankId = "bank-1";
    const matchStatuses = [];

    await page.route(`**/api/admin/accounting/reconciliations/${recId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: recId,
          bankAccountId: bankId,
          bankAccount: { id: bankId, name: "Primary Operating Account", currency: "GHS" },
          periodStart: "2026-03-01T00:00:00.000Z",
          periodEnd: "2026-03-31T23:59:59.999Z",
          status: "IN_PROGRESS",
          lines: [],
        }),
      });
    });
    await page.route(`**/api/admin/accounting/banks/${bankId}/transactions`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "txn-1",
            postedAt: "2026-03-12T00:00:00.000Z",
            amount: 500,
            description: "TXN EXACT",
            reference: "REF-1",
            type: "CREDIT",
            matched: false,
          },
        ]),
      });
    });
    await page.route("**/api/admin/accounting/journal", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "je-1",
            entryDate: "2026-03-12T00:00:00.000Z",
            status: "POSTED",
            memo: "seed",
            lines: [
              {
                id: "jl-1",
                accountId: "acct-1010",
                debit: 500,
                credit: 0,
                description: "bank line",
                account: { code: "1010", name: "1010 Bank" },
              },
            ],
          },
        ]),
      });
    });
    await page.route(`**/api/admin/accounting/banks/${bankId}/rules`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route(`**/api/admin/accounting/reconciliations/${recId}/activity`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route(`**/api/admin/accounting/reconciliations/${recId}/match`, async (route) => {
      const payload = route.request().postDataJSON();
      matchStatuses.push(payload.matchStatus);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto(`/admin/accounting/reconciliations/${recId}`);
    await page.getByRole("button", { name: /Auto-match exact amounts/i }).click();
    await page.getByRole("button", { name: /Run auto-match/i }).click();
    await expect(page.getByRole("button", { name: /Undo last auto-match batch/i })).toBeEnabled();
    await page.getByRole("button", { name: /Undo last auto-match batch/i }).click();

    await expect.poll(() => matchStatuses.filter((s) => s === "MATCHED").length).toBeGreaterThan(0);
    await expect.poll(() => matchStatuses.filter((s) => s === "UNMATCHED").length).toBeGreaterThan(0);
  });
});
