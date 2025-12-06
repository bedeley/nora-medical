"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export default function AdminGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isReceipt = typeof pathname === "string" && pathname.includes("/receipt");

  if (isReceipt) {
    return <>{children}</>;
  }

  return (
    <div data-slot="admin-page">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="container mx-auto flex flex-wrap items-center gap-2 py-2 text-sm">
          <Link href="/admin/dashboard" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/dashboard") ? "bg-muted" : ""}`}>Dashboard</Link>
          <Link href="/admin/orders" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/orders") ? "bg-muted" : ""}`}>Orders</Link>
          <Link href="/admin/customers" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/customers") ? "bg-muted" : ""}`}>Customers</Link>
          <Link href="/admin/products" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/products") ? "bg-muted" : ""}`}>Products</Link>
          <Link href="/admin/audit" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/audit") ? "bg-muted" : ""}`}>Audit Log</Link>
          <Link
            href="/admin/payments/momo"
            className={`ml-auto px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/payments/momo") ? "bg-muted" : "border"
            }`}
          >
            MoMo Payments
          </Link>
          <Link href="/admin/settings/communications" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/settings/communications") ? "bg-muted" : ""}`}>Comms</Link>
          <Link href="/admin/settings/features" className={`px-2 py-1 rounded whitespace-nowrap ${pathname.startsWith("/admin/settings/features") ? "bg-muted" : ""}`}>Features</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
