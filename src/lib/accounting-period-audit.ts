import { createHash, randomUUID } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function normalizeForHash(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForHash(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = normalizeForHash(source[key]);
    }
    return out;
  }
  return String(value);
}

export function hashAuditState(value: unknown) {
  const normalized = normalizeForHash(value);
  const payload = JSON.stringify(normalized);
  return createHash("sha256").update(payload).digest("hex");
}

export function extractAuditTrace(req: Request) {
  const requestId = (req.headers.get("x-request-id") || "").trim() || null;
  const correlationId = (req.headers.get("x-correlation-id") || "").trim() || null;
  const upstreamTraceId = (req.headers.get("x-trace-id") || "").trim() || null;
  const traceId = upstreamTraceId || correlationId || requestId || randomUUID();
  return {
    traceId,
    requestId,
    correlationId,
    requestPath: new URL(req.url).pathname,
    requestMethod: req.method.toUpperCase(),
  };
}

