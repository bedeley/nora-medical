import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.order.findMany({
    where: {
      customerType: "WALK_IN",
      userId: { not: null },
    },
    select: {
      id: true,
      walkInName: true,
      walkInPhone: true,
      user: {
        select: {
          name: true,
          phone: true,
        },
      },
    },
  });

  let scanned = 0;
  let updated = 0;

  for (const row of rows) {
    scanned += 1;
    const canonicalName = String(row.user?.name || "").trim();
    const canonicalPhone = String(row.user?.phone || "").trim();
    if (!canonicalName) continue;

    const currentName = String(row.walkInName || "").trim();
    const currentPhone = String(row.walkInPhone || "").trim();

    const nextName = canonicalName;
    const nextPhone = currentPhone || canonicalPhone || null;

    const shouldUpdateName = currentName !== nextName;
    const shouldUpdatePhone = (currentPhone || null) !== (nextPhone || null);
    if (!shouldUpdateName && !shouldUpdatePhone) continue;

    await prisma.order.update({
      where: { id: row.id },
      data: {
        walkInName: nextName,
        walkInPhone: nextPhone,
      },
    });
    updated += 1;
  }

  console.log(JSON.stringify({ scanned, updated }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

