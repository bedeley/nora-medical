import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const summaryPayload = {
  stockMismatches: 1,
  negativeStock: 1,
  orderBalanceMismatches: 1,
  paymentMismatches: 1,
  legacyAutoApply: 1,
  ledgerMismatches: 2,
  missingPostings: {
    orders: 0,
    payments: 0,
    expenses: 0,
    purchases: 0,
    supplierPayments: 0,
    creditPayouts: 0,
    settlements: 0,
  },
  podCompliance7d: {
    delivered: 30,
    podCaptured: 22,
    podMissing: 8,
    podMissingRatePct: 26.7,
    thresholdPct: 15,
    minDelivered: 20,
    alert: true,
  },
};

const opsPayload = {
  freshness: {
    diagnosticsAt: "2026-04-02T12:00:00.000Z",
    alertSentAt: null,
    podAlertSentAt: null,
    autoHealAt: null,
  },
  acknowledgement: {
    owner: null,
    note: null,
    acknowledgedAt: null,
    acknowledgedByName: null,
    stillCurrent: false,
    status: "OPEN",
    dueAt: null,
    statusUpdatedAt: null,
    statusUpdatedByName: null,
    overdue: false,
    needsAssignment: true,
  },
  incident: null,
  activeIncidentLink: null,
  trend: [
    { date: "2026-03-27", issueCount: 1 },
    { date: "2026-03-28", issueCount: 2 },
    { date: "2026-03-29", issueCount: 2 },
    { date: "2026-03-30", issueCount: 3 },
    { date: "2026-03-31", issueCount: 2 },
    { date: "2026-04-01", issueCount: 2 },
    { date: "2026-04-02", issueCount: 2 },
  ],
  autoHeal: {
    enabled: false,
    lastRunAt: null,
    lastRunByName: null,
    lastResult: null,
  },
  exportLinks: {
    csv: "/api/admin/health/ops?format=csv",
    pdf: "/api/admin/health/ops?format=pdf",
    handoff: "/api/admin/health/ops?format=handoff",
  },
};

async function expectHashScroll(page, link, hash) {
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.locator(hash)).toBeVisible();
  await expect
    .poll(async () => {
      return page.locator(hash).evaluate((node) => Math.abs(node.getBoundingClientRect().top));
    })
    .toBeLessThan(220);
}

test.describe("Admin health routing", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/admin/health/summary", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(summaryPayload),
      });
    });

    await page.route("**/api/admin/health/ops", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(opsPayload),
      });
    });
  });

  test("open queue and runbook links point to the intended health sections", async ({ page }) => {
    await page.goto("/admin/health");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("#ledger-integrity")).toBeVisible();
    await expect(page.locator("#ledger-readiness")).toBeVisible();
    await expect(page.locator("#data-quality")).toBeVisible();
    await expect(page.locator("#payment-mismatches")).toBeVisible();
    await expect(page.locator("#order-balance-mismatches")).toBeVisible();
    await expect(page.locator("#stock-movement-mismatches")).toBeVisible();
    await expect(page.locator("#pod-compliance")).toBeVisible();

    await expect(page.getByText("Ledger mismatches")).toBeVisible();
    await expect(page.getByText("Posting + ledger")).toBeVisible();
    await expect(page.getByText("Payments + balances")).toBeVisible();
    await expect(page.getByText("POD compliance", { exact: true })).toBeVisible();

    const ledgerQueueLink = page.locator('a[href="/admin/health#ledger-integrity"]').filter({ hasText: "Open queue" });
    const postingSignalLink = page.locator('a[href="/admin/health#ledger-integrity"]').filter({ hasText: "Open signal view" });
    const stockSignalLink = page.locator('a[href="/admin/health#stock-movement-mismatches"]').filter({ hasText: "Open signal view" });
    const paymentsSignalLink = page.locator('a[href="/admin/health#data-quality"]').filter({ hasText: "Open signal view" });
    const podSignalLink = page.locator('a[href="/admin/health#pod-compliance"]').filter({ hasText: "Open signal view" });

    await expectHashScroll(page, ledgerQueueLink, "#ledger-integrity");
    await expectHashScroll(page, postingSignalLink, "#ledger-integrity");
    await expectHashScroll(page, stockSignalLink, "#stock-movement-mismatches");
    await expectHashScroll(page, paymentsSignalLink, "#data-quality");
    await expectHashScroll(page, podSignalLink, "#pod-compliance");
  });
});
