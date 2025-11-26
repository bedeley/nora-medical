import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Removing all user accounts and related data...");

  await prisma.$transaction([
    // Order-dependent deletes
    prisma.orderItem.deleteMany({}),
    prisma.payment.deleteMany({}),
    prisma.order.deleteMany({}),

    // Carts
    prisma.cartItem.deleteMany({}),
    prisma.cart.deleteMany({}),

    // Balances
    prisma.balance.deleteMany({}),

    // OTPs
    prisma.userOtp.deleteMany({}),

    // Sessions and OAuth accounts (NextAuth)
    prisma.session.deleteMany({}),
    prisma.account.deleteMany({}),

    // Finally, users
    prisma.user.deleteMany({}),
  ]);

  const [users, orders, carts, balances] = await Promise.all([
    prisma.user.count(),
    prisma.order.count(),
    prisma.cart.count(),
    prisma.balance.count(),
  ]);

  console.log("Remaining counts:");
  console.log({ users, orders, carts, balances });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
