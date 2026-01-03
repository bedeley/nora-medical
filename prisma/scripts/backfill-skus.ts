import { PrismaClient } from "@prisma/client";
import { formatSku, normalizeSkuPrefix, parseSkuNumber } from "@/lib/sku";

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({
    where: { sku: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let updated = 0;
  let skipped = 0;
  const prefixCounters = new Map<string, number>();

  for (const product of products) {
    const prefix = normalizeSkuPrefix(product.name, 3);
    if (!prefixCounters.has(prefix)) {
      const existingSkus = await prisma.product.findMany({
        where: { sku: { startsWith: `${prefix}-`, mode: "insensitive" } },
        select: { sku: true },
      });
      const maxSuffix = existingSkus.reduce((max, row) => {
        const parsed = parseSkuNumber(prefix, row.sku);
        if (parsed == null) return max;
        return Math.max(max, parsed);
      }, 0);
      prefixCounters.set(prefix, maxSuffix);
    }

    const next = (prefixCounters.get(prefix) || 0) + 1;
    const sku = formatSku(prefix, next, 3);
    try {
      await prisma.product.update({
        where: { id: product.id },
        data: { sku },
      });
      prefixCounters.set(prefix, next);
      updated += 1;
    } catch {
      skipped += 1;
    }
  }

  console.log(`Backfilled ${updated} product(s). Skipped ${skipped} (no SKU candidate).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
