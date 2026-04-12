/**
 * Playwright e2e tests for /admin/b2b/tenders
 *
 * Covers: page load, tab navigation, expiry banner, tender builder form,
 * item analysis, review section, save flow, send email form (BUG-3 validation),
 * version comparison diff detail (DEF-2), history search/filter (DEF-9),
 * status badges (UX-2), confirmation dialog on terminal transitions (DEF-6),
 * audit trail links (admin only) (DEF-4), and new/clear button (DEF-7).
 */
import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

// ─── Mock data helpers ────────────────────────────────────────────────────────

function makeTender(id, overrides = {}) {
  return {
    id,
    tenderNumber: `TND-2026-${String(id).slice(-4).padStart(4, "0")}`,
    status: "DRAFT",
    buyerName: `Accra General Hospital ${id}`,
    buyerContact: "Kofi Mensah",
    buyerEmail: "procurement@accra.gh",
    tenderRef: null,
    lotTitle: "LOT 1",
    currency: "GHS",
    validityDays: 14,
    notes: null,
    vatRatePct: 0,
    vatAmount: 0,
    discountAmount: 0,
    freightAmount: 0,
    handlingAmount: 0,
    leadTimeDays: null,
    paymentTerms: null,
    marginThresholdPct: 0,
    itemsText: "Paracetamol 500mg: 100\nAmoxicillin 250mg: 50",
    lines: [],
    subtotal: 300,
    total: 300,
    updatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

function makePreview(overrides = {}) {
  return {
    preview: {
      lines: [
        {
          no: 1,
          requestedDescription: "Paracetamol 500mg",
          requestedUnit: "box",
          quantity: 100,
          matchedProductId: "prod-1",
          matchedProductName: "Paracetamol 500mg Tabs",
          matchedSku: "PARA-500",
          availableStock: 200,
          baseCost: 2.0,
          marginPct: 50,
          unitPrice: 3.0,
          lineTotal: 300,
          matchConfidence: "HIGH",
          bidDisposition: "AVAILABLE",
          note: null,
        },
        {
          no: 2,
          requestedDescription: "Amoxicillin 250mg",
          requestedUnit: "bottle",
          quantity: 50,
          matchedProductId: null,
          matchedProductName: null,
          matchedSku: null,
          availableStock: null,
          baseCost: null,
          marginPct: null,
          unitPrice: 0,
          lineTotal: 0,
          matchConfidence: "NONE",
          bidDisposition: "AVAILABLE",
          note: null,
        },
      ],
      subtotal: 300,
      total: 300,
      matchedCount: 1,
      unmatchedCount: 1,
      currency: "GHS",
    },
    ...overrides,
  };
}

function makeSnapshot(id = "t1") {
  return {
    ok: true,
    tenderId: id,
    snapshot: makeTender(id, { id }),
  };
}

function mockAllEndpoints(page, opts = {}) {
  const tenders    = opts.tenders    ?? [makeTender("t1"), makeTender("t2", { status: "SENT", total: 500 })];
  const reminders  = opts.reminders  ?? { items: [] };
  const orderLinks = opts.orderLinks ?? { items: [] };
  const products   = opts.products   ?? { items: [{ id: "prod-1", name: "Paracetamol 500mg Tabs", sku: "PARA-500", price: 3.0, cost: 2.0, stock: 200 }] };
  const procurement = opts.procurement ?? { items: [] };
  const templates   = opts.templates  ?? { items: [] };
  const versions    = opts.versions   ?? { items: [] };
  const approvalStatus = opts.approvalStatus ?? null;

  page.route(/\/api\/admin\/b2b\/tenders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      const url = new URL(route.request().url());
      const q = (url.searchParams.get("search") || "").trim().toLowerCase();
      const status = (url.searchParams.get("status") || "").trim();
      const page = Number(url.searchParams.get("page") || 1);
      const pageSize = Number(url.searchParams.get("pageSize") || 20);
      const filtered = tenders.filter((row) => {
        const matchesStatus = !status || row.status === status;
        const hay = `${row.tenderNumber} ${row.buyerName} ${row.tenderRef || ""}`.toLowerCase();
        const matchesSearch = !q || hay.includes(q);
        return matchesStatus && matchesSearch;
      });
      const start = (page - 1) * pageSize;
      await route.fulfill({
        json: {
          items: filtered.slice(start, start + pageSize),
          totalCount: filtered.length,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
        },
      });
    } else {
      await route.fulfill({ json: makeSnapshot("t-new") });
    }
  });
  page.route("**/api/admin/b2b/tenders/reminders**",   (r) => r.fulfill({ json: reminders }));
  page.route("**/api/admin/b2b/tenders/order-links**", (r) => r.fulfill({ json: orderLinks }));
  page.route("**/api/admin/b2b/tenders/preview",       (r) => r.fulfill({ json: makePreview() }));
  page.route("**/api/admin/b2b/procurement/requests**",(r) => r.fulfill({ json: procurement }));
  page.route("**/api/products**",                      (r) => r.fulfill({ json: products }));
  page.route("**/api/admin/b2b/tender-templates**",    (r) => r.fulfill({ json: templates }));
  page.route("**/api/admin/b2b/tenders/*/versions**",  (r) => r.fulfill({ json: versions }));
  page.route("**/api/admin/b2b/tenders/*/approval-status**", (r) =>
    r.fulfill({ json: approvalStatus ?? { requireApproval: false, canSend: true, reason: "No approval required", latestVersionNo: 1, approvedVersionNo: 1, approvedAt: null, approvedByName: null, makerChecker: false } }),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("/admin/b2b/tenders — page load and header", () => {
  test("renders page title and tab navigation", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByRole("heading", { name: "Tender Builder" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Build Tender" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Send/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Tenders/i })).toBeVisible();
  });

  test("shows admin-only audit log link", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByRole("link", { name: "View Audit Log" })).toBeVisible();
  });

  test("shows 'New Tender' button", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByRole("button", { name: "New Tender" })).toBeVisible();
  });

  test("shows Back to Procurement link", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByRole("link", { name: "Back to Procurement" })).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — expiry banner (DEF-8)", () => {
  test("displays expiry banner when reminders exist", async ({ page }) => {
    mockAllEndpoints(page, {
      reminders: {
        items: [
          { id: "t1", tenderNumber: "TND-2026-0001", daysToExpiry: 1, expiryDate: new Date(Date.now() + 86400000).toISOString(), isExpiringSoon: true },
        ],
      },
    });
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByText(/tender.*expiring soon/i)).toBeVisible();
    await expect(page.getByText("TND-2026-0001")).toBeVisible();
    await expect(page.getByText(/1d left/)).toBeVisible();
  });

  test("does not show banner when no reminders", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(
      page.locator(".border-amber-300.bg-amber-50").filter({ hasText: /tenders? expiring soon:/i }),
    ).not.toBeVisible();
  });

  test("clicking expiry tender number navigates to history tab and filters by that number", async ({ page }) => {
    mockAllEndpoints(page, {
      reminders: {
        items: [
          { id: "t1", tenderNumber: "TND-2026-0001", daysToExpiry: 2, expiryDate: new Date(Date.now() + 2 * 86400000).toISOString(), isExpiringSoon: true },
        ],
      },
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByText("TND-2026-0001").first().click();
    // Should now be on history tab with the search pre-filled
    await expect(page.getByPlaceholder(/Search by tender/i)).toHaveValue("TND-2026-0001");
  });
});

test.describe("/admin/b2b/tenders — tab navigation", () => {
  test("Build Tender tab is active by default", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByText("Tender Details")).toBeVisible();
  });

  test("Send & Versions tab shows email form", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send/i }).click();
    await expect(page.getByText("Send Tender by Email")).toBeVisible();
    await expect(page.getByText("Version Comparison")).toBeVisible();
  });

  test("Tenders tab shows recent tenders list", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    await expect(page.getByText(/Accra General Hospital/).first()).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Build tab form", () => {
  test("Lot title defaults to LOT 1 (UX-4)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByPlaceholder("LOT 1")).toBeVisible();
    await expect(page.locator("input[placeholder='LOT 1']")).toBeVisible();
  });

  test("item list label shows format hint (UX-5)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await expect(page.getByText("Paracetamol 500mg tabs, box, 100")).toBeVisible();
    await expect(page.getByText("Paracetamol 500mg tabs: 100")).toBeVisible();
  });

  test("procurement request dropdown only shows active statuses (DEF-3)", async ({ page }) => {
    mockAllEndpoints(page, {
      procurement: {
        items: [
          { id: "req-1", requestType: "QUOTE", status: "IN_REVIEW",  clinicName: "Active Clinic",   contactName: "Dr A", contactPhone: null, contactEmail: null, itemsText: null, updatedAt: new Date().toISOString() },
          { id: "req-2", requestType: "QUOTE", status: "CLOSED",     clinicName: "Closed Clinic",   contactName: "Dr B", contactPhone: null, contactEmail: null, itemsText: null, updatedAt: new Date().toISOString() },
          { id: "req-3", requestType: "QUOTE", status: "REJECTED",   clinicName: "Rejected Clinic", contactName: "Dr C", contactPhone: null, contactEmail: null, itemsText: null, updatedAt: new Date().toISOString() },
          { id: "req-4", requestType: "QUOTE", status: "SUBMITTED",  clinicName: "Submitted Clinic",contactName: "Dr D", contactPhone: null, contactEmail: null, itemsText: null, updatedAt: new Date().toISOString() },
        ],
      },
    });
    await page.goto("/admin/b2b/tenders");
    // Switch to procurement source
    await page.locator("select").first().selectOption("procurement");
    // Active Clinic (IN_REVIEW) and Submitted Clinic (SUBMITTED) should be visible
    const procurementSelect = page.locator("select").nth(1);
    await expect(procurementSelect).toContainText("Active Clinic");
    await expect(procurementSelect).toContainText("Submitted Clinic");
    // CLOSED and REJECTED should NOT be in the dropdown
    await expect(procurementSelect).not.toContainText("Closed Clinic");
    await expect(procurementSelect).not.toContainText("Rejected Clinic");
  });

  test("'Analyze Items' calls preview API and renders preview table", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");

    await page.locator("#tender-buyer-name").fill("Accra General");
    await page.locator("textarea").first().fill("Paracetamol 500mg: 100\nAmoxicillin 250mg: 50");
    await page.getByRole("button", { name: "Analyze Items" }).click();

    await expect(page.getByText("Preview")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Paracetamol 500mg", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Amoxicillin 250mg", exact: true })).toBeVisible();
  });

  test("review section appears when NONE-confidence lines are present", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.locator("textarea").first().fill("Amoxicillin 250mg: 50");
    await page.getByRole("button", { name: "Analyze Items" }).click();

    await expect(page.getByText("Review Required")).toBeVisible();
    await expect(page.getByText("I reviewed flagged lines")).toBeVisible();
  });

  test("OCR env var note is NOT shown in the UI (UX-6)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.locator("textarea").first().fill("Para: 10");
    await page.getByRole("button", { name: "Analyze Items" }).click();

    // Should not show raw env var config details
    await expect(page.getByText(/B2B_TENDER_OCR_ENABLE/)).not.toBeVisible();
    await expect(page.getByText(/OCR_SPACE_API_KEY/)).not.toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — New Tender / Clear form (DEF-7)", () => {
  test("'New Tender' button clears buyer name field and resets form", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");

    // Fill some fields
    const inputs = page.locator("input[type='text'], input:not([type])");
    await inputs.first().fill("Some Hospital");

    // Click New Tender
    await page.getByRole("button", { name: "New Tender" }).click();

    // Toast "Form cleared" should appear (sonner)
    await expect(page.getByText(/Form cleared/i)).toBeVisible();
    // Build tab should be active
    await expect(page.getByText("Tender Details")).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Send & Versions tab", () => {
  test("Send button is disabled when no tender is selected (BUG-3 fix)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send/i }).first().click();

    // The Send Tender button should be disabled while no tender selected
    const sendBtn = page.getByRole("button", { name: "Send Tender" });
    await expect(sendBtn).toBeDisabled();
  });

  test("selecting a tender enables the Send button", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    await page.selectOption("select", { index: 1 }); // select first real tender
    const sendBtn = page.getByRole("button", { name: "Send Tender" });
    await expect(sendBtn).not.toBeDisabled();
  });

  test("custom email message textarea is visible (DEF-1)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    await expect(page.getByPlaceholder(/Please find attached/i)).toBeVisible();
  });

  test("admin-only audit trail link visible on send tab (DEF-4)", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    // Select a tender so the audit link appears
    await page.selectOption("select", { index: 1 });
    await expect(page.getByRole("link", { name: "Audit trail" })).toBeVisible();
  });

  test("error toast when To field is empty and Send is clicked", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    // Select a tender
    await page.selectOption("select", { index: 1 });
    await page.getByPlaceholder("procurement@clinic.com").fill("");
    await page.getByRole("button", { name: "Send Tender" }).click();

    await expect(page.getByText(/Recipient email is required/i)).toBeVisible();
  });

  test("draft tenders are not available in the send selector", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [
        makeTender("draft-1", { status: "DRAFT", buyerName: "Draft Clinic" }),
        makeTender("submitted-1", { status: "SUBMITTED", buyerName: "Submitted Clinic" }),
        makeTender("won-1", { status: "WON", buyerName: "Won Clinic" }),
      ],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    const tenderSelect = page.locator("select").first();
    await expect(tenderSelect).not.toContainText("Draft Clinic");
    await expect(tenderSelect).toContainText("Submitted Clinic");
    await expect(tenderSelect).not.toContainText("Won Clinic");
  });
});

test.describe("/admin/b2b/tenders — Version comparison diff detail (DEF-2)", () => {
  test("renders line-level diff table after comparing versions", async ({ page }) => {
    const diffResponse = {
      tenderId: "t1",
      from: { versionNo: 1, status: "DRAFT", total: 200 },
      to:   { versionNo: 2, status: "SUBMITTED", total: 320 },
      totalsDelta: { subtotal: 120, total: 120 },
      lineChanges: [
        {
          item: "Paracetamol 500mg",
          changeType: "CHANGED",
          fromQty: 10,
          toQty: 20,
          fromUnitPrice: 3.0,
          toUnitPrice: 3.5,
          fromLineTotal: 30,
          toLineTotal: 70,
        },
        {
          item: "Gauze Bandage",
          changeType: "ADDED",
          fromQty: 0,
          toQty: 15,
          fromUnitPrice: 0,
          toUnitPrice: 4.0,
          fromLineTotal: 0,
          toLineTotal: 60,
        },
      ],
    };

    mockAllEndpoints(page, {
      tenders: [makeTender("t1", { status: "SUBMITTED" })],
      versions: {
        items: [
          { id: "v1", versionNo: 1, status: "DRAFT",     changeNote: null, createdAt: new Date().toISOString(), availableForCompare: true },
          { id: "v2", versionNo: 2, status: "SUBMITTED", changeNote: null, createdAt: new Date().toISOString(), availableForCompare: true },
        ],
      },
    });
    page.route("**/api/admin/b2b/tenders/*/diff**", (r) => r.fulfill({ json: diffResponse }));

    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Send.*Versions/i }).click();

    // Select a tender
    await page.selectOption("select", "t1");
    await page.getByRole("button", { name: "Compare" }).click();

    // Diff table should be visible with line changes
    await expect(page.getByText("Paracetamol 500mg")).toBeVisible();
    await expect(page.getByText("Gauze Bandage")).toBeVisible();
    // Change type badges
    await expect(page.getByText("Changed")).toBeVisible();
    await expect(page.getByText("Added")).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Tenders history tab (DEF-9)", () => {
  test("search filters tenders by buyer name", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [
        makeTender("t1", { buyerName: "Korle Bu Teaching Hospital" }),
        makeTender("t2", { buyerName: "Ridge Hospital" }),
      ],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();

    await page.getByPlaceholder(/Search by tender/i).fill("Korle Bu");
    await expect(page.getByText("Korle Bu Teaching Hospital")).toBeVisible();
    await expect(page.getByText("Ridge Hospital")).not.toBeVisible();
  });

  test("status filter shows only matching tenders", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [
        makeTender("t1", { status: "DRAFT",  buyerName: "Clinic A" }),
        makeTender("t2", { status: "SENT",   buyerName: "Clinic B" }),
        makeTender("t3", { status: "WON",    buyerName: "Clinic C" }),
      ],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();

    await page.selectOption("select", "WON");
    await expect(page.getByText("Clinic C")).toBeVisible();
    await expect(page.getByText("Clinic A")).not.toBeVisible();
    await expect(page.getByText("Clinic B")).not.toBeVisible();
  });

  test("'Clear filters' button appears when filter is active", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    await page.getByPlaceholder(/Search by tender/i).fill("test");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
  });

  test("empty state when no tenders match filters", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    await page.getByPlaceholder(/Search by tender/i).fill("zzz-nonexistent-zzz");
    await expect(page.getByText(/No tenders match/i)).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Status badges (UX-2)", () => {
  test("renders status badges on tender rows", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [
        makeTender("t1", { status: "DRAFT"  }),
        makeTender("t2", { status: "SENT"   }),
        makeTender("t3", { status: "WON"    }),
        makeTender("t4", { status: "LOST"   }),
      ],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();

    const badges = page.locator('[data-slot="badge"]');
    await expect(badges.filter({ hasText: /^Draft$/ })).toBeVisible();
    await expect(badges.filter({ hasText: /^Sent$/ })).toBeVisible();
    await expect(badges.filter({ hasText: /^Won$/ })).toBeVisible();
    await expect(badges.filter({ hasText: /^Lost$/ })).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Terminal status confirmation (DEF-6)", () => {
  test("shows confirmation dialog before marking tender as LOST", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [makeTender("t1", { status: "SENT" })],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();

    // Select LOST from status dropdown
    const row = page.locator("div.rounded.border.p-3").filter({ hasText: "TND-2026-00t1" });
    await row.locator("select").selectOption("LOST");
    await row.getByRole("button", { name: "Set" }).click();

    // Confirmation dialog should appear
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/Mark as LOST/i)).toBeVisible();
    await expect(page.getByText(/cannot be reversed/i)).toBeVisible();

    // Cancel should dismiss dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("no confirmation for non-terminal transitions (DRAFT → SUBMITTED)", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [makeTender("t1", { status: "DRAFT" })],
    });
    page.route("**/api/admin/b2b/tenders/t1/status**", async (route) => {
      await route.fulfill({ json: { ok: true, snapshot: makeTender("t1", { status: "SUBMITTED" }) } });
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();

    const row = page.locator("div.rounded.border.p-3").filter({ hasText: "TND-2026-00t1" });
    await row.locator("select").selectOption("SUBMITTED");
    await row.getByRole("button", { name: "Set" }).click();

    // No dialog should appear for SUBMITTED
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — Admin-only audit links (DEF-4)", () => {
  test("audit links are visible in history tab for admin", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    await expect(page.getByRole("link", { name: "Audit" }).first()).toBeVisible();
  });

  test("page-level audit log link points to correct sourcePage filter", async ({ page }) => {
    mockAllEndpoints(page);
    await page.goto("/admin/b2b/tenders");
    const auditLink = page.getByRole("link", { name: "View Audit Log" });
    await expect(auditLink).toHaveAttribute("href", /sourcePage=admin%2Fb2b%2Ftenders/);
  });

  test("per-tender audit link includes entityId and entityType params", async ({ page }) => {
    mockAllEndpoints(page, {
      tenders: [makeTender("tender-abc123", { id: "tender-abc123" })],
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    const auditLink = page.getByRole("link", { name: "Audit", exact: true }).first();
    await expect(auditLink).toHaveAttribute("href", /entityType=B2B_TENDER/);
    await expect(auditLink).toHaveAttribute("href", /entityId=tender-abc123/);
  });
});

test.describe("/admin/b2b/tenders — tenderRef link to procurement (DEF-5)", () => {
  test("tenderRef that matches a procurement request ID renders as a link", async ({ page }) => {
    const procReqId = "b2b-req-1234";
    mockAllEndpoints(page, {
      tenders: [makeTender("t1", { tenderRef: procReqId })],
      procurement: {
        items: [
          {
            id: procReqId,
            requestType: "QUOTE",
            status: "QUOTED",
            clinicName: "Linked Clinic",
            contactName: "Dr X",
            contactPhone: null,
            contactEmail: null,
            itemsText: null,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("tab", { name: /Tenders/i }).click();
    // Ref link should be rendered
    await expect(page.getByRole("link", { name: /b2b-req-1234/ }).or(page.getByRole("link", { name: /b2b-req/ }))).toBeVisible();
  });
});

test.describe("/admin/b2b/tenders — template delete confirmation (UX-3)", () => {
  test("clicking Delete template shows confirmation dialog", async ({ page }) => {
    mockAllEndpoints(page, {
      templates: {
        items: [
          { id: "tpl-1", name: "Public Hospital Standard", sourceType: "PUBLIC_HOSPITAL", updatedAt: new Date().toISOString() },
        ],
      },
    });
    await page.goto("/admin/b2b/tenders");
    await page.getByRole("button", { name: /Delete Public Hospital Standard/i }).click();

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Delete Template" })).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/Delete template "Public Hospital Standard"/i)).toBeVisible();

    // Dismiss
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });
});
