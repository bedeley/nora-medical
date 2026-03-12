import { prisma } from "@/lib/prisma";

const SYSTEM_SUPPLIERS = new Map<string, string>([
  ["initial stock", "Initial Stock"],
  ["initial order", "Initial Order"],
]);
const SKIP_NAMES = new Set(["unknown"]);

async function main() {
  const purchases = await prisma.purchase.findMany({
    select: {
      id: true,
      supplierId: true,
      supplier: true,
      product: { select: { supplierId: true, supplier: true } },
    },
  });

  let linked = 0;
  for (const purchase of purchases) {
    if (purchase.supplierId) continue;
    const name = purchase.supplier?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (SKIP_NAMES.has(key)) continue;

    let supplier = null;
    if (SYSTEM_SUPPLIERS.has(key)) {
      const productSupplierId = purchase.product?.supplierId || null;
      const productSupplierName = purchase.product?.supplier?.trim() || "";
      if (productSupplierId || productSupplierName) {
        supplier = productSupplierId
          ? await prisma.supplier.findUnique({
              where: { id: productSupplierId },
              select: { id: true, name: true },
            })
          : await prisma.supplier.findFirst({
              where: { name: { equals: productSupplierName, mode: "insensitive" } },
              select: { id: true, name: true },
            });
      }
      if (!supplier) {
        const canonicalName = SYSTEM_SUPPLIERS.get(key) as string;
        supplier = await prisma.supplier.upsert({
          where: { name: canonicalName },
          update: {},
          create: { name: canonicalName, status: "ACTIVE" },
          select: { id: true, name: true },
        });
      }
    } else {
      supplier = await prisma.supplier.findFirst({
        where: { name: { equals: name, mode: "insensitive" } },
        select: { id: true, name: true },
      });
    }
    if (!supplier) continue;

    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { supplierId: supplier.id, supplier: supplier.name },
    });
    linked += 1;
  }

  console.log(`Linked ${linked} purchases to suppliers.`);
}

main()
  .catch((err) => {
    console.error("Backfill purchase suppliers failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
