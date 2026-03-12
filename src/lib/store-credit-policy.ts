import { prisma } from "@/lib/prisma";

export type StoreCreditApplyPolicy =
  | "oldest_first"
  | "current_order_first"
  | "manual_apply_only";

const DEFAULT_POLICY: StoreCreditApplyPolicy = "oldest_first";

export async function getStoreCreditApplyPolicy(): Promise<StoreCreditApplyPolicy> {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: "accounting.storeCredit.applyPolicy" },
      select: { value: true },
    });
    const raw = String(row?.value || "").trim().toLowerCase();
    if (
      raw === "oldest_first" ||
      raw === "current_order_first" ||
      raw === "manual_apply_only"
    ) {
      return raw;
    }
    return DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}

export function sortOrdersForStoreCreditPolicy<T extends { id: string; createdAt: Date }>(
  orders: T[],
  policy: StoreCreditApplyPolicy,
  preferredOrderId?: string | null,
): T[] {
  const base = [...orders].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  if (policy !== "current_order_first" || !preferredOrderId) return base;
  const preferred = base.filter((o) => o.id === preferredOrderId);
  const rest = base.filter((o) => o.id !== preferredOrderId);
  return [...preferred, ...rest];
}

