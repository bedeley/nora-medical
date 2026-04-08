"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { ADMIN_NAV_ITEMS } from "@/lib/admin-nav";

export function AdminBreadcrumb() {
  const pathname = usePathname();

  const crumbs = useMemo(() => {
    if (!pathname) return [];
    const segments = pathname.split("/").filter(Boolean);
    const result: Array<{ label: string; href: string }> = [];
    let accumulated = "";

    for (const segment of segments) {
      accumulated += `/${segment}`;
      const match = ADMIN_NAV_ITEMS.find((item) => item.href === accumulated);
      if (match) {
        result.push({ label: match.label, href: match.href });
      } else if (segment === "admin" && result.length === 0) {
        // Fallback root crumb when /admin itself isn't in nav items
        result.push({ label: "Admin", href: "/admin" });
      }
    }
    return result;
  }, [pathname]);

  // Only show when there are at least 2 crumbs (i.e. we're somewhere under /admin/…)
  if (crumbs.length <= 1) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden md:flex items-center gap-1 text-xs text-muted-foreground px-2 pb-1"
    >
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1">
          {i > 0 && (
            <svg
              className="h-3 w-3 shrink-0 opacity-50"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          )}
          {i < crumbs.length - 1 ? (
            <Link href={crumb.href} className="hover:text-foreground transition-colors">
              {crumb.label}
            </Link>
          ) : (
            <span className="text-foreground font-medium" aria-current="page">
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
