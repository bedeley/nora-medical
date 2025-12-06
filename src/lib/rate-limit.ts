import { isLiveStage } from "@/lib/env";

type Counter = { count: number; resetAt: number };
const buckets = new Map<string, Counter>();

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";

function getKey(req: Request, name: string) {
  const ip =
    (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "")
      .split(",")[0]
      .trim() || "0.0.0.0";
  return `${name}:${ip}`;
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
