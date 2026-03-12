import { isLiveStage } from "@/lib/env";

export function getAllowedOriginFromEnv(fallback: string) {
  return safeOrigin(process.env.NEXT_PUBLIC_BASE_URL || fallback);
}

function safeOrigin(value?: string, base?: string) {
  if (!value && !base) return "";
  try {
    const url = base ? new URL(value || "", base) : new URL(value || "");
    return url.origin.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function assertSameOrigin(req: Request) {
  try {
    const method = (req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

    const originHeader = req.headers.get("origin") || "";
    const refererHeader = req.headers.get("referer") || "";

    const allowedOrigins = new Set(
      [
        safeOrigin(process.env.NEXT_PUBLIC_BASE_URL),
        safeOrigin(process.env.NEXTAUTH_URL),
      ].filter(Boolean)
    );

    const requestOrigin = safeOrigin(req.url, process.env.NEXTAUTH_URL || "http://localhost");
    if (!isLiveStage() && requestOrigin) {
      allowedOrigins.add(requestOrigin);
    }

    if (!allowedOrigins.size) return !isLiveStage();

    const origin = safeOrigin(originHeader);
    if (origin) return allowedOrigins.has(origin);

    const referer = safeOrigin(refererHeader);
    if (referer) return allowedOrigins.has(referer);

    // In live/prod, require Origin or Referer for unsafe methods.
    if (isLiveStage()) return false;

    // Non-live fallback for local testing where some clients omit both headers.
    return requestOrigin ? allowedOrigins.has(requestOrigin) : false;
  } catch {
    return false;
  }
}
