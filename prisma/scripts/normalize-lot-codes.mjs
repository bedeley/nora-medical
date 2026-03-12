import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const normalizeLotCode = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .toUpperCase();

function pickEarliestDate(values) {
  const dates = values.filter((d) => d instanceof Date);
  if (!dates.length) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime())));
}

async function main() {
  const lots = await prisma.inventoryLot.findMany({
    orderBy: [{ productId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      productId: true,
      lotCode: true,
      expiryDate: true,
      receivedAt: true,
      quantityReceived: true,
      quantityRemaining: true,
      notes: true,
      purchaseId: true,
      supplierId: true,
      createdAt: true,
    },
  });

  const groups = new Map();
  for (const lot of lots) {
    const normalized = normalizeLotCode(lot.lotCode);
    const key = `${lot.productId}::${normalized}`;
    const list = groups.get(key) || [];
    list.push(lot);
    groups.set(key, list);
  }

  let updated = 0;
  let merged = 0;
  let deleted = 0;

  await prisma.$transaction(async (tx) => {
    for (const [key, list] of groups.entries()) {
      const [productId, normalized] = key.split("::");
      if (!productId || !normalized) continue;

      const sorted = [...list].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const keeper = sorted[0];
      const duplicates = sorted.slice(1);

      const totalReceived = sorted.reduce(
        (sum, row) => sum + Number(row.quantityReceived || 0),
        0,
      );
      const totalRemaining = sorted.reduce(
        (sum, row) => sum + Number(row.quantityRemaining || 0),
        0,
      );
      const expiryDate = pickEarliestDate(sorted.map((row) => row.expiryDate));
      const receivedAt =
        pickEarliestDate(sorted.map((row) => row.receivedAt)) || keeper.receivedAt;
      const noteParts = Array.from(
        new Set(
          sorted
            .map((row) => String(row.notes || "").trim())
            .filter(Boolean),
        ),
      );
      const notes = noteParts.length ? noteParts.join(" | ") : null;
      const purchaseId =
        keeper.purchaseId || sorted.find((row) => row.purchaseId)?.purchaseId || null;
      const supplierId =
        keeper.supplierId || sorted.find((row) => row.supplierId)?.supplierId || null;

      const needsKeeperUpdate =
        keeper.lotCode !== normalized ||
        Number(keeper.quantityReceived || 0) !== totalReceived ||
        Number(keeper.quantityRemaining || 0) !== totalRemaining ||
        (keeper.expiryDate?.getTime() || 0) !== (expiryDate?.getTime() || 0) ||
        (keeper.receivedAt?.getTime() || 0) !== (receivedAt?.getTime() || 0) ||
        String(keeper.notes || "") !== String(notes || "") ||
        String(keeper.purchaseId || "") !== String(purchaseId || "") ||
        String(keeper.supplierId || "") !== String(supplierId || "");

      if (needsKeeperUpdate) {
        await tx.inventoryLot.update({
          where: { id: keeper.id },
          data: {
            lotCode: normalized,
            quantityReceived: totalReceived,
            quantityRemaining: totalRemaining,
            expiryDate,
            receivedAt,
            notes,
            purchaseId,
            supplierId,
          },
        });
        updated += 1;
      }

      for (const dup of duplicates) {
        await tx.inventoryMovement.updateMany({
          where: { lotId: dup.id },
          data: { lotId: keeper.id },
        });
        await tx.inventoryLot.delete({ where: { id: dup.id } });
        merged += 1;
        deleted += 1;
      }
    }
  });

  console.log(
    JSON.stringify({
      totalLots: lots.length,
      normalizedGroups: groups.size,
      updated,
      merged,
      deleted,
    }),
  );
}

main()
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  })
  .then(async () => {
    await prisma.$disconnect();
  });

