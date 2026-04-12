import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function mockMovementsPageApis(page) {
  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      json: {
        user: {
          name: "Nora Admin",
          email: "admin@example.com",
          role: "ADMIN",
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
    });
  });

  await page.route("**/api/products?**", async (route) => {
    await route.fulfill({
      json: {
        items: [
          { id: "prod-1", name: "Amoxicillin", sku: "AMX-10" },
          { id: "prod-2", name: "Syringe", sku: "SYR-1" },
        ],
        total: 2,
      },
    });
  });

  await page.route("**/api/admin/movements/detail-view", async (route) => {
    await route.fulfill({ json: { ok: true } });
  });

  await page.route("**/api/admin/movements?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("format") === "csv") {
      await route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        body: '"Date","Product","SKU","Delta","Reason","Note","Supplier","Unit Cost","Lot","Expiry"\n',
      });
      return;
    }

    await route.fulfill({
      json: {
        items: [
          {
            id: "mov-1",
            productId: "prod-1",
            purchaseId: "pur-1",
            productName: "Amoxicillin",
            productSku: "AMX-10",
            delta: 12,
            reason: "PURCHASE",
            note: "Batch received",
            supplier: "Med Supply",
            unitCost: 12.5,
            lotCode: "lot-1",
            expiryDate: "2027-01-01T00:00:00.000Z",
            createdAt: "2026-04-08T10:00:00.000Z",
          },
          {
            id: "mov-2",
            productId: "prod-2",
            purchaseId: null,
            productName: "Syringe",
            productSku: "SYR-1",
            delta: -3,
            reason: "SALE",
            note: null,
            supplier: null,
            unitCost: null,
            lotCode: null,
            expiryDate: null,
            createdAt: "2026-04-08T09:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        sortBy: url.searchParams.get("sortBy") || "createdAt",
        sortDir: url.searchParams.get("sortDir") || "desc",
        stats: {
          totalIn: 12,
          totalOut: 3,
          net: 9,
        },
      },
    });
  });
}

test.describe("Admin movements page", () => {
  test("shows scoped audit access, filter context, and movement details", async ({ page }) => {
    await mockMovementsPageApis(page);

    await page.goto("/admin/movements?lotId=lot-1");
    await expect(page.getByText("Inventory Movements").first()).toBeVisible();
    await expect(page.getByText("Lot filter:")).toBeVisible();
    await expect(page.getByText("lot-1")).toBeVisible();

    const auditLink = page.getByRole("link", { name: "View audit trail" });
    await expect(auditLink).toBeVisible();
    await expect(auditLink).toHaveAttribute("href", "/admin/audit?sourcePage=admin/movements");

    await expect(page.locator("table").getByText("Amoxicillin")).toBeVisible();
    await expect(page.getByText("2 filtered rows")).toBeVisible();

    await page.getByRole("button", { name: "View details" }).first().click();

    const dialog = page.getByRole("dialog", { name: "Movement Details" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Batch received")).toBeVisible();
    await expect(dialog.getByText("Med Supply")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "View source purchase" })).toHaveAttribute(
      "href",
      "/admin/purchases?purchaseId=pur-1",
    );

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
