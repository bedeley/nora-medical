import { timingSafeEqual } from "crypto";

/**
 * Timing-safe comparison of two secret strings.
 * Returns false if either is empty or lengths differ.
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token or x-cron-secret header from a request.
 */
function extractSecret(req: { headers: { get(name: string): string | null } }): string {
  const authHeader = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
  return bearer || headerSecret.trim();
}

/**
 * Timing-safe verification of cron job bearer tokens.
 * Prevents timing attacks on secret comparison.
 *
 * @param req - Request object (works with both Request and NextRequest)
 * @param envKey - Environment variable name for the secret (falls back to CRON_SECRET)
 */
export function verifyCronSecret(
  req: { headers: { get(name: string): string | null } },
  envKey: string = "CRON_SECRET",
): boolean {
  const configuredSecret = (process.env[envKey] || process.env.CRON_SECRET || "").trim();
  const providedSecret = extractSecret(req);
  return safeCompare(configuredSecret, providedSecret);
}

/**
 * Check if any of the given env keys match the provided cron secret.
 * Used in middleware where multiple cron secrets may be valid.
 */
export function verifyCronSecretAny(
  req: { headers: { get(name: string): string | null } },
  envKeys: string[],
): boolean {
  const providedSecret = extractSecret(req);
  if (!providedSecret) return false;
  return envKeys.some((key) => {
    const configured = (process.env[key] || "").trim();
    return safeCompare(configured, providedSecret);
  });
}
