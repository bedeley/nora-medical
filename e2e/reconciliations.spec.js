import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function waitForReconciliationList(page) {
  await expect(page.locator("#history-search")).toBeVisible();
  await expect(page.getByRole("button", { name: /Close selected/i })).toBeVisible();
}

async function waitForWorkspace(page, txnName, lineName) {
  await expect(page.getByRole("button", { name: txnName })).toBeVisible();
  await expect(page.getByRole("button", { name: lineName })).toBeVisible();
}

async function expandAutoMatchTools(page) {
  const toggle = page.getByRole("button", { name: /Expand/i });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("button", { name: /^Exact amounts$/i })).toBeVisible();
}

test.describe("Accounting Reconciliations Page", () => {
  test("keyboard shortcuts help + search focus", async ({ page }) => {
    await page.goto("/admin/accounting/reconciliations");
    await waitForReconciliationList(page);

    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: /Keyboard Shortcuts/i });
    await expect(dialog.getByRole("heading", { name: /Keyboard Shortcuts/i })).toBeVisible();
    await dialog.getByRole("button", { name: /^Close$/i }).first().click();

    await page.keyboard.press("/");
    await expect(page.locator("#history-search")).toBeFocused();
  });

  test("bulk close dialog opens and shows dry-run area", async ({ page }) => {
    await page.goto("/admin/accounting/reconciliations");
    await waitForReconciliationList(page);

    await page.getByLabel(/Select page/i).check();
    await page.getByRole("button", { name: /Close selected/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Confirm Bulk Close/i)).toBeVisible();
    await expect(dialog).toContainText(/dry-run checklist|unmatched items/i);
  });

  test("bulk ZIP export button is reachable", async ({ page }) => {
    await page.goto("/admin/accounting/reconciliations");
    await waitForReconciliationList(page);
    await expect(page.getByRole("button", { name: /Export detailed CSVs/i })).toBeVisible();
  });
});

test.describe("Reconciliation Workspace Enhancements", () => {
  test("auto-match exact shows skip report and supports CSV download", async ({ page }) => {
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
    await waitForWorkspace(page, /TXN NO EXACT LINE/i, /1010 1010 Bank/i);
    await expandAutoMatchTools(page);
    await page.getByRole("button", { name: /^Exact amounts$/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Run auto-match\?/i)).toBeVisible();
    await dialog.getByRole("button", { name: /Run auto-match/i }).click();

    await expect(page.getByText(/Last:\s*exact/i)).toBeVisible();
    const downloadButton = page.getByRole("button", { name: /Download skip report/i });
    await expect(downloadButton).toBeEnabled();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/auto-match-skips-\d{4}-\d{2}-\d{2}\.csv/i);
  });

  test("undo last auto-match batch sends UNMATCHED updates", async ({ page }) => {
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
    await waitForWorkspace(page, /TXN EXACT/i, /1010 1010 Bank/i);
    await expandAutoMatchTools(page);
    await page.getByRole("button", { name: /^Exact amounts$/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Run auto-match\?/i)).toBeVisible();
    await dialog.getByRole("button", { name: /Run auto-match/i }).click();
    const undoButton = page.getByRole("button", { name: /Undo last batch/i });
    await expect(undoButton).toBeEnabled();
    await undoButton.click();

    await expect.poll(() => matchStatuses.filter((s) => s === "MATCHED").length).toBeGreaterThan(0);
    await expect.poll(() => matchStatuses.filter((s) => s === "UNMATCHED").length).toBeGreaterThan(0);
  });
});
