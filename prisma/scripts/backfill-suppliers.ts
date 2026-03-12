import { prisma } from "@/lib/prisma";

async function main() {
  const unknownName = "Unknown";
  const unknown = await prisma.supplier.upsert({
    where: { name: unknownName },
    create: { name: unknownName },
    update: {},
    select: { id: true, name: true },
  });

  const products = await prisma.product.findMany({
    select: { id: true, supplier: true, supplierId: true },
  });

  const nameToId = new Map<string, string>();

  for (const product of products) {
    const rawName = String(product.supplier || "").trim();
    if (!rawName || product.supplierId) continue;
    const key = rawName.toLowerCase();
    if (nameToId.has(key)) continue;
    const existing = await prisma.supplier.findFirst({
      where: { name: { equals: rawName, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (existing) {
      nameToId.set(key, existing.id);
      continue;
    }
    const created = await prisma.supplier.create({
      data: { name: rawName },
      select: { id: true },
    });
    nameToId.set(key, created.id);
  }

  let updated = 0;
  for (const product of products) {
    if (product.supplierId) continue;
    const rawName = String(product.supplier || "").trim();
    if (rawName) {
      const supplierId = nameToId.get(rawName.toLowerCase());
      if (supplierId) {
        await prisma.product.update({
          where: { id: product.id },
          data: { supplierId, supplier: rawName },
        });
        updated += 1;
        continue;
      }
    }
    await prisma.product.update({
      where: { id: product.id },
      data: { supplierId: unknown.id, supplier: unknown.name },
    });
    updated += 1;
  }

  console.log(`Backfilled suppliers for ${updated} products.`);
}

main()
  .catch((err) => {
    console.error("Backfill suppliers failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
