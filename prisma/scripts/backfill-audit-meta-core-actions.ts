import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Meta = Record<string, unknown>;

function parseMeta(raw: string | null): Meta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    // ignore malformed legacy meta
  }
  return {};
}

async function backfillProductCreate() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "PRODUCT_CREATE", entityType: "PRODUCT" },
    select: { id: true, entityId: true, createdAt: true, meta: true },
  });
  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);
    const product = await prisma.product.findUnique({
      where: { id: row.entityId },
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
        brand: true,
        supplier: true,
        supplierId: true,
        price: true,
        cost: true,
        stock: true,
      },
    });
    const next: Meta = {
      ...prev,
      name: prev.name ?? product?.name ?? null,
      sku: prev.sku ?? product?.sku ?? null,
      category: prev.category ?? product?.category ?? null,
      brand: prev.brand ?? product?.brand ?? null,
      supplier: prev.supplier ?? product?.supplier ?? null,
      supplierId: prev.supplierId ?? product?.supplierId ?? null,
      price: prev.price ?? (product ? Number(product.price) : null),
      cost: prev.cost ?? (product ? Number(product.cost) : null),
      stock: prev.stock ?? product?.stock ?? null,
      resultSummary:
        prev.resultSummary ??
        `Created product ${String(prev.name ?? product?.name ?? "Unknown")} with opening stock ${String(prev.stock ?? product?.stock ?? 0)}.`,
      backfillVersion: 1,
      backfilledAt: new Date().toISOString(),
    };
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { meta: JSON.stringify(next) } });
      updated += 1;
    }
  }
  return { total: rows.length, updated };
}

async function backfillImageUpload() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "IMAGE_UPLOAD", entityType: "PRODUCT_IMAGE" },
    include: { actor: { select: { name: true, email: true, role: true } } },
  });
  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);
    const next: Meta = {
      ...prev,
      filename: prev.filename ?? null,
      mime: prev.mime ?? null,
      ext: prev.ext ?? null,
      size: prev.size ?? null,
      storage: prev.storage ?? "legacy-not-captured",
      url: prev.url ?? null,
      uploadedAt: prev.uploadedAt ?? row.createdAt.toISOString(),
      actorName: prev.actorName ?? row.actor?.name ?? null,
      actorEmail: prev.actorEmail ?? row.actor?.email ?? null,
      actorRole: prev.actorRole ?? row.actor?.role ?? null,
      resultSummary:
        prev.resultSummary ??
        `Uploaded image file ${String(prev.filename || "Unknown")}.`,
      backfillVersion: 1,
      backfilledAt: new Date().toISOString(),
    };
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { meta: JSON.stringify(next) } });
      updated += 1;
    }
  }
  return { total: rows.length, updated };
}

async function backfillPurchaseReceive() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "PURCHASE_RECEIVE", entityType: "PURCHASE" },
    select: { id: true, entityId: true, createdAt: true, meta: true },
  });
  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);
    const purchase = await prisma.purchase.findUnique({
      where: { id: row.entityId },
      include: { product: { select: { name: true } } },
    });
    const ordered = Number(
      prev.orderedQuantity ?? purchase?.orderedQuantity ?? purchase?.quantity ?? 0,
    );
    const received = Number(prev.receivedQuantity ?? purchase?.receivedQuantity ?? 0);
    const remaining = Number(prev.remainingQuantity ?? Math.max(0, ordered - received));
    const unitCost = Number(prev.unitCost ?? purchase?.unitCost ?? 0);
    const next: Meta = {
      ...prev,
      purchaseId: prev.purchaseId ?? row.entityId,
      productId: prev.productId ?? purchase?.productId ?? null,
      productName: prev.productName ?? purchase?.product?.name ?? null,
      orderedQuantity: ordered,
      receivedQuantity: received,
      remainingQuantity: remaining,
      unitCost,
      amount: prev.amount ?? unitCost * Math.max(0, Number(prev.delta ?? 0)),
      status: prev.status ?? purchase?.status ?? null,
      previousStatus: prev.previousStatus ?? "Unknown (legacy)",
      supplier: prev.supplier ?? purchase?.supplier ?? null,
      supplierId: prev.supplierId ?? purchase?.supplierId ?? null,
      lotCode: prev.lotCode ?? null,
      expiryDate: prev.expiryDate ?? null,
      resultSummary:
        prev.resultSummary ??
        `Received purchase stock for ${String(prev.productName ?? purchase?.product?.name ?? "Unknown product")}.`,
      backfillVersion: 1,
      backfilledAt: new Date().toISOString(),
    };
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { meta: JSON.stringify(next) } });
      updated += 1;
    }
  }
  return { total: rows.length, updated };
}

async function main() {
  const productCreate = await backfillProductCreate();
  const imageUpload = await backfillImageUpload();
  const purchaseReceive = await backfillPurchaseReceive();
  console.log(`PRODUCT_CREATE backfill: ${productCreate.updated}/${productCreate.total}`);
  console.log(`IMAGE_UPLOAD backfill: ${imageUpload.updated}/${imageUpload.total}`);
  console.log(`PURCHASE_RECEIVE backfill: ${purchaseReceive.updated}/${purchaseReceive.total}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
