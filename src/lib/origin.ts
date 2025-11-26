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
    const originHeader = req.headers.get("origin") || "";
    const refererHeader = req.headers.get("referer") || "";
    const reqUrlOrigin = safeOrigin(req.url, process.env.NEXTAUTH_URL || "http://localhost");
    const envOrigin = getAllowedOriginFromEnv(req.url);
    const hostHeader = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    const forwardProto = req.headers.get("x-forwarded-proto");

    const protocolForHost =
      (forwardProto || "").replace(/:$/, "") ||
      (reqUrlOrigin ? new URL(reqUrlOrigin).protocol.replace(/:$/, "") : "");

    const inferredFromHost =
      hostHeader && protocolForHost ? `${protocolForHost}://${hostHeader}` : "";

    const allowedOrigins = [envOrigin, reqUrlOrigin, inferredFromHost].filter(Boolean);
    const allowedHosts = new Set(
      allowedOrigins
        .map((allowed) => safeHost(allowed))
        .filter(Boolean)
    );

    const origin = originHeader ? safeOrigin(originHeader) : "";
    const referer = refererHeader ? safeOrigin(refererHeader) : "";
    const originHost = originHeader ? safeHost(originHeader) : "";
    const refererHost = refererHeader ? safeHost(refererHeader) : "";
    const requestHost = reqUrlOrigin ? safeHost(reqUrlOrigin) : "";

    for (const allowed of allowedOrigins) {
      if (origin && origin === allowed) return true;
      if (referer && referer === allowed) return true;
    }

    if (originHost && allowedHosts.has(originHost)) return true;
    if (refererHost && allowedHosts.has(refererHost)) return true;

    // As a fallback, allow when no Origin/Referer headers are present but the
    // request itself already targets an allowed origin (typical for same-site
    // form posts or server actions).
    if (!origin && !referer && requestHost && allowedHosts.has(requestHost)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function safeHost(value?: string) {
  if (!value) return "";
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return "";
  }
}
