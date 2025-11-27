import { PrismaClient as RuntimePrismaClient } from "@prisma/client";
import type { PrismaClient as GeneratedPrismaClient } from "@/generated/prisma";

type PrismaClient = GeneratedPrismaClient;

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  (new RuntimePrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  }) as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
