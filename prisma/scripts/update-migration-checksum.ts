import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error("Usage: tsx prisma/scripts/update-migration-checksum.ts <migration_name>");
    process.exit(1);
  }

  const filePath = path.join(process.cwd(), "prisma", "migrations", name, "migration.sql");
  const sql = readFileSync(filePath, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2`,
    checksum,
    name
  );

  if (updated === 0) {
    console.error(`No migration row found for ${name}`);
    process.exit(1);
  }

  console.log(`Updated checksum for ${name}: ${checksum}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
