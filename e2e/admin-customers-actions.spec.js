import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

const customerRow = {
  user: {
    id: "cust-1",
    email: "alice@example.com",
    name: "Alice Clinic",
    role: "CUSTOMER",
    phone: "0244000001",
    archived: false,
  },
  ordersTotal: 150,
  paidTotal: 100,
  paymentsTotal: 100,
  storeCredit: 25,
  refundedCash: 0,
  creditLimit: 200,
  lastOrderAt: "2026-04-01T10:00:00.000Z",
  cart: null,
  delivery: { delivered: 1, partial: 0, pending: 0 },
};

const employeeCustomerRow = {
  ...customerRow,
  user: {
    ...customerRow.user,
    id: "employee-1",
    email: "admin.customer@example.com",
    name: "Admin Customer",
    role: "ADMIN",
  },
};

function buildLargeCustomerRows() {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const n = index + 1;
    return {
      ...customerRow,
      user: {
        ...customerRow.user,
        id: `qa-cust-${String(n).padStart(2, "0")}`,
        email: `qa.customer.${n}+orders@example.com`,
        name: `QA Customer ${String(n).padStart(2, "0")}`,
        phone: `02440000${String(n).padStart(2, "0")}`,
        archived: false,
      },
      ordersTotal: n % 3 === 0 ? 300 + n : 0,
      paidTotal: n % 3 === 0 ? 120 : 0,
      paymentsTotal: n % 3 === 0 ? 120 : 0,
      storeCredit: n % 5 === 0 ? 35 : 0,
      creditLimit: n % 7 === 0 ? 100 : 0,
      lastOrderAt: n % 3 === 0 ? "2026-04-01T10:00:00.000Z" : null,
      cart: null,
      delivery: n % 3 === 0
        ? { delivered: 1, partial: 1, pending: 1 }
        : { delivered: 0, partial: 0, pending: 0 },
    };
  });

  rows[4] = {
    ...rows[4],
    user: {
      ...rows[4].user,
      id: "qa-edge-archived",
      email: "qa+edge.o'connor@example-health.com",
      name: "O'Connor & Sons Medical Procurement Account With Extra Long Name",
      archived: true,
    },
    ordersTotal: 1225.75,
    paidTotal: 225.25,
    paymentsTotal: 225.25,
    storeCredit: 75.5,
    creditLimit: 500,
    cart: {
      total: 184.25,
      totalItems: 3,
      items: [
        {
          id: "cart-edge-1",
          productName: "Sterile Gloves XL",
          quantity: 3,
          unitPrice: 61.4167,
          subtotal: 184.25,
        },
      ],
      updatedAt: "2026-04-04T12:00:00.000Z",
    },
    delivery: { delivered: 2, partial: 1, pending: 3 },
  };

  rows[5] = {
    ...rows[5],
    user: {
      ...rows[5].user,
      id: "qa-cart-balance",
      email: "cart.balance+qa@example.com",
      name: "Cart Balance Clinic",
    },
    ordersTotal: 875,
    paidTotal: 125,
    paymentsTotal: 125,
    storeCredit: 0,
    creditLimit: 250,
    cart: {
      total: 312.4,
      totalItems: 4,
      items: [],
      updatedAt: "2026-04-05T09:00:00.000Z",
    },
    delivery: { delivered: 0, partial: 2, pending: 4 },
  };

  return rows;
}

async function mockCustomersApis(page, trackers = {}, rows = [customerRow]) {
  await page.route("**/api/admin/customers?**", async (route) => {
    const url = new URL(route.request().url());
    const includeArchived = url.searchParams.get("includeArchived") === "1";
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const pageNumber = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("pageSize") || 25);
    const visibleRows = rows.filter((row) => {
      if (!includeArchived && row.user.archived) return false;
      if (!q) return true;
      const haystack = [
        row.user.id,
        row.user.name,
        row.user.email,
        row.user.phone,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
    const start = Math.max(0, (pageNumber - 1) * pageSize);
    await route.fulfill({
      json: {
        rows: visibleRows.slice(start, start + pageSize),
        total: visibleRows.length,
        page: pageNumber,
        pageSize,
        partial: false,
      },
    });
  });
  await page.route("**/api/admin/payments/summary?**", async (route) => {
    await route.fulfill({ json: { total: 100, count: 1 } });
  });
  await page.route("**/api/admin/customers/cust-1/profile", async (route) => {
    if (route.request().method() === "POST") {
      trackers.profileUpdates = (trackers.profileUpdates || 0) + 1;
      await route.fulfill({ json: { ok: true, userId: "cust-1", profile: "B2C" } });
      return;
    }
    await route.fulfill({
      json: {
        userId: "cust-1",
        profile: "B2B",
        name: "Alice Clinic",
        email: "alice@example.com",
        role: "CUSTOMER",
        phone: "0244000001",
        archived: false,
        deletedAt: null,
        createdAt: "2026-01-15T08:00:00.000Z",
        lastLoginAt: "2026-04-02T09:30:00.000Z",
        isEmployeeCustomer: false,
      },
    });
  });
  await page.route("**/api/admin/audit?**", async (route) => {
    await route.fulfill({
      json: trackers.auditRows || [
        {
          id: "audit-archive-1",
          action: "USER_ARCHIVE",
          entityType: "USER",
          entityId: "cust-1",
          createdAt: "2026-04-03T10:00:00.000Z",
          outcome: "SUCCESS",
          actor: { id: "admin-1", name: "Nora Admin", email: "admin@example.com", role: "ADMIN" },
          meta: {
            reason: "No longer active",
            sourcePage: "admin/customers",
          },
        },
      ],
    });
  });
  await page.route("**/api/admin/customers/cust-1/credit/apply", async (route) => {
    trackers.creditApplyCalls = (trackers.creditApplyCalls || 0) + 1;
    await route.fulfill({ json: { applied: 25, remainingBalance: 25, remainingCredit: 0 } });
  });
  await page.route("**/api/admin/customers/cust-1/balance", async (route) => {
    await route.fulfill({
      json: {
        ordersTotal: 150,
        paidTotal: 100,
        paymentsTotal: 100,
        balance: 50,
        storeCredit: 25,
        cashRefunds: 0,
        creditLimit: 200,
        updatedAt: "2026-04-01T10:00:00.000Z",
      },
    });
  });
  await page.route("**/api/orders/history?**", async (route) => {
    await route.fulfill({
      json: {
        orders: [
          {
            id: "order-1",
            status: "PARTIALLY_PAID",
            total: 150,
            amountPaid: 100,
            balance: 50,
            createdAt: "2026-04-01T10:00:00.000Z",
            items: [],
          },
        ],
      },
    });
  });
  await page.route("**/api/admin/users/**/archive", async (route) => {
    trackers.archiveCalls = (trackers.archiveCalls || 0) + 1;
    try {
      trackers.archivePayload = route.request().postDataJSON();
    } catch {
      trackers.archivePayload = null;
    }
    await route.fulfill({
      json: {
        id: "cust-1",
        email: "alice@example.com",
        archived: Boolean(trackers.archivePayload?.archived),
      },
    });
  });
  await page.route("**/api/admin/users/**/close", async (route) => {
    trackers.closeCalls = (trackers.closeCalls || 0) + 1;
    try {
      trackers.closePayload = route.request().postDataJSON();
    } catch {
      trackers.closePayload = null;
    }
    await route.fulfill({ status: 204, body: "" });
  });
}

test.describe("Admin customers actions", () => {
  test("applies store credit through the dedicated customer credit endpoint", async ({ page }) => {
    const trackers = {};
    await mockCustomersApis(page, trackers);

    await page.goto("/admin/customers");
    await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
    await page.getByRole("button", { name: "Customer actions" }).click();
    await page.getByRole("menuitem", { name: "Apply to Balance" }).click();

    await expect.poll(() => trackers.creditApplyCalls || 0).toBe(1);
    await expect(page.getByText(/store credit applied/i)).toBeVisible();
  });

  test("keeps customer account view read-only and moves profile editing to customer actions", async ({ page }) => {
    const trackers = {};
    await mockCustomersApis(page, trackers);

    await page.goto("/admin/customers/cust-1/view");
    await expect(page.getByRole("heading", { name: "Customer Account View" })).toBeVisible();
    await expect(page.getByText("Account Status")).toBeVisible();
    await expect(page.getByText("Recent lifecycle history")).toBeVisible();
    await expect(page.getByText("No longer active")).toBeVisible();
    await expect(page.getByRole("button", { name: /save profile/i })).toHaveCount(0);
    await expect(page.getByText("Customer Commerce Profile")).toHaveCount(0);

    await page.goto("/admin/customers");
    await page.getByRole("button", { name: "Customer actions" }).click();
    await page.getByRole("menuitem", { name: "Set commerce profile" }).click();
    await expect(page.getByRole("dialog", { name: "Set commerce profile" })).toBeVisible();
  });

  test("labels employee-owned customer ledger accounts", async ({ page }) => {
    await mockCustomersApis(page, {}, [employeeCustomerRow]);

    await page.goto("/admin/customers");

    await expect(page.getByText("Admin Customer").first()).toBeVisible();
    await expect(page.getByText("Admin customer").first()).toBeVisible();
  });

  test("handles realistic large customer data with archived, balance, cart, and edge contact values", async ({ page }) => {
    await mockCustomersApis(page, {}, buildLargeCustomerRows());

    await page.goto("/admin/customers");
    await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
    await expect(page.getByText("Showing 25 of 59 matching customers")).toBeVisible();

    await page.getByLabel("Include archived").check();
    await expect(page.getByText("Showing 25 of 60 matching customers")).toBeVisible();

    await page.getByPlaceholder(/search by name, email or phone/i).fill("qa+edge");
    await expect(page.getByText("O'Connor & Sons Medical Procurement Account With Extra Long Name").first()).toBeVisible();
    await expect(page.getByText("Archived").first()).toBeVisible();
    await expect(page.getByText(/1,225\.75/).first()).toBeVisible();
    await expect(page.getByText("3 items").first()).toBeVisible();

    await page.getByPlaceholder(/search by name, email or phone/i).fill("cart.balance");
    await expect(page.getByText("Cart Balance Clinic").first()).toBeVisible();
    await expect(page.getByText(/875\.00/).first()).toBeVisible();
    await expect(page.getByText("4 items").first()).toBeVisible();
    await expect(page.getByText("Over limit").first()).toBeVisible();
  });

  test("archives customer accounts from the customer actions menu with source metadata", async ({ page }) => {
    const trackers = {};
    await mockCustomersApis(page, trackers);

    await page.goto("/admin/customers");
    await page.getByRole("button", { name: "Customer actions" }).click();
    await page.getByRole("menuitem", { name: "Archive account" }).click();
    await expect(page.getByRole("dialog", { name: "Archive account" })).toBeVisible();
    await page.getByPlaceholder("Optional audit note").fill("No longer active");
    await page.getByRole("button", { name: /^Archive$/ }).click();

    await expect.poll(() => trackers.archiveCalls || 0).toBe(1);
    expect(trackers.archivePayload).toMatchObject({
      archived: true,
      reason: "No longer active",
      sourcePage: "admin/customers",
    });
  });

  test("closes only unused customer accounts with confirmation and reason", async ({ page }) => {
    const trackers = {};
    const unusedRow = {
      ...customerRow,
      ordersTotal: 0,
      paidTotal: 0,
      paymentsTotal: 0,
      storeCredit: 0,
      creditLimit: 0,
      lastOrderAt: null,
      delivery: { delivered: 0, partial: 0, pending: 0 },
    };
    await mockCustomersApis(page, trackers, [unusedRow]);

    await page.goto("/admin/customers");
    await page.getByRole("button", { name: "Customer actions" }).click();
    await page.getByRole("menuitem", { name: "Close account" }).click();
    await expect(page.getByRole("dialog", { name: "Close account" })).toBeVisible();
    await page.getByPlaceholder("alice@example.com").fill("alice@example.com");
    await page.locator("select").selectOption("Duplicate account");
    await page.getByRole("button", { name: /^Close account$/ }).click();

    await expect.poll(() => trackers.closeCalls || 0).toBe(1);
    expect(trackers.closePayload).toMatchObject({
      reason: "Duplicate account",
      sourcePage: "admin/customers",
    });
  });
});
