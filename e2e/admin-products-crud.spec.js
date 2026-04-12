import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test.use({ storageState: "e2e/.auth/admin.json" });

const prisma = new PrismaClient();

async function searchForProduct(page, productName) {
  const searchInput = page.getByTestId("products-search-input");
  await searchInput.fill(productName);
  await page.waitForLoadState("networkidle");
}

async function cleanupE2eProductArtifacts() {
  const products = await prisma.product.findMany({
    where: {
      OR: [
        { name: { contains: "E2e Product" } },
        { supplier: { contains: "E2E Supplier" } },
        { supplier: { contains: "E2E Seed Supplier" } },
      ],
    },
    select: { id: true, supplier: true },
  });
  const productIds = products.map((product) => product.id);
  const supplierNames = Array.from(
    new Set(
      products
        .map((product) => product.supplier)
        .filter((supplier) => supplier && supplier.startsWith("E2E ")),
    ),
  );

  if (productIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { entityType: "PRODUCT", entityId: { in: productIds } },
    });
    await prisma.productSupplier.deleteMany({
      where: { productId: { in: productIds } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: productIds } },
    });
  }

  if (supplierNames.length > 0) {
    await prisma.supplier.deleteMany({
      where: { name: { in: supplierNames } },
    });
  }
}

test.describe("Admin products CRUD", () => {
  test.afterEach(async () => {
    await cleanupE2eProductArtifacts();
  });

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  test("can create, edit, reroute inventory changes, and archive a product", async ({ page }) => {
    const uniqueId = Date.now();
    const productName = `E2E Product ${uniqueId}`;
    const editedDescription = `Updated product description ${uniqueId}`;
    const replacementSupplier = `E2E Supplier ${uniqueId}`;

    await page.goto("/admin/products");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("add-product-trigger").click();
    const addDialog = page.getByRole("dialog", { name: /add new product/i });
    await expect(addDialog).toBeVisible();

    await addDialog.locator('input[name="name"]').fill(productName);
    await addDialog.locator('input[name="description"]').fill(`Initial description ${uniqueId}`);
    await addDialog.locator('input[name="imageUrl"]').fill("/placeholder.png");
    await addDialog.locator('select[name="category"]').selectOption({ index: 1 });
    await addDialog.locator('input[name="brand"]').fill("E2E Brand");
    await addDialog.locator('input[name="supplier"]').fill(`E2E Seed Supplier ${uniqueId}`);
    await addDialog.locator('input[name="price"]').fill("36");
    await addDialog.locator('input[name="cost"]').fill("18");
    await addDialog.locator('input[name="stock"]').fill("0");
    await addDialog.getByRole("button", { name: /save product/i }).click();
    await expect(addDialog).not.toBeVisible();

    await searchForProduct(page, productName);
    const productRow = page.locator("tr", { hasText: productName }).first();
    await expect(productRow).toBeVisible();

    await productRow.getByRole("button", { name: /actions/i }).click();
    await page.getByRole("menuitem", { name: /^Edit$/i }).click();

    const editDialog = page.getByRole("dialog", { name: /edit product/i });
    await expect(editDialog).toBeVisible();
    await editDialog.locator('input[name="description"]').fill(editedDescription);
    await editDialog.locator('input[name="supplier"]').fill(replacementSupplier);
    await editDialog.locator('input[name="editReason"]').fill("E2E edit verification");
    await editDialog.getByRole("button", { name: /save changes/i }).click();
    await expect(editDialog).not.toBeVisible();

    await expect(productRow).toContainText(replacementSupplier);

    await productRow.getByRole("button", { name: /actions/i }).click();
    await page.getByRole("menuitem", { name: /adjust inventory/i }).click();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/admin\/stock-adjustments\?/);
    await expect(page.getByText(new RegExp(productName, "i")).first()).toBeVisible();

    await page.goto(`/admin/products?q=${encodeURIComponent(productName)}`);
    await page.waitForLoadState("networkidle");
    const archivedRow = page.locator("tr", { hasText: productName }).first();
    await expect(archivedRow).toBeVisible();

    await archivedRow.getByRole("button", { name: /actions/i }).click();
    await page.getByRole("menuitem", { name: /^Archive$/i }).click();
    const reasonDialog = page.getByRole("dialog", { name: /reason for change/i });
    await expect(reasonDialog).toBeVisible();
    await reasonDialog.locator("input").fill("E2E archive verification");
    await reasonDialog.getByRole("button", { name: /confirm/i }).click();

    await expect(page.locator("tr", { hasText: productName })).toHaveCount(0);

    await page.locator('label:has-text("Include archived") input').check();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("tr", { hasText: productName }).first()).toContainText("Archived");
  });
});
