import { isLiveStage } from "@/lib/env";

type Counter = { count: number; resetAt: number };
const buckets = new Map<string, Counter>();
const failureBuckets = new Map<string, Counter>();

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

type HeadersLike = {
  get?: (name: string) => string | null | undefined;
  [key: string]: unknown;
};

function readHeader(req: unknown, name: string) {
  if (!req) return "";
  const headers = (req as { headers?: HeadersLike }).headers;
  if (!headers) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || "";
  }
  if (typeof headers === "object") {
    const raw = headers[name] || headers[name.toLowerCase()];
    return typeof raw === "string" ? raw : "";
  }
  return "";
}

function getClientIp(req: unknown) {
  const ip = (readHeader(req, "x-forwarded-for") || readHeader(req, "x-real-ip") || "")
    .split(",")[0]
    .trim() || "0.0.0.0";
  return ip;
}

function getKey(req: Request, name: string) {
  return `${name}:${getClientIp(req)}`;
}

async function redisCommand<T = unknown>(cmd: string, args: Array<string | number>): Promise<T | undefined> {
  if (!redisUrl || !redisToken) return undefined;
  try {
    const res = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cmd, args }),
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { result?: T };
    return data?.result;
  } catch {
    return undefined;
  }
}

async function redisRateLimit(key: string, windowMs: number, max: number) {
  // Sliding window: reset TTL on each hit; acceptable for our use-case.
  const count = await redisCommand<number>("INCR", [key]);
  if (typeof count !== "number") return undefined;

  // Set expiry when first seen (NX so we don't extend indefinitely)
  await redisCommand("PEXPIRE", [key, windowMs, "NX"]);

  const ttlMs = await redisCommand<number>("PTTL", [key]);
  const retryIn = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : windowMs;

  if (count > max) {
    return { ok: false as const, retryIn };
  }
  return { ok: true as const, remaining: max - count };
}

function memoryRateLimit(key: string, windowMs: number, max: number) {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || cur.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true as const, remaining: max - 1 };
  }
  if (cur.count >= max) {
    return { ok: false as const, retryIn: cur.resetAt - now };
  }
  cur.count += 1;
  return { ok: true as const, remaining: max - cur.count };
}

export async function rateLimit(req: Request, bucketName: string, windowMs = 60_000, max = 30) {
  const key = getKey(req, bucketName);

  // Prefer shared store when configured (Vercel KV/Upstash); fall back to memory.
  const remote = await redisRateLimit(key, windowMs, max);
  if (remote) return remote;

  if (isLiveStage()) {
    // In live/prod, we require a shared store so throttling actually holds across instances.
    console.warn("[rate-limit] Shared store not configured; blocking request", { bucket: bucketName });
    return { ok: false as const, retryIn: windowMs } as const;
  }

  if (!redisUrl || !redisToken) {
    console.warn("[rate-limit] Using in-memory limiter (non-live stage)", { bucket: bucketName });
  }

  return memoryRateLimit(key, windowMs, max);
}

type LockoutResult = { locked: true; retryIn: number } | { locked: false };

function memoryFailureStatus(key: string, windowMs: number, max: number): LockoutResult {
  const now = Date.now();
  const cur = failureBuckets.get(key);
  if (!cur || cur.resetAt <= now) {
    if (cur) failureBuckets.delete(key);
    return { locked: false };
  }
  if (cur.count >= max) {
    return { locked: true, retryIn: Math.max(0, cur.resetAt - now) };
  }
  return { locked: false };
}

function memoryFailureHit(key: string, windowMs: number) {
  const now = Date.now();
  const cur = failureBuckets.get(key);
  if (!cur || cur.resetAt <= now) {
    failureBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  cur.count += 1;
}

async function redisGetCount(key: string): Promise<{ count: number; ttlMs: number } | undefined> {
  const countRaw = await redisCommand<string>("GET", [key]);
  if (countRaw === undefined || countRaw === null) return undefined;
  const count = Number(countRaw);
  if (!Number.isFinite(count)) return undefined;
  const ttlMs = await redisCommand<number>("PTTL", [key]);
  return { count, ttlMs: typeof ttlMs === "number" ? ttlMs : 0 };
}

async function redisFailureStatus(key: string, windowMs: number, max: number): Promise<LockoutResult | undefined> {
  const data = await redisGetCount(key);
  if (!data) return undefined;
  if (data.count >= max) {
    const retryIn = data.ttlMs > 0 ? data.ttlMs : windowMs;
    return { locked: true, retryIn };
  }
  return { locked: false };
}

async function redisFailureHit(key: string, windowMs: number) {
  const count = await redisCommand<number>("INCR", [key]);
  if (typeof count !== "number") return false;
  await redisCommand("PEXPIRE", [key, windowMs, "NX"]);
  return true;
}

async function redisFailureClear(key: string) {
  await redisCommand("DEL", [key]);
}

function getLockoutConfig() {
  const windowMs = Math.max(60_000, Number(process.env.LOGIN_LOCKOUT_WINDOW_MS || 900_000));
  const maxAttempts = Math.max(3, Number(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS || 5));
  const maxIpAttempts = Math.max(10, Number(process.env.LOGIN_LOCKOUT_IP_MAX_ATTEMPTS || 20));
  return { windowMs, maxAttempts, maxIpAttempts };
}

export async function checkLoginLockout(req: Request, identifier: string): Promise<LockoutResult> {
  const { windowMs, maxAttempts, maxIpAttempts } = getLockoutConfig();
  const ip = getClientIp(req);
  const idKey = `login-fail-id:${identifier.toLowerCase()}`;
  const ipKey = `login-fail-ip:${ip}`;

  const redisId = await redisFailureStatus(idKey, windowMs, maxAttempts);
  const redisIp = await redisFailureStatus(ipKey, windowMs, maxIpAttempts);
  if (redisId) {
    if (redisId.locked) return redisId;
  }
  if (redisIp) {
    if (redisIp.locked) return redisIp;
  }

  const memId = memoryFailureStatus(idKey, windowMs, maxAttempts);
  if (memId.locked) return memId;
  const memIp = memoryFailureStatus(ipKey, windowMs, maxIpAttempts);
  if (memIp.locked) return memIp;
  return { locked: false };
}

export async function recordLoginFailure(req: Request, identifier: string) {
  const { windowMs } = getLockoutConfig();
  const ip = getClientIp(req);
  const idKey = `login-fail-id:${identifier.toLowerCase()}`;
  const ipKey = `login-fail-ip:${ip}`;

  const redisOkId = await redisFailureHit(idKey, windowMs);
  const redisOkIp = await redisFailureHit(ipKey, windowMs);

  if (!redisOkId || !redisOkIp) {
    if (isLiveStage()) {
      console.warn("[rate-limit] Login lockout using in-memory fallback (shared store missing)");
    }
    memoryFailureHit(idKey, windowMs);
    memoryFailureHit(ipKey, windowMs);
  }
}

export async function clearLoginFailures(req: Request, identifier: string) {
  const ip = getClientIp(req);
  const idKey = `login-fail-id:${identifier.toLowerCase()}`;
  const ipKey = `login-fail-ip:${ip}`;
  await redisFailureClear(idKey);
  await redisFailureClear(ipKey);
  failureBuckets.delete(idKey);
  failureBuckets.delete(ipKey);
}

function normalizeSubject(subject: string) {
  return String(subject || "").trim().toLowerCase().slice(0, 256);
}

function getOtpLockoutConfig() {
  const windowMs = Math.max(60_000, Number(process.env.OTP_LOCKOUT_WINDOW_MS || 900_000));
  const maxAttempts = Math.max(3, Number(process.env.OTP_LOCKOUT_MAX_ATTEMPTS || 5));
  return { windowMs, maxAttempts };
}

function getOtpFailureKey(purpose: string, subject: string) {
  return `otp-fail:${normalizeSubject(purpose)}:${normalizeSubject(subject)}`;
}

export async function checkOtpLockout(
  purpose: string,
  subject: string
): Promise<LockoutResult> {
  const normalized = normalizeSubject(subject);
  if (!normalized) return { locked: false };

  const { windowMs, maxAttempts } = getOtpLockoutConfig();
  const key = getOtpFailureKey(purpose, normalized);

  const redis = await redisFailureStatus(key, windowMs, maxAttempts);
  if (redis?.locked) return redis;

  const mem = memoryFailureStatus(key, windowMs, maxAttempts);
  if (mem.locked) return mem;

  return { locked: false };
}

export async function recordOtpFailure(purpose: string, subject: string) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return;

  const { windowMs } = getOtpLockoutConfig();
  const key = getOtpFailureKey(purpose, normalized);

  const redisOk = await redisFailureHit(key, windowMs);
  if (!redisOk) {
    if (isLiveStage()) {
      console.warn("[rate-limit] OTP lockout using in-memory fallback (shared store missing)", {
        purpose,
      });
    }
    memoryFailureHit(key, windowMs);
  }
}

export async function clearOtpFailures(purpose: string, subject: string) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return;

  const key = getOtpFailureKey(purpose, normalized);
  await redisFailureClear(key);
  failureBuckets.delete(key);
}
