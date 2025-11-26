import { prisma } from "@/lib/prisma";

async function main() {
  const items = await prisma.orderItem.findMany({ select: { id: true, productId: true, costAtSale: true } });
  const toUpdate = items.filter((i) => i.costAtSale === null);
  for (const chunk of Array.from({ length: Math.ceil(toUpdate.length / 200) }, (_, i) => toUpdate.slice(i * 200, (i + 1) * 200))) {
    await Promise.all(
      chunk.map(async (it) => {
        const product = await prisma.product.findUnique({ where: { id: it.productId }, select: { cost: true } });
        const cost = product?.cost ? Number(product.cost) : 0;
        await prisma.orderItem.update({ where: { id: it.id }, data: { costAtSale: cost } });
      })
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
