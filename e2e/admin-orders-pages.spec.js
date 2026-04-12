import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/.auth/admin.json" });

async function expectNoPageError(page) {
  await expect(page.locator("body")).not.toContainText(
    /application error|server error/i,
  );
}

async function openFirstOrderDetail(page) {
  await page.goto("/admin/orders");
  await page.waitForLoadState("networkidle");
  await expectNoPageError(page);

  const detailLink = page
    .locator('a[href^="/admin/orders/"]')
    .filter({ hasText: /\S/ })
    .first();

  await expect(detailLink).toBeVisible();
  const href = await detailLink.getAttribute("href");
  if (!href) {
    throw new Error("Expected at least one order detail link on /admin/orders.");
  }

  await detailLink.click();
  await page.waitForLoadState("networkidle");
  await expectNoPageError(page);
  return href;
}

test.describe("Admin order pages", () => {
  test("orders list page shows page-specific controls and opens a detail route", async ({
    page,
  }) => {
    await page.goto("/admin/orders");
    await page.waitForLoadState("networkidle");

    await expectNoPageError(page);
    await expect(
      page.getByRole("heading", { name: /^Orders$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Saved filters" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Create Order$/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/Page total:/i),
    ).toBeVisible();

    const detailHref = await openFirstOrderDetail(page);
    await expect(page).toHaveURL(detailHref);
    await expect(
      page.getByRole("button", { name: "Audit Log" }),
    ).toBeVisible();
  });

  test("new order page renders the core workflow sections", async ({ page }) => {
    await page.goto("/admin/orders/new");
    await page.waitForLoadState("networkidle");

    await expectNoPageError(page);
    await expect(
      page.getByRole("heading", { name: "Create Order" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Customer" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Order Lines" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Payment & Pricing" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Finalize Order" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Create Order$/i }).last(),
    ).toBeVisible();
  });

  test("order detail page renders route-specific actions and audit navigation", async ({
    page,
  }) => {
    const detailHref = await openFirstOrderDetail(page);

    await expect(page).toHaveURL(detailHref);
    await expect(
      page.getByRole("button", { name: "Audit Log" }),
    ).toBeVisible();
    await page.getByRole("button", {
      name: "Activity Timeline and customer signals",
    }).click();
    await expect(page.getByText("Activity Timeline")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Back to Orders/i }),
    ).toBeVisible();

    const recordPayment = page.getByRole("button", { name: "Record Payment" });
    if ((await recordPayment.count()) > 0) {
      await expect(recordPayment.first()).toBeVisible();
    }

    await page.getByRole("button", { name: "Audit Log" }).click();
    await expect(page).toHaveURL(
      /\/admin\/audit\?entityType=ORDER&entityId=.*sourcePage=admin\/orders\/\[id\]/,
    );
  });
});
