import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

// ---------------------------------------------------------------------------
// Shared mock data helpers
// ---------------------------------------------------------------------------

function makeSnapshot(id, overrides = {}) {
  return {
    id,
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "SUBMITTED",
    clinicName: `Accra Medical ${id}`,
    contactName: "Kofi Mensah",
    contactPhone: "+233501234567",
    contactEmail: "kofi@accra.gh",
    notes: null,
    poDocumentUrl: null,
    templateId: null,
    itemsText: "Gloves x 20\nSyringes x 10",
    accountManagerId: null,
    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    customer: { id: "cust-1", name: "General Hospital", email: "orders@general.gh", role: "CUSTOMER" },
    accountManager: null,
    isArchived: false,
    ...overrides,
  };
}

function makeRequestsResponse(items = [], overrides = {}) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    totalPages: 1,
    archiveAfterDays: 30,
    clinicOptions: items.map((r) => r.clinicName),
    managerOptions: [],
    ...overrides,
  };
}

function makeAnalyticsResponse(overrides = {}) {
  return {
    summary: {
      totalRequests: 3,
      openCount: 2,
      unassignedOpenCount: 1,
      draftEligibleCount: 3,
      convertedToDraftCount: 1,
      convertedToDraftRatePct: 33.3,
      avgHoursToAssignment: 4.5,
      avgHoursToQuoted: 12.0,
      avgHoursToApproved: 24.0,
      statusCounts: { SUBMITTED: 1, IN_REVIEW: 1, APPROVED: 1 },
      requestTypeCounts: { QUOTE: 2, PO_UPLOAD: 1 },
    },
    topRequested: [
      { itemRef: "gloves", count: 5 },
      { itemRef: "syringes", count: 3 },
    ],
    oldestOpen: [
      {
        id: "req-old",
        status: "IN_REVIEW",
        requestType: "QUOTE",
        clinicName: "Old Clinic",
        ageDays: 14,
        hasAssignment: false,
        accountManagerId: null,
      },
    ],
    managerWorkload: [
      { managerId: "mgr-1", managerName: "Ama Owusu", openCount: 2, inReviewCount: 1, quotedCount: 1 },
      { managerId: "__unassigned__", managerName: "Unassigned", openCount: 1, inReviewCount: 0, quotedCount: 0 },
    ],
    trend: [
      { month: "2026-01", submitted: 2, approved: 1, rejected: 0, closed: 0 },
      { month: "2026-02", submitted: 1, approved: 0, rejected: 1, closed: 0 },
    ],
    truncated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Main workflow page
// ---------------------------------------------------------------------------

test.describe("Admin B2B Procurement - workflow page", () => {
  test("renders page title and navigation links without errors", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByRole("heading", { name: /B2B Procurement Workflow/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Analytics dashboard/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Tender builder/i })).toBeVisible();
    // Admin-only audit link should be visible for admin session
    await expect(page.getByRole("link", { name: /View audit log/i })).toBeVisible();
  });

  test("shows export CSV link", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("link", { name: /Export CSV/i })).toBeVisible();
  });

  test("renders 'No procurement requests found' when list is empty", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/No procurement requests found/i)).toBeVisible();
  });

  test("renders request cards with status badges and contact info", async ({ page }) => {
    const items = [
      makeSnapshot("req-1", { status: "IN_REVIEW", clinicName: "Kumasi Clinic", contactPhone: "+233209999999" }),
      makeSnapshot("req-2", { status: "QUOTED", accountManagerId: "mgr-1", accountManager: { id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" } }),
    ];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Status badges: use first() because the SelectValue also renders the status text.
    await expect(page.getByText("In Review").first()).toBeVisible();
    await expect(page.getByText("Quoted").first()).toBeVisible();

    // Clinic name
    await expect(page.getByText("Kumasi Clinic")).toBeVisible();

    // Contact info
    await expect(page.getByText("+233209999999")).toBeVisible();
    // Both cards share the default contactEmail from makeSnapshot, so use first().
    await expect(page.getByText("kofi@accra.gh").first()).toBeVisible();
  });

  test("SLA chip is visible for open requests", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "SUBMITTED" })];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // SLA chip should show "Xh old" or "Xd old"
    await expect(page.locator("span").filter({ hasText: /\d+[hd] old/ }).first()).toBeVisible();
  });

  test("filter bar has Type, Manager, date range, and search inputs", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Queue dropdown
    await expect(page.getByLabel(/Queue/i)).toBeVisible();
    // Type dropdown
    await expect(page.getByLabel(/Type/i)).toBeVisible();
    // Search input
    await expect(page.getByPlaceholder(/Search clinic/i)).toBeVisible();
    // Date inputs (From / To)
    await expect(page.getByLabel(/^From$/i)).toBeVisible();
    await expect(page.getByLabel(/^To$/i)).toBeVisible();
  });

  test("clear filters button appears when search is active", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Initially no clear button
    await expect(page.getByRole("button", { name: /Clear filters/i })).toHaveCount(0);

    // Type in search
    await page.getByPlaceholder(/Search clinic/i).fill("Accra");

    // Clear filters button appears
    await expect(page.getByRole("button", { name: /Clear filters/i })).toBeVisible();
    await page.getByRole("button", { name: /Clear filters/i }).click();
    await expect(page.getByPlaceholder(/Search clinic/i)).toHaveValue("");
  });

  test("bulk action bar is hidden when nothing is selected", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "SUBMITTED" })];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Bulk actions bar should not be visible when nothing selected
    await expect(page.getByText(/Bulk actions/i)).toHaveCount(0);
  });

  test("bulk action bar appears when a request is selected", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "SUBMITTED" })];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Check the row checkbox
    await page.locator("input[type=checkbox]").nth(1).check(); // nth(0) is the select-all
    await expect(page.getByText(/Bulk actions \(1 selected\)/i)).toBeVisible();
  });

  test("SUBMITTED is not a selectable status transition target", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: "mgr-1" })];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Open the status dropdown for the first request (nth(0)=manager, nth(1)=status)
    // shadcn SelectTrigger renders data-slot="select-trigger", not data-radix-select-trigger
    const statusTrigger = page.locator("[data-slot='select-trigger']").nth(1);
    await statusTrigger.click();
    // "Submitted" should not appear as an option
    await expect(page.getByRole("option", { name: /^Submitted$/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("reopen reason chips are compact buttons with short text", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "REJECTED", updatedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() })];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Expand the collapsed terminal card
    await page.getByRole("button", { name: /Expand/i }).click();

    // Reopen reason template chips should exist
    await expect(page.getByText(/Customer updated scope/i)).toBeVisible();
    await expect(page.getByText(/Pricing revised/i)).toBeVisible();
  });

  test("assign manager shows auto-promotion toast for SUBMITTED request", async ({ page }) => {
    const items = [makeSnapshot("req-1", { status: "SUBMITTED" })];

    // Register the refetch list handler first (lower LIFO priority)
    let listCallCount = 0;
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      listCallCount++;
      if (listCallCount === 1) {
        await route.fulfill({ json: makeRequestsResponse(items) });
      } else {
        await route.fulfill({ json: makeRequestsResponse([makeSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: "mgr-1" })]) });
      }
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({
        json: {
          rows: [{ user: { id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" } }],
        },
      });
    });
    // Register the assign handler LAST so it has the highest LIFO priority.
    // The wildcard pattern above also matches sub-routes, so registering assign last
    // ensures it intercepts /requests/req-1/assign before the list handler does.
    await page.route("**/api/admin/b2b/procurement/requests/req-1/assign", async (route) => {
      await route.fulfill({
        json: { ok: true, autoPromoted: true, previousStatus: "SUBMITTED", snapshot: { status: "IN_REVIEW" }, notification: { ok: true } },
      });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Select manager: shadcn SelectTrigger renders data-slot="select-trigger".
    await page.locator("[data-slot='select-trigger']").first().click();
    await page.getByRole("option", { name: "Ama Owusu" }).click();

    // Click assign
    await page.getByRole("button", { name: /^Assign$/i }).first().click();

    // Toast should mention auto-advancement
    await expect(page.getByText(/advanced from Submitted to In Review/i)).toBeVisible();
  });

  test("select-all checkbox selects all visible requests", async ({ page }) => {
    const items = [makeSnapshot("req-1"), makeSnapshot("req-2"), makeSnapshot("req-3")];
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse(items) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    // Check select-all
    await page.locator("input[type=checkbox]").first().check();
    await expect(page.getByText(/Bulk actions \(3 selected\)/i)).toBeVisible();

    // Uncheck select-all
    await page.locator("input[type=checkbox]").first().uncheck();
    await expect(page.getByText(/Bulk actions/i)).toHaveCount(0);
  });

  test("audit log link routes to audit page with correct entityType filter", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      await route.fulfill({ json: makeRequestsResponse([]) });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement");
    await page.waitForLoadState("networkidle");

    const auditLink = page.getByRole("link", { name: /View audit log/i });
    const href = await auditLink.getAttribute("href");
    expect(href).toContain("entityType=B2B_PROCUREMENT_REQUEST");
    expect(href).toContain("sourcePage=admin%2Fb2b%2Fprocurement");
  });

  test("URL search param pre-filters the workflow queue", async ({ page }) => {
    let capturedUrl = "";
    await page.route("**/api/admin/b2b/procurement/requests**", async (route) => {
      capturedUrl = route.request().url();
      await route.fulfill({
        json: makeRequestsResponse([
          makeSnapshot("req-1", { clinicName: "Kumasi Clinic" }),
        ]),
      });
    });
    await page.route("**/api/admin/customers**", async (route) => {
      await route.fulfill({ json: { rows: [] } });
    });

    await page.goto("/admin/b2b/procurement?search=Kumasi&highlight=req-1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByPlaceholder(/Search clinic/i)).toHaveValue("Kumasi");
    expect(capturedUrl).toContain("q=Kumasi");
    await expect(page.getByText("Kumasi Clinic")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Analytics page
// ---------------------------------------------------------------------------

test.describe("Admin B2B Procurement - analytics page", () => {
  test("renders analytics without errors", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("body")).not.toContainText(/application error|server error/i);
    await expect(page.getByRole("heading", { name: /B2B Procurement Analytics/i })).toBeVisible();
  });

  test("shows KPI cards with correct data", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    // Draft conversion rate (unique value on the page)
    await expect(page.getByText("33.3%")).toBeVisible();

    // Oldest open
    await expect(page.getByText("Old Clinic")).toBeVisible();
    await expect(page.getByText("14d open")).toBeVisible();
  });

  test("date range filter inputs are present and functional", async ({ page }) => {
    let capturedUrl = "";
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      capturedUrl = route.request().url();
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByLabel(/From date/i)).toBeVisible();
    await expect(page.getByLabel(/To date/i)).toBeVisible();

    // Set date filter
    await page.getByLabel(/From date/i).fill("2026-01-01");
    await page.waitForLoadState("networkidle");

    // The API should have been called with start param
    expect(capturedUrl).toContain("start=2026-01-01");
  });

  test("'Clear dates' button appears when date filter is set and resets it", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("button", { name: /Clear dates/i })).toHaveCount(0);

    await page.getByLabel(/From date/i).fill("2026-01-01");
    await expect(page.getByRole("button", { name: /Clear dates/i })).toBeVisible();

    await page.getByRole("button", { name: /Clear dates/i }).click();
    await expect(page.getByLabel(/From date/i)).toHaveValue("");
    await expect(page.getByRole("button", { name: /Clear dates/i })).toHaveCount(0);
  });

  test("top requested items are shown with rank indicators", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("gloves")).toBeVisible();
    await expect(page.getByText("syringes")).toBeVisible();
    // Rank indicators
    await expect(page.getByText("#1")).toBeVisible();
    await expect(page.getByText("#2")).toBeVisible();
  });

  test("back to workflow link is present", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("link", { name: /Back to Workflow/i })).toBeVisible();
  });

  test("refresh button triggers new API call", async ({ page }) => {
    let callCount = 0;
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      callCount++;
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    const initialCount = callCount;
    await page.getByRole("button", { name: /Refresh/i }).click();
    await page.waitForLoadState("networkidle");

    expect(callCount).toBeGreaterThan(initialCount);
  });

  test("audit log link is visible for admin and has correct href", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    const auditLink = page.getByRole("link", { name: /View audit log/i });
    await expect(auditLink).toBeVisible();
    const href = await auditLink.getAttribute("href");
    expect(href).toContain("entityType=B2B_PROCUREMENT_ANALYTICS");
    expect(href).toContain("sourcePage=admin%2Fb2b%2Fprocurement%2Fanalytics");
  });

  test("shows error banner when API returns a server error", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ status: 500, body: "Internal Server Error" });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("alert").filter({ hasText: /failed to load analytics/i }),
    ).toBeVisible();
  });

  test("shows truncation warning when API returns truncated:true", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse({ truncated: true }) });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("alert").filter({ hasText: /data may be incomplete/i }),
    ).toBeVisible();
  });

  test("does NOT show truncation warning when truncated:false", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse({ truncated: false }) });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("alert").filter({ hasText: /data may be incomplete/i }),
    ).toHaveCount(0);
  });

  test("shows manager workload section with manager names and counts", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Manager Workload/i)).toBeVisible();
    await expect(page.getByText("Ama Owusu")).toBeVisible();
    // Use exact match to avoid collision with "Unassigned open" and "Quote · Unassigned"
    await expect(page.getByText("Unassigned", { exact: true })).toBeVisible();
  });

  test("oldest open requests are clickable links to the workflow page", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    const oldClinicRow = page.getByRole("link", { name: /Open Old Clinic request/i });
    await expect(oldClinicRow).toBeVisible();
    const href = await oldClinicRow.getAttribute("href");
    expect(href).toContain("/admin/b2b/procurement");
    expect(href).toContain("Old%20Clinic");
  });

  test("shows date validation error when start is after end", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await page.getByLabel(/From date/i).fill("2026-06-01");
    await page.getByLabel(/To date/i).fill("2026-01-01");

    await expect(
      page.getByRole("alert").filter({ hasText: /start date must be before/i }),
    ).toBeVisible();
  });

  test("shows 'last updated' timestamp after data loads", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    // "Updated just now" or "Updated Xs ago"
    await expect(page.getByText(/Updated/i)).toBeVisible();
  });

  test("renders monthly trend chart section when trend data present", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse() });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Monthly Submission Trend/i)).toBeVisible();
  });

  test("does not render trend chart when trend array is empty", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({ json: makeAnalyticsResponse({ trend: [] }) });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(/Monthly Submission Trend/i)).toHaveCount(0);
  });

  test("cycle time card shows formatted hours (< 1h for sub-hour values)", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({
        json: makeAnalyticsResponse({
          summary: {
            totalRequests: 1,
            openCount: 1,
            unassignedOpenCount: 0,
            convertedToDraftCount: 0,
            convertedToDraftRatePct: 0,
            avgHoursToAssignment: 0.3, // sub-hour
            avgHoursToQuoted: null,
            avgHoursToApproved: null,
            statusCounts: { SUBMITTED: 1 },
            requestTypeCounts: { QUOTE: 1 },
          },
        }),
      });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("< 1h")).toBeVisible();
  });

  test("cycle time card shows n/a for null cycle times", async ({ page }) => {
    await page.route("**/api/admin/b2b/procurement/analytics**", async (route) => {
      await route.fulfill({
        json: makeAnalyticsResponse({
          summary: {
            totalRequests: 1,
            openCount: 1,
            unassignedOpenCount: 0,
            convertedToDraftCount: 0,
            convertedToDraftRatePct: 0,
            avgHoursToAssignment: null,
            avgHoursToQuoted: null,
            avgHoursToApproved: null,
            statusCounts: { SUBMITTED: 1 },
            requestTypeCounts: { QUOTE: 1 },
          },
        }),
      });
    });

    await page.goto("/admin/b2b/procurement/analytics");
    await page.waitForLoadState("networkidle");

    const placeholders = await page.getByText("n/a").all();
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
  });
});
