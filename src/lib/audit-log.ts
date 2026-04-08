import { prisma } from "@/lib/prisma";

type AuditMeta = Record<string, unknown>;
type AuditOutcome = "SUCCESS" | "FAILED" | "PARTIAL";

function readHeader(source: unknown, name: string): string | null {
  if (!source || typeof source !== "object") return null;
  const headers = source as {
    get?: (key: string) => string | null | undefined;
    [key: string]: unknown;
  };
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const direct = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (Array.isArray(direct) && typeof direct[0] === "string" && direct[0].trim()) {
    return direct[0].trim();
  }
  return null;
}

function buildRequestAuditContext(request: unknown) {
  if (!request || typeof request !== "object") {
    return {
      ipAddress: null,
      userAgent: null,
      requestId: null,
    };
  }
  const source = request as { headers?: unknown };
  const xForwardedFor = readHeader(source.headers, "x-forwarded-for");
  const ipAddress =
    xForwardedFor?.split(",")[0]?.trim() ||
    readHeader(source.headers, "x-real-ip") ||
    readHeader(source.headers, "cf-connecting-ip") ||
    null;
  const userAgent = readHeader(source.headers, "user-agent");
  const requestId =
    readHeader(source.headers, "x-request-id") ||
    readHeader(source.headers, "x-correlation-id") ||
    readHeader(source.headers, "x-trace-id") ||
    null;
  return {
    ipAddress,
    userAgent,
    requestId,
  };
}

export async function recordAuditLog(params: {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  meta?: AuditMeta;
  request?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  outcome?: AuditOutcome | null;
}) {
  const { actorId, action, entityType, entityId, meta, request, outcome } = params;
  const requestContext = buildRequestAuditContext(request);
  try {
    await prisma.auditLog.create({
      data: {
        actorId: actorId || null,
        action,
        entityType,
        entityId,
        meta: meta ? JSON.stringify(meta) : null,
        ipAddress: params.ipAddress ?? requestContext.ipAddress,
        userAgent: params.userAgent ?? requestContext.userAgent,
        requestId: params.requestId ?? requestContext.requestId,
        outcome: outcome || null,
      },
    });
  } catch (e) {
    console.warn("auditLog error:", e);
  }
}
