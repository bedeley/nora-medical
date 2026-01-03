import { PrismaClient } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";

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
    type MiddlewareParams = {
      model?: string;
      action: string;
      args?: Record<string, unknown>;
    };
    type MiddlewareNext = (params: MiddlewareParams) => Promise<unknown>;
    type PrismaClientWithMiddleware = PrismaClient & {
      $use?: (middleware: (params: MiddlewareParams, next: MiddlewareNext) => Promise<unknown>) => void;
    };
    const client = new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "error", "warn"]
          : ["error"],
    }) as PrismaClientWithMiddleware;
    const slowQueryMs = Number(process.env.SENTRY_SLOW_QUERY_MS || 500);
    if (Number.isFinite(slowQueryMs) && slowQueryMs > 0 && typeof client.$use === "function") {
      client.$use(async (params, next) => {
        const start = Date.now();
        const result = await next(params);
        const duration = Date.now() - start;
        if (duration >= slowQueryMs && process.env.SENTRY_DSN) {
          Sentry.withScope((scope) => {
            scope.setLevel("warning");
            scope.setTag("db.slow_query", "true");
            scope.setTag("db.model", params.model || "raw");
            scope.setTag("db.action", params.action || "unknown");
            scope.setExtra("durationMs", duration);
            Sentry.captureMessage("Slow database query");
          });
        }
        return result;
      });
    }
    if (typeof client.$use === "function") {
      const softDeleteModels = new Set([
        "User",
        "Product",
        "Order",
        "Expense",
        "Purchase",
        "InventoryMovement",
        "Payment",
        "StockAlert",
        "AuditLog",
      ]);
      const filteredActions = new Set([
        "findMany",
        "findFirst",
        "findUnique",
        "findFirstOrThrow",
        "findUniqueOrThrow",
        "count",
        "aggregate",
        "groupBy",
      ]);
      client.$use(async (params, next) => {
        if (!params.model || !softDeleteModels.has(params.model)) {
          return next(params);
        }
        if (!filteredActions.has(params.action)) {
          return next(params);
        }
        params.args ??= {};
        const args = params.args as { where?: Record<string, unknown> };
        args.where ??= {};
        const where = args.where as Record<string, unknown>;
        if (where.deletedAt === undefined) {
          where.deletedAt = null;
        }
        if (params.action === "findUnique") {
          params.action = "findFirst";
        } else if (params.action === "findUniqueOrThrow") {
          params.action = "findFirstOrThrow";
        }
        return next(params);
      });
    }
    return client;
  })();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
