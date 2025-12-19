import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function logDatabaseTargetOnce() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const dbName = parsed.pathname.replace(/^\//, "") || "unknown";
    const stage = process.env.APP_STAGE || process.env.NODE_ENV || "unknown";
    // Log only host and database name, never credentials.
    // This helps quickly verify whether dev/prod processes
    // are pointed at the expected Neon branch.
    // Example output:
    // [Prisma] Using DB host ep-summer-pond-... db neondb (stage=development)
    // [Prisma] Using DB host ep-jolly-base-... db neondb (stage=production)
    // eslint-disable-next-line no-console
    console.log(
      `[Prisma] Using DB host ${host} db ${dbName} (stage=${stage})`,
    );
  } catch {
    // ignore malformed URLs
  }
}

export const prisma =
  globalForPrisma.prisma ||
  (() => {
    logDatabaseTargetOnce();
    return new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    });
  })();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
