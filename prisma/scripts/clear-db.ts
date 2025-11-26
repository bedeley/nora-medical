import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Clearing all data from the database...");

  await prisma.$transaction([
    prisma.inventoryMovement.deleteMany({}),
    prisma.purchase.deleteMany({}),
    prisma.orderItem.deleteMany({}),
    prisma.payment.deleteMany({}),
    prisma.order.deleteMany({}),
    prisma.cartItem.deleteMany({}),
    prisma.cart.deleteMany({}),
    prisma.balance.deleteMany({}),
    prisma.expense.deleteMany({}),
    prisma.account.deleteMany({}),
    prisma.session.deleteMany({}),
    prisma.product.deleteMany({}),
    prisma.user.deleteMany({}),
  ]);

  const [users, products, purchases, movements, orders, payments, carts, expenses] = await Promise.all([
    prisma.user.count(),
    prisma.product.count(),
    prisma.purchase.count(),
    prisma.inventoryMovement.count(),
    prisma.order.count(),
    prisma.payment.count(),
    prisma.cart.count(),
    prisma.expense.count(),
  ]);

  console.log("Remaining counts:");
  console.log({ users, products, purchases, movements, orders, payments, carts, expenses });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

