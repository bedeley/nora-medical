import { redirect } from "next/navigation";

type LegacyParams = Record<string, string | string[] | undefined>;

export default function LegacyDeliveryReconciliationRedirect({
  searchParams,
}: {
  searchParams?: LegacyParams;
}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (Array.isArray(value)) {
      for (const item of value) sp.append(key, item);
      continue;
    }
    if (typeof value === "string") sp.set(key, value);
  }
  const query = sp.toString();
  redirect(`/admin/delivery/collection-review${query ? `?${query}` : ""}`);
}
