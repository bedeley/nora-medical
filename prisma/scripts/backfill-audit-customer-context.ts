import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGET_ACTIONS = [
  "ORDER_CREATE_ADMIN",
  "ORDER_CREATE",
  "PAYMENT_CREATE",
  "PAYMENT_SUCCESS",
  "PAYMENT_FAILED",
  "PAYMENT_PROVIDER_CALLBACK",
  "PAYMENT_REFUND",
  "PAYMENT_VOID",
] as const;

type Meta = Record<string, unknown>;

function parseMeta(raw: string | null): Meta | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    return null;
  }
  return null;
}

function hasCustomerIdentity(meta: Meta): boolean {
  return Boolean(String(meta.customerName || "").trim());
}

async function resolveCustomerId(
  meta: Meta,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const directId =
    String(meta.customerId || "").trim() ||
    String(meta.userId || "").trim();
  if (directId) return directId;

  if (entityType === "ORDER") {
    const order = await prisma.order.findUnique({
      where: { id: entityId },
      select: { userId: true },
    });
    return order?.userId || null;
  }
  if (entityType === "PAYMENT") {
    const payment = await prisma.payment.findUnique({
      where: { id: entityId },
      select: { userId: true },
    });
    return payment?.userId || null;
  }
  return null;
}

async function main() {
  let cursor: string | null = null;
  let scanned = 0;
  let updated = 0;
  const userCache = new Map<string, { name: string | null; email: string | null; phone: string | null }>();

  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: {
        action: { in: [...TARGET_ACTIONS] },
        meta: { not: null },
      },
      orderBy: { id: "asc" },
      take: 300,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        meta: true,
        entityType: true,
        entityId: true,
      },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      const meta = parseMeta(row.meta);
      if (!meta) continue;
      if (hasCustomerIdentity(meta)) continue;

      const customerId = await resolveCustomerId(meta, row.entityType, row.entityId);
      if (!customerId) continue;

      let customer = userCache.get(customerId);
      if (!customer) {
        const user = await prisma.user.findUnique({
          where: { id: customerId },
          select: { name: true, email: true, phone: true },
        });
        customer = {
          name: user?.name || null,
          email: user?.email || null,
          phone: user?.phone || null,
        };
        userCache.set(customerId, customer);
      }

      const nextMeta: Meta = {
        ...meta,
        customerId: String(meta.customerId || customerId),
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
      };

      await prisma.auditLog.update({
        where: { id: row.id },
        data: { meta: JSON.stringify(nextMeta) },
      });
      updated += 1;
    }

    cursor = rows[rows.length - 1]?.id || null;
  }

  console.log(
    JSON.stringify({
      scanned,
      updated,
      actions: TARGET_ACTIONS,
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

