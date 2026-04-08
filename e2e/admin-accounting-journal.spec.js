import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const MOCK_ACCOUNTS = [
  { id: "acc-cash", code: "1000", name: "Cash", type: "ASSET" },
  { id: "acc-ar", code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { id: "acc-ap", code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { id: "acc-inv", code: "1200", name: "Inventory", type: "ASSET" },
  { id: "acc-accrued", code: "2300", name: "Accrued Expenses", type: "LIABILITY" },
  { id: "acc-sales", code: "4000", name: "Sales Revenue", type: "INCOME" },
];

const MOCK_ENTRIES = [
  {
    id: "entry-large",
    entryDate: "2026-04-01T00:00:00.000Z",
    memo: "Medium transfer",
    sourceType: "PAYMENT",
    sourceId: "payment-1",
    status: "POSTED",
    archivedAt: null,
    lines: [
      { id: "line-large-1", debit: 1500, credit: 0, account: MOCK_ACCOUNTS[0] },
      { id: "line-large-2", debit: 0, credit: 1500, account: MOCK_ACCOUNTS[1] },
    ],
  },
  {
    id: "entry-draft",
    entryDate: "2026-04-02T00:00:00.000Z",
    memo: "Small transfer",
    sourceType: "PAYMENT",
    sourceId: "payment-2",
    status: "DRAFT",
    archivedAt: null,
    lines: [
      { id: "line-small-1", debit: 900, credit: 0, account: MOCK_ACCOUNTS[0] },
      { id: "line-small-2", debit: 0, credit: 900, account: MOCK_ACCOUNTS[1] },
    ],
  },
];

async function openJournal(page) {
  await page.goto("/admin/accounting/journal");
  await page.waitForLoadState("networkidle");
}

async function openJournalAt(page, path) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

function buildSummary(entries, largeAmountThreshold) {
  const summary = {
    total: entries.length,
    posted: 0,
    draft: 0,
    void: 0,
    debit: 0,
    credit: 0,
    outOfBalanceCount: 0,
    exceptionCounts: {
      missingRef: 0,
      largeAmount: 0,
      staleDraft: 0,
    },
    sourceCounts: {},
    draftQueue: {
      count: 0,
      oldest: null,
      oldestAgeDays: 0,
    },
  };

  const drafts = [];
  for (const entry of entries) {
    const debit = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
    const credit = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
    if (entry.status === "POSTED") summary.posted += 1;
    if (entry.status === "DRAFT") {
      summary.draft += 1;
      drafts.push(entry);
    }
    if (entry.status === "VOID") summary.void += 1;
    summary.debit += debit;
    summary.credit += credit;
    summary.sourceCounts[entry.sourceType] = (summary.sourceCounts[entry.sourceType] || 0) + 1;
    if (Math.abs(debit - credit) > 0.01) summary.outOfBalanceCount += 1;
    if (Math.max(Math.abs(debit), Math.abs(credit)) >= largeAmountThreshold) {
      summary.exceptionCounts.largeAmount += 1;
    }
  }
  drafts.sort((a, b) => new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime());
  if (drafts[0]) {
    summary.draftQueue = {
      count: drafts.length,
      oldest: {
        id: drafts[0].id,
        entryDate: drafts[0].entryDate,
        memo: drafts[0].memo,
      },
      oldestAgeDays: 1,
    };
  }
  return summary;
}

function entryTotal(entry) {
  const debit = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const credit = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  return { debit, credit };
}

function entryVariance(entry) {
  const { debit, credit } = entryTotal(entry);
  return Math.abs(debit - credit);
}

async function mockJournalApis(
  page,
  { role = "ADMIN", largeAmountThreshold = 25000, entries = MOCK_ENTRIES, onJournalRequest } = {},
) {
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
  await page.route("**/api/admin/accounting/accounts", async (route) => {
    await route.fulfill({ json: MOCK_ACCOUNTS });
  });
  await page.route("**/api/admin/accounting/periods", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/admin/accounting/tax-codes", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/admin/accounting/journal/policy", async (route) => {
    await route.fulfill({
      json: {
        policy: {
          recentWindowDays: 90,
          manualEntryAllowPnl: false,
          archiveAfterMonths: 18,
          archiveCronDryRun: false,
          largeAmountAnomalyThreshold: largeAmountThreshold,
        },
      },
    });
  });
  await page.route("**/api/admin/audit?entityType=JournalEntry&limit=100", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route("**/api/admin/accounting/journal?*", async (route) => {
    const url = new URL(route.request().url());
    onJournalRequest?.(url);
    const sourceFilter = String(url.searchParams.get("sourceType") || "").toUpperCase();
    const largeAmountOnly = url.searchParams.get("largeAmount") === "1";
    const balanceScope = url.searchParams.get("balanceScope") === "1";
    const aggregate = url.searchParams.get("aggregate") === "1";
    const paginate = url.searchParams.get("paginate") === "1";
    const largestVariance = url.searchParams.get("largestVariance") === "1";
    const pageNumber = Math.max(1, Number(url.searchParams.get("page") || "1"));
    const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") || "25"));
    const entriesForFilters = sourceFilter
      ? entries.filter((entry) => String(entry.sourceType || "").toUpperCase() === sourceFilter)
      : entries;
    let visibleEntries = largeAmountOnly
      ? entriesForFilters.filter((entry) => {
          const { debit, credit } = entryTotal(entry);
          return Math.max(Math.abs(debit), Math.abs(credit)) >= largeAmountThreshold;
        })
      : entriesForFilters;
    if (largestVariance) {
      visibleEntries = [...visibleEntries].sort((a, b) => {
        const varianceDiff = entryVariance(b) - entryVariance(a);
        if (varianceDiff !== 0) return varianceDiff;
        return String(a.id).localeCompare(String(b.id));
      });
    }

    if (aggregate) {
      await route.fulfill({ json: buildSummary(visibleEntries, largeAmountThreshold) });
      return;
    }
    if (balanceScope) {
      const balanceEntries = sourceFilter
        ? entries.filter((entry) => String(entry.sourceType || "").toUpperCase() === sourceFilter)
        : entries;
      await route.fulfill({
        json: balanceEntries.map((entry) => ({
          id: entry.id,
          entryDate: entry.entryDate,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          sourceLabel: entry.sourceLabel ?? null,
          apBalanceAfter: null,
          lines: entry.lines.map((line) => ({
            debit: line.debit,
            credit: line.credit,
            account: { code: line.account.code },
          })),
        })),
      });
      return;
    }
    const pagedEntries = paginate
      ? visibleEntries.slice((pageNumber - 1) * pageSize, (pageNumber - 1) * pageSize + pageSize)
      : visibleEntries;
    await route.fulfill({
      json: {
        items: pagedEntries,
        page: pageNumber,
        pageSize,
        total: visibleEntries.length,
        totalPages: Math.max(1, Math.ceil(visibleEntries.length / pageSize)),
      },
    });
  });
}

test.describe("Admin accounting journal", () => {
  test("advanced filters drawer keeps the footer reachable", async ({ page }) => {
    await openJournal(page);
    await page.getByRole("button", { name: /advanced filters/i }).click();

    const dialog = page.getByRole("dialog", { name: /advanced filters/i });
    await expect(dialog).toBeVisible();

    const closeButtons = dialog.getByRole("button", { name: /^close$/i });
    const footerCloseButton = closeButtons.last();
    await footerCloseButton.scrollIntoViewIfNeeded();
    await expect(footerCloseButton).toBeVisible();

    const box = await footerCloseButton.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect((box?.y || 0) + (box?.height || 0)).toBeLessThanOrEqual((viewport?.height || 0) + 1);
  });

  test("account drill chips sit below the account dropdown", async ({ page }) => {
    await openJournal(page);
    await page.getByRole("button", { name: /advanced filters/i }).click();

    const dialog = page.getByRole("dialog", { name: /advanced filters/i });
    await expect(dialog).toBeVisible();

    const accountSelect = dialog.locator("select").nth(4);
    const firstAccountChip = dialog.getByRole("button", { name: "1100" }).first();

    await expect(accountSelect).toBeVisible();
    await expect(firstAccountChip).toBeVisible();

    const selectBox = await accountSelect.boundingBox();
    const chipBox = await firstAccountChip.boundingBox();
    expect(selectBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    expect((chipBox?.y || 0) - ((selectBox?.y || 0) + (selectBox?.height || 0))).toBeGreaterThanOrEqual(8);
  });

  test("large amount filter respects the configured threshold", async ({ page }) => {
    await mockJournalApis(page, { largeAmountThreshold: 1000 });
    await openJournal(page);

    await expect(page.getByRole("cell", { name: /Medium transfer/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Small transfer/i }).first()).toBeVisible();

    await page.getByRole("button", { name: /advanced filters/i }).click();
    const dialog = page.getByRole("dialog", { name: /advanced filters/i });
    const largeAmountButton = dialog.getByRole("button", { name: /Large amount \(1\)/i });
    await expect(largeAmountButton).toBeVisible();

    await largeAmountButton.click();
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Entries:\s*1/i).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Small transfer/i })).toHaveCount(0);
  });

  test("accountants can see draft posting controls", async ({ page }) => {
    await mockJournalApis(page, { role: "ACCOUNTANT" });
    await openJournal(page);

    await page.getByRole("button", { name: /advanced filters/i }).click();
    const dialog = page.getByRole("dialog", { name: /advanced filters/i });

    await expect(dialog.getByRole("button", { name: /Approve selected/i })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Select drafts across pages/i })).toBeVisible();
    await expect(dialog.getByText(/Posting actions are limited to roles with journal posting rights\./i)).toHaveCount(0);
  });

  test("AR balance after uses accounting scope even when filtered to payments", async ({ page }) => {
    const balanceScopeEntries = [
      {
        id: "entry-order",
        entryDate: "2026-04-01T00:00:00.000Z",
        memo: "Customer invoice",
        sourceType: "ORDER",
        sourceId: "order-1",
        sourceLabel: "INV-1",
        status: "POSTED",
        archivedAt: null,
        lines: [
          { id: "line-order-1", debit: 1000, credit: 0, account: MOCK_ACCOUNTS[1] },
          { id: "line-order-2", debit: 0, credit: 1000, account: MOCK_ACCOUNTS[5] },
        ],
      },
      {
        id: "entry-payment",
        entryDate: "2026-04-02T00:00:00.000Z",
        memo: "Customer payment",
        sourceType: "PAYMENT",
        sourceId: "payment-1",
        sourceLabel: "INV-1",
        status: "POSTED",
        archivedAt: null,
        lines: [
          { id: "line-payment-1", debit: 1000, credit: 0, account: MOCK_ACCOUNTS[0] },
          { id: "line-payment-2", debit: 0, credit: 1000, account: MOCK_ACCOUNTS[1] },
        ],
      },
    ];

    await mockJournalApis(page, { entries: balanceScopeEntries });
    await openJournalAt(page, "/admin/accounting/journal?sourceType=PAYMENT");

    await expect(page.getByRole("cell", { name: /Customer payment/i }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Customer invoice/i })).toHaveCount(0);

    await page.getByRole("button", { name: /View lines/i }).first().click();

    const arBalanceBlock = page.locator("div").filter({ hasText: /AR balance after/i }).last();
    await expect(arBalanceBlock).toBeVisible();
    await expect(arBalanceBlock).toContainText(/0\.00/);
  });

  test("filtered export fetches the full scope instead of only the current page", async ({ page }) => {
    const exportEntries = Array.from({ length: 30 }, (_, index) => ({
      id: `entry-${index + 1}`,
      entryDate: `2026-04-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
      memo: `Export entry ${index + 1}`,
      sourceType: "PAYMENT",
      sourceId: `payment-${index + 1}`,
      status: "POSTED",
      archivedAt: null,
      lines: [
        { id: `line-${index + 1}-1`, debit: 100 + index, credit: 0, account: MOCK_ACCOUNTS[0] },
        { id: `line-${index + 1}-2`, debit: 0, credit: 100 + index, account: MOCK_ACCOUNTS[1] },
      ],
    }));
    const journalRequests = [];

    await mockJournalApis(page, {
      entries: exportEntries,
      onJournalRequest: (url) => journalRequests.push(url.searchParams.toString()),
    });
    await openJournal(page);

    const journalTable = page.locator("table").first();
    await expect(journalTable.getByText(/Export entry 25/i)).toBeVisible();
    await expect(journalTable.getByText(/Export entry 30/i)).toHaveCount(0);

    await page.getByRole("button", { name: /Export CSV \(filtered\)/i }).click();
    await expect.poll(() => journalRequests.filter((params) => !params.includes("aggregate=1") && !params.includes("balanceScope=1")).length).toBeGreaterThan(1);

    const exportRequest = [...journalRequests]
      .reverse()
      .find((params) => !params.includes("aggregate=1") && !params.includes("balanceScope=1") && !params.includes("idsOnly=1"));
    expect(exportRequest).toBeTruthy();
    expect(exportRequest).not.toContain("paginate=1");
  });

  test("largest variance first reorders results across pages, not just within the current page", async ({ page }) => {
    const varianceEntries = Array.from({ length: 26 }, (_, index) => ({
      id: `variance-entry-${index + 1}`,
      entryDate: `2026-04-${String((index % 9) + 1).padStart(2, "0")}T00:00:00.000Z`,
      memo: `Variance entry ${index + 1}`,
      sourceType: "PAYMENT",
      sourceId: `payment-${index + 1}`,
      status: "POSTED",
      archivedAt: null,
      lines: [
        { id: `variance-line-${index + 1}-1`, debit: 100, credit: 0, account: MOCK_ACCOUNTS[0] },
        { id: `variance-line-${index + 1}-2`, debit: 0, credit: 100, account: MOCK_ACCOUNTS[1] },
      ],
    }));
    varianceEntries[25] = {
      id: "variance-entry-26",
      entryDate: "2026-04-09T00:00:00.000Z",
      memo: "Highest variance entry",
      sourceType: "PAYMENT",
      sourceId: "payment-26",
      status: "POSTED",
      archivedAt: null,
      lines: [
        { id: "variance-line-26-1", debit: 5000, credit: 0, account: MOCK_ACCOUNTS[0] },
        { id: "variance-line-26-2", debit: 0, credit: 4200, account: MOCK_ACCOUNTS[1] },
      ],
    };

    const journalRequests = [];
    await mockJournalApis(page, {
      entries: varianceEntries,
      onJournalRequest: (url) => journalRequests.push(url.searchParams.toString()),
    });
    await openJournal(page);

    const journalTable = page.locator("table").first();
    await expect(journalTable.getByText(/Highest variance entry/i)).toHaveCount(0);

    await page.getByRole("button", { name: /advanced filters/i }).click();
    const dialog = page.getByRole("dialog", { name: /advanced filters/i });
    await dialog.getByRole("button", { name: /Largest variance first/i }).click();
    await expect
      .poll(() =>
        journalRequests.some((params) => params.includes("largestVariance=1") && params.includes("outOfBalance=1")),
      )
      .toBeTruthy();

    await expect(journalTable.getByText(/Highest variance entry/i)).toBeVisible();
  });
});
