"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LayoutDashboard } from "lucide-react";
import type { ReactNode } from "react";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isOnDashboard = pathname === "/admin" || pathname === "/admin/" || pathname === "/admin/dashboard";

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <nav className="container mx-auto flex flex-wrap items-center gap-2 py-2 text-sm">
          <Link
            href="/admin/dashboard"
            className={`px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/dashboard") ? "bg-muted" : ""
            }`}
          >
            Dashboard
          </Link>
          <Link
            href="/admin/orders"
            className={`px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/orders") ? "bg-muted" : ""
            }`}
          >
            Orders
          </Link>
          <Link
            href="/admin/customers"
            className={`px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/customers") ? "bg-muted" : ""
            }`}
          >
            Customers
          </Link>
          <Link
            href="/admin/products"
            className={`px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/products") ? "bg-muted" : ""
            }`}
          >
            Products
          </Link>
          <Link
            href="/admin/payments/momo"
            className={`ml-auto px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/payments/momo") ? "bg-primary text-primary-foreground" : "border"
            }`}
          >
            MoMo Payments
          </Link>
          <Link
            href="/admin/settings/communications"
            className={`px-2 py-1 rounded whitespace-nowrap ${
              pathname.startsWith("/admin/settings/communications") ? "bg-muted" : ""
            }`}
          >
            Settings
          </Link>
        </nav>
      </header>
      {children}
      {/* Floating Add Expense button (all admin pages except dashboard) */}
      {!isOnDashboard && (
        <AddExpenseDialog
          onAdded={() => router.refresh()}
          buttonClassName="fixed bottom-20 right-4 z-50 shadow-md"
          buttonSize="lg"
          buttonVariant="default"
          label="+ Expense"
        />
      )}
      {!isOnDashboard && (
        <Button
          asChild
          size="icon-lg"
          className="fixed bottom-4 right-4 z-50 shadow-md"
          aria-label="Go to admin dashboard"
          title="Dashboard"
        >
          <Link href="/admin/dashboard">
            <LayoutDashboard className="w-5 h-5" />
          </Link>
        </Button>
      )}
    </>
  );
}
