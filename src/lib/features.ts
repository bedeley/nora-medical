import { prisma } from "@/lib/prisma";

const cache = new Map<string, boolean>();

export async function isFeatureEnabled(key: string, defaultValue: boolean): Promise<boolean> {
  if (key === "accounting_auto_post") {
    const envVal = (process.env.ACCOUNTING_AUTO_POST_ENABLED || "").toLowerCase();
    return envVal !== "0";
  }
  if (cache.has(key)) return cache.get(key) ?? defaultValue;
  try {
    const flag = await prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) {
      cache.set(key, defaultValue);
      return defaultValue;
    }
    cache.set(key, flag.enabled);
    return flag.enabled;
  } catch {
    return defaultValue;
  }
}

export async function setFeatureEnabled(key: string, enabled: boolean): Promise<void> {
  try {
    await prisma.featureFlag.upsert({
      where: { key },
      update: { enabled },
      create: { key, enabled },
    });
    cache.set(key, enabled);
  } catch (e) {
    console.warn("setFeatureEnabled error:", e);
  }
}
