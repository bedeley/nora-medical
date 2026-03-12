import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const dispatchers = [
  {
    name: "Kwame Yeboah",
    email: "dispatcher.kwame@noralls.test",
    phone: "0241110001",
    password: "Dispatch#2026A",
  },
  {
    name: "Akosua Mensah",
    email: "dispatcher.akosua@noralls.test",
    phone: "0241110002",
    password: "Dispatch#2026B",
  },
];

async function main() {
  for (const entry of dispatchers) {
    const hashed = await bcrypt.hash(entry.password, 10);
    await prisma.user.upsert({
      where: { email: entry.email },
      update: {
        name: entry.name,
        phone: entry.phone,
        role: "DISPATCHER",
        archived: false,
        password: hashed,
      },
      create: {
        name: entry.name,
        email: entry.email,
        phone: entry.phone,
        role: "DISPATCHER",
        password: hashed,
      },
    });
  }

  console.log("Seeded 2 dispatcher users:");
  for (const entry of dispatchers) {
    console.log(`- ${entry.name} | ${entry.email} | ${entry.phone}`);
  }
}

main()
  .catch((error) => {
    console.error("Failed seeding dispatchers:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

