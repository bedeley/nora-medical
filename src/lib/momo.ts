/**
 * Minimal Mobile Money (MoMo) integration helpers for Ghana.
 *
 * This module is provider-agnostic with a focus on MTN MoMo Collections.
 * The implementation favors safe fallbacks and clear error returns when
 * environment variables are not configured. No client-side calls are made
 * to provider APIs; only server-side requests from API routes.
 */

export type MomoProvider = "mtn" | "vodafone" | "airteltigo";

export type InitiateParams = {
  provider: MomoProvider;
  amount: number;
  phone: string; // MSISDN, allow "+233..." or local 0-prefixed
  externalId: string; // our internal payment id reference
  description?: string;
};

export type InitiateResult = { ok: true; reference: string } | { ok: false; error: string };

export function normalizePhoneGH(input: string) {
  let s = (input || "").trim();
  // Keep leading +; strip spaces and dashes
  s = s.replace(/[^\d+]/g, "");
  // Convert local 0XXXXXXXXX to +233XXXXXXXXX
  if (/^0\d{9}$/.test(s)) {
    return "+233" + s.slice(1);
  }
  // Already in +233...
  return s;
}

export function isValidPhone(input: string) {
  const p = normalizePhoneGH(input);
  return /^\+?\d{10,15}$/.test(p);
}

async function getMtnAccessToken(baseUrl: string, subscriptionKey: string, apiUser: string, apiKey: string) {
  const res = await fetch(`${baseUrl}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${apiUser}:${apiKey}`).toString("base64"),
      "Ocp-Apim-Subscription-Key": subscriptionKey,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Provide a clearer hint without leaking secrets
      throw new Error(
        "MTN token error 401: authentication failed. Verify MOMO_SUBSCRIPTION_KEY (Collections), MOMO_API_USER, MOMO_API_KEY, and MOMO_BASE_URL environment match the same environment (sandbox vs production)."
      );
    }
    throw new Error(`MTN token error ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string };
  return String(data?.access_token || "");
}

function toMsisdn(phone: string) {
  // Strip + and non-digits, keep leading country code if present
  return phone.replace(/[^\d]/g, "");
}

/**
 * Placeholder type and helper for future MoMo payouts (refunds) to customers.
 * This is intentionally minimal and is gated by an environment flag in the
 * calling route so it is effectively "off" until a real integration is wired.
 */
export type PayoutParams = {
  provider: MomoProvider;
  amount: number;
  phone: string;
  externalId: string;
  description?: string;
};

export async function initiateMomoPayout(
  params: PayoutParams,
): Promise<InitiateResult> {
  // This helper is a stub. When MOMO_PAYOUTS_ENABLED is set and a provider
  // payout API is available, replace this implementation with a real call.
  return {
    ok: false,
    error: `MoMo payout integration not configured for provider ${params.provider}`,
  };
}

/**
 * Initiates a request-to-pay with the provider.
 *
 * NOTE: This is a thin placeholder. In production, configure the provider
 * credentials and uncomment the actual HTTP calls.
 */
export async function initiateMomo(params: InitiateParams): Promise<InitiateResult> {
  const { provider, amount } = params;
  const phone = normalizePhoneGH(params.phone);
  if (!phone || !isValidPhone(phone)) {
    return { ok: false, error: "Invalid phone number" };
  }
  if (!(amount > 0)) return { ok: false, error: "Invalid amount" };

  // Environment-driven configuration for MTN MoMo
  const targetEnv = process.env.MOMO_TARGET_ENV || "sandbox"; // sandbox | production
  const subscriptionKey = process.env.MOMO_SUBSCRIPTION_KEY || ""; // Ocp-Apim-Subscription-Key
  const apiUser = process.env.MOMO_API_USER || ""; // UUID created with provider
  const apiKey = process.env.MOMO_API_KEY || ""; // API key for token creation
  const baseUrl = process.env.MOMO_BASE_URL || "https://sandbox.momodeveloper.mtn.com";

  // Treat obvious placeholder values as not configured in dev
  const looksUnconfigured = (s: string) => {
    const v = (s || "").trim();
    const lower = v.toLowerCase();
    return (
      !v ||
      lower.startsWith("your_") ||
      lower.includes("xxxxx") ||
      lower.includes("replace-") ||
      lower.includes("choose-") ||
      v === "your_mtn_subscription_key" ||
      v === "your_mtn_api_user_uuid" ||
      v === "your_mtn_api_key"
    );
  };

  const missingCreds = looksUnconfigured(subscriptionKey) || looksUnconfigured(apiUser) || looksUnconfigured(apiKey);

  // If not configured and we're in a non-live stage, return mock success to allow local testing without provider
  if (missingCreds && !isLiveStage()) {
    return { ok: true, reference: `TEST-${params.externalId}` };
  }

  if (missingCreds && isLiveStage()) {
    return { ok: false, error: "MoMo not configured for production" };
  }

  try {
    if (provider === "mtn") {
      const accessToken = await getMtnAccessToken(baseUrl, subscriptionKey, apiUser, apiKey);
      const xReferenceId =
        typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : nodeRandomUUID();
      const res = await fetch(`${baseUrl}/collection/v1_0/requesttopay`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Target-Environment": targetEnv,
          "Ocp-Apim-Subscription-Key": subscriptionKey,
          "X-Reference-Id": xReferenceId,
        },
        body: JSON.stringify({
          amount: amount.toFixed(2),
          currency: "EUR",
          externalId: params.externalId,
          payer: { partyIdType: "MSISDN", partyId: toMsisdn(phone) },
          payerMessage: params.description || "Payment",
          payeeNote: params.description || "Noralls Medical Supplies",
        }),
      });
      if (!res.ok && res.status !== 202) {
        const details = await res
          .text()
          .then((txt) => txt?.slice(0, 500) || "")
          .catch(() => "");
        console.error("MoMo requesttopay error", res.status, details);
        throw new Error(`MoMo init failed ${res.status}${details ? `: ${details}` : ""}`);
      }
      return { ok: true, reference: xReferenceId };
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      return { ok: false, error: e.message || "MoMo init error" };
    }
    return { ok: false, error: "MoMo init error" };
  }

  return { ok: false, error: "Unsupported provider" };
}

/**
 * Validates provider callback. In production, verify signatures/headers.
 * Returns { valid: true, externalId, status, amount }
 */
type MomoCallbackBody = {
  externalId?: string;
  reference?: string;
  status?: string;
  statusCode?: string;
  amount?: number | string;
};

export function parseMomoCallbackBody(rawBody: string): {
  valid: boolean;
  externalId?: string;
  status?: string; // SUCCESSFUL | FAILED | TIMEOUT | PENDING
  amount?: number;
} {
  try {
    const body = JSON.parse(rawBody) as MomoCallbackBody;
    const externalId = String(body?.externalId || body?.reference || "");
    const status = String(body?.status || body?.statusCode || "");
    const amount = Number(body?.amount || 0) || undefined;
    if (!externalId || !status) return { valid: false };
    return { valid: true, externalId, status, amount };
  } catch {
    return { valid: false };
  }
}

export async function parseMomoCallback(req: Request): Promise<{
  valid: boolean;
  externalId?: string;
  status?: string;
  amount?: number;
}> {
  const text = await req.text();
  return parseMomoCallbackBody(text);
}

type MomoStatusResult =
  | { ok: true; status: string; raw?: unknown }
  | { ok: false; error: string };

export async function getMomoStatus(provider: MomoProvider, reference: string): Promise<MomoStatusResult> {
  const targetEnv = process.env.MOMO_TARGET_ENV || "sandbox";
  const subscriptionKey = process.env.MOMO_SUBSCRIPTION_KEY || "";
  const apiUser = process.env.MOMO_API_USER || "";
  const apiKey = process.env.MOMO_API_KEY || "";
  const baseUrl = process.env.MOMO_BASE_URL || "https://sandbox.momodeveloper.mtn.com";
  if (!subscriptionKey || !apiUser || !apiKey) return { ok: true, status: "PENDING" };
  if (provider !== "mtn") return { ok: false, error: "Unsupported provider" };
  try {
    const token = await getMtnAccessToken(baseUrl, subscriptionKey, apiUser, apiKey);
    const res = await fetch(`${baseUrl}/collection/v1_0/requesttopay/${reference}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Ocp-Apim-Subscription-Key": subscriptionKey,
        "X-Target-Environment": targetEnv,
      },
    });
    if (!res.ok) throw new Error(`Status error ${res.status}`);
    const data = (await res.json()) as { status?: string };
    // data.status expected: PENDING | SUCCESSFUL | FAILED
    return { ok: true, status: String(data?.status || "PENDING").toUpperCase(), raw: data };
  } catch (e: unknown) {
    if (e instanceof Error) {
      return { ok: false, error: e.message || "Status check error" };
    }
    return { ok: false, error: "Status check error" };
  }
}
import { randomUUID as nodeRandomUUID, createHmac, timingSafeEqual } from "crypto";

export function verifyMomoSignature(rawBody: string, headers: Headers): boolean {
  const secret = (process.env.MOMO_WEBHOOK_SECRET || "").trim();
  const headerName = (process.env.MOMO_WEBHOOK_SIGNATURE_HEADER || "x-momo-signature").toLowerCase();
  if (!secret) {
    // No secret configured: accept callback but log that verification is off.
    return true;
  }

  let signature =
    headers.get(headerName) ||
    headers.get(headerName.toUpperCase()) ||
    headers.get(headerName.replace(/^x-/, "X-"));
  if (!signature) {
    console.warn("MoMo callback: missing signature header", headerName);
    return false;
  }
  signature = signature.trim();

  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody, "utf8");
  const computed = hmac.digest("hex");

  const sigBuf = Buffer.from(signature, "utf8");
  const compBuf = Buffer.from(computed, "utf8");
  if (sigBuf.length !== compBuf.length) return false;
  return timingSafeEqual(sigBuf, compBuf);
}
import { isLiveStage } from "@/lib/env";
