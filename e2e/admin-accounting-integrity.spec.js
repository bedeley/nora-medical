import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const integrityPayload = {
  draftEntries: 0,
  arLedger: 400,
  customerBalances: 400,
  arDifference: 0,
  inventoryLedger: 100,
  inventoryValuation: 3300,
  inventoryDifference: -3200,
  inventoryPurchaseBacked: 1220,
  inventoryGlOnly: -1120,
  negativeStockCount: 0,
  apLedger: 2140,
  apOperational: 1220,
  apDifference: 920,
  apOperationalBacked: 1220,
  apGlOnly: 920,
  trialBalance: 0,
  glRevenue: 1200,
  revenueOperational: 0,
  revenueDifference: 1200,
  revenueOrderBacked: 0,
  revenueGlOnly: 1200,
  glCogs: 2120,
  cogsOperational: 0,
  cogsDifference: 2120,
  cogsOrderBacked: 0,
  cogsGlOnly: 2120,
  glVat: 60,
  vatOperational: 0,
  vatDifference: 60,
  vatOrderBacked: 0,
  vatGlOnly: 60,
  glStoreCredit: 0,
  storeCreditOperational: 0,
  storeCreditDifference: 0,
  glCash: 50,
  glBank: 75,
  draftAging: { fresh: 0, warning: 0, old: 0, critical: 0 },
  draftEntriesSample: [],
  duplicatePayments: { count: 0, items: [] },
  customerOverpayments: { count: 0, items: [] },
  orderBalanceIssues: { count: 0, items: [] },
  supplierOverpayments: { count: 0, items: [] },
  missingPostings: {
    orders: 0,
    payments: 0,
    expenses: 0,
    purchases: 0,
    supplierPayments: 0,
    creditPayouts: 0,
    settlements: 0,
  },
  missingPostingItems: {
    orders: [],
    payments: [],
    expenses: [],
    purchases: [],
    supplierPayments: [],
    creditPayouts: [],
    settlements: [],
  },
  recentPostFailures: [],
};

const drilldownPayload = {
  key: "ap",
  label: "AP (Payables)",
  code: "2000",
  asOf: "2026-04-01",
  difference: 920,
  methodology: [
    "GL side includes every posted journal line on account 2000.",
    "Operational side includes received purchases and supplier payments.",
  ],
  alerts: [
    { tone: "warning", message: "1 GL-only AP journal row(s) totaling 920.00 are included in the GL balance." },
  ],
  ledger: {
    code: "2000",
    name: "Accounts Payable",
    total: 2140,
    rows: [
      {
        id: "jl-1",
        entryId: "je-1",
        date: "2026-03-08T00:00:00.000Z",
        sourceType: "PURCHASE",
        sourceId: null,
        memo: "Inventory restock",
        description: "Supplier payable",
        debit: 0,
        credit: 920,
        amount: 920,
        traceStatus: "gl_only",
        traceCategory: "GL-only AP journal",
        traceNote: "No linked received purchase or supplier payment source.",
      },
    ],
  },
  operational: {
    label: "Received AP contributors",
    total: 1220,
    rows: [
      {
        id: "purchase-1",
        date: "2026-03-12T00:00:00.000Z",
        type: "Received purchase",
        reference: "Wheelchair (WHE-001)",
        detail: "MedEquip Co.",
        amount: 400,
      },
    ],
  },
};

test.describe("Accounting integrity page", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/admin/settings/app?**", async (route) => {
      const url = new URL(route.request().url());
      const key = url.searchParams.get("key");
      if (key === "accounting.integrity.thresholds") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            value: {
              arDifference: 0.01,
              inventoryDifference: 0.01,
              apDifference: 0.01,
              trialBalance: 0.01,
              revenueDifference: 0.01,
              vatDifference: 0.01,
              cogsDifference: 0.01,
              storeCreditDifference: 0.01,
              draftEntries: true,
              negativeStock: true,
            },
          }),
        });
      }
      if (key === "accounting.integrity.acknowledgements") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: [] }) });
      }
      if (key === "accounting.integrity.lastSync") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: null }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: null }) });
    });

    await page.route("**/api/admin/accounting/integrity/drilldown?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(drilldownPayload),
      });
    });

    await page.route("**/api/admin/accounting/integrity?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(integrityPayload),
      });
    });
  });

  test("keeps reconciliation visible in problems-only mode and opens a trace snapshot", async ({ page }) => {
    await page.goto("/admin/accounting/integrity?asOf=2026-04-01");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Data Integrity" })).toBeVisible();
    await expect(page.getByText(/severity by signal/i)).toBeVisible();
    await expect(page.getByText(/GL vs Operational reconciliation/i)).toBeVisible();
    await expect(page.getByText("AR (Receivables)")).toBeVisible();
    await expect(page.getByText("AP (Payables)")).toBeVisible();

    await page.getByLabel(/show problems only/i).check();

    const apRow = page.locator("tr", { hasText: "AP (Payables)" }).filter({ hasText: "Trace snapshot" }).first();
    const inventoryRow = page.locator("tr", { hasText: "Inventory" }).filter({ hasText: "Trace snapshot" }).first();
    const revenueRow = page.locator("tr", { hasText: "Revenue" }).filter({ hasText: "Trace snapshot" }).first();
    const arRow = page.locator("tr", { hasText: "AR (Receivables)" }).filter({ hasText: "Trace snapshot" });

    await expect(page.getByText(/GL vs Operational reconciliation/i)).toBeVisible();
    await expect(apRow).toBeVisible();
    await expect(inventoryRow).toBeVisible();
    await expect(revenueRow).toBeVisible();
    await expect(arRow).toHaveCount(0);

    await apRow.getByRole("button", { name: /trace snapshot/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/AP \(Payables\) snapshot trace/i)).toBeVisible();
    await expect(dialog.getByText("1 GL-only AP journal row(s) totaling 920.00 are included in the GL balance.")).toBeVisible();
    await expect(dialog.getByText(/Received AP contributors/i)).toBeVisible();
  });
});
