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
    // ignore
  }
  return {};
}

async function backfillPurchaseApprove() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "PURCHASE_APPROVE", entityType: "PURCHASE" },
    select: { id: true, entityId: true, createdAt: true, actorId: true, meta: true },
  });

  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);
    const purchase = await prisma.purchase.findUnique({
      where: { id: row.entityId },
      select: {
        id: true,
        status: true,
        supplier: true,
        supplierId: true,
        productId: true,
        quantity: true,
        orderedQuantity: true,
        unitCost: true,
        approvedById: true,
        approvedAt: true,
      },
    });

    const approver = purchase?.approvedById
      ? await prisma.user.findUnique({
          where: { id: purchase.approvedById },
          select: { name: true, email: true },
        })
      : null;

    const qty = Number(purchase?.orderedQuantity ?? purchase?.quantity ?? 0);
    const unitCost = Number(purchase?.unitCost ?? 0);
    const next: Meta = {
      ...prev,
      previousStatus: prev.previousStatus ?? "PENDING_APPROVAL",
      status: prev.status ?? (purchase?.status || "APPROVED"),
      productId: prev.productId ?? purchase?.productId ?? null,
      quantity: prev.quantity ?? qty,
      unitCost: prev.unitCost ?? unitCost,
      amount: prev.amount ?? unitCost * qty,
      supplier: prev.supplier ?? purchase?.supplier ?? null,
      supplierId: prev.supplierId ?? purchase?.supplierId ?? null,
      approvedById: prev.approvedById ?? purchase?.approvedById ?? row.actorId ?? null,
      approvedByName:
        prev.approvedByName ?? approver?.name ?? approver?.email ?? null,
      approvedAt:
        prev.approvedAt ?? purchase?.approvedAt?.toISOString() ?? row.createdAt.toISOString(),
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

async function backfillAppSettingUpdate() {
  const rows = await prisma.auditLog.findMany({
    where: { action: "app-setting.update", entityType: "AppSetting" },
    select: { id: true, entityId: true, createdAt: true, meta: true },
  });

  let updated = 0;
  for (const row of rows) {
    const prev = parseMeta(row.meta);
    const setting = await prisma.appSetting.findUnique({
      where: { key: row.entityId },
      select: { value: true },
    });
    const currentValue = setting?.value ?? null;
    const currentValueText = currentValue === null ? null : JSON.stringify(currentValue);
    const currentType =
      currentValue === null
        ? "NULL"
        : Array.isArray(currentValue)
        ? "ARRAY"
        : typeof currentValue;
    const isSensitive = /secret|token|password|api[_-]?key|private/i.test(row.entityId);

    const next: Meta = {
      ...prev,
      key: prev.key ?? row.entityId,
      changed: prev.changed ?? null,
      previousType: prev.previousType ?? "UNKNOWN",
      newType: prev.newType ?? currentType,
      previousValuePreview: prev.previousValuePreview ?? "[unknown_legacy]",
      newValuePreview: prev.newValuePreview ?? (isSensitive ? "[hidden]" : currentValueText),
      isSensitive: prev.isSensitive ?? isSensitive,
      backfillVersion: 1,
      backfilledAt: new Date().toISOString(),
      legacyNote: prev.legacyNote ?? "Historical setting update lacked before/after snapshot.",
    };

    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      await prisma.auditLog.update({ where: { id: row.id }, data: { meta: JSON.stringify(next) } });
      updated += 1;
    }
  }
  return { total: rows.length, updated };
}

async function main() {
  const p = await backfillPurchaseApprove();
  const a = await backfillAppSettingUpdate();
  console.log(`PURCHASE_APPROVE backfill: ${p.updated}/${p.total}`);
  console.log(`app-setting.update backfill: ${a.updated}/${a.total}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
