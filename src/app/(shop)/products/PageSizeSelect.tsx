"use client";

import { useRouter, useSearchParams } from "next/navigation";

export default function PageSizeSelect({ defaultValue }: { defaultValue: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("pageSize");
  const value = current ? Number(current) : defaultValue;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Per page</span>
      <select
        value={Number.isFinite(value) ? value : defaultValue}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString());
          if (e.target.value === "24") {
            params.delete("pageSize");
          } else {
            params.set("pageSize", e.target.value);
          }
          params.set("page", "1");
          router.push(`?${params.toString()}`);
        }}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        aria-label="Results per page"
      >
        <option value="12">12</option>
        <option value="24">24</option>
        <option value="36">36</option>
        <option value="48">48</option>
      </select>
    </div>
  );
}
