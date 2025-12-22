import { isLiveStage } from "@/lib/env";

const textEncoder = new TextEncoder();

function getSecret() {
  return (
    process.env.MFA_COOKIE_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    ""
  ).trim();
}

function base64urlFromBytes(bytes: Uint8Array) {
  let base64: string;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(bytes).toString("base64");
  } else {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    base64 = btoa(binary);
  }

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromString(value: string) {
  return textEncoder.encode(value);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytesFromString(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, bytesFromString(value));
  return base64urlFromBytes(new Uint8Array(signature));
}

export async function signMfaCookie(userId: string, expiresAtMs: number) {
  const secret = getSecret();
  if (!secret) return null;
  const exp = Math.floor(expiresAtMs / 1000);
  const payload = `${userId}.${exp}`;
  const sig = await hmac(payload, secret);
  return `v1.${userId}.${exp}.${sig}`;
}

export async function verifyMfaCookie(value: string, expectedUserId: string) {
  const secret = getSecret();
  if (!secret) return !isLiveStage();
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const [, userId, expRaw, sig] = parts;
  if (!userId || !expRaw || !sig) return false;
  if (userId !== expectedUserId) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return false;
  const payload = `${userId}.${exp}`;
  const expectedSig = await hmac(payload, secret);
  const sigBytes = bytesFromString(sig);
  const expectedBytes = bytesFromString(expectedSig);
  return timingSafeEqualBytes(sigBytes, expectedBytes);
}
