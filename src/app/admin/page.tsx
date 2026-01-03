"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Package, Users, DollarSign, ClipboardList, CreditCard, Smartphone } from "lucide-react";
import { useSession } from "next-auth/react";
import type { AuthenticatedUser } from "@/lib/auth";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";

export default function AdminDashboard() {
  const { data: session } = useSession();

  const user = session?.user as AuthenticatedUser | undefined;
  const [counts, setCounts] = useState({
    products: null as number | null,
    customers: null as number | null,
    orders: null as number | null,
    balances: null as number | null,
  });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (!session || user?.role !== "ADMIN") return;
    let active = true;
    const load = async () => {
      try {
        const [productsRes, customersRes, summaryRes, balancesRes] = await Promise.all([
          fetch("/api/products?page=1&pageSize=1&includeArchived=1"),
          fetch("/api/admin/customers?includeArchived=1"),
          fetch("/api/admin/summary?groupBy=day"),
          fetch("/api/balance"),
        ]);
        if (!active) return;
        const productsData = await productsRes.json().catch(() => ({}));
        const customersData = await customersRes.json().catch(() => ({}));
        const summaryData = await summaryRes.json().catch(() => ({}));
        const balancesData = await balancesRes.json().catch(() => ([]));
        const balances = Array.isArray(balancesData)
          ? balancesData.filter((row: { balance?: number }) => Number(row?.balance || 0) > 0).length
          : null;
        setCounts({
          products: Number(productsData?.total ?? null),
          customers: Array.isArray(customersData?.rows) ? customersData.rows.length : null,
          orders: Number(summaryData?.summary?.orderCount ?? null),
          balances,
        });
        setLastUpdated(new Date());
      } catch (err) {
        console.error(err);
      }
    };
    load();
    const interval = setInterval(load, 60000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [session, user?.role]);

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdated) return "Last updated: --";
    return `Last updated: ${lastUpdated.toLocaleString()}`;
  }, [lastUpdated]);
  if (!session || user?.role !== "ADMIN") {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <h1 className="text-3xl font-bold text-red-600">Access Denied</h1>
        <p className="text-muted-foreground mt-2">
          You must be an administrator to view this page.
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Admin Dashboard</h1>
          <p className="text-muted-foreground mt-1">
            Manage products, customers, and payments in one place.
          </p>
          <p className="text-xs text-muted-foreground mt-2">{lastUpdatedLabel}</p>
        </div>
        <AddExpenseDialog
          onAdded={() => setLastUpdated(new Date())}
          buttonSize="sm"
          buttonVariant="default"
          label="+ Expense"
        />
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* Products Management */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Package className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Products</CardTitle>
              {counts.products !== null && (
                <p className="text-xs text-muted-foreground">{counts.products.toLocaleString()} total</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Add, edit, or delete products from the store inventory.
            </p>
            <Link href="/admin/products">
              <Button className="w-full">Manage Products</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Orders / Payments */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <DollarSign className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Orders/Payments</CardTitle>
              {counts.orders !== null && (
                <p className="text-xs text-muted-foreground">{counts.orders.toLocaleString()} orders</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Record payments and update balances for each customer.
            </p>
            <Link href="/admin/orders">
              <Button className="w-full">Manage Orders</Button>
            </Link>
          </CardContent>
        </Card>

        {/* MoMo Payments */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Smartphone className="h-6 w-6 text-primary" />
            <CardTitle>MoMo Payments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Monitor Mobile Money transactions and check payment status.
            </p>
            <Link href="/admin/payments/momo">
              <Button className="w-full">Manage MoMo Payments</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Customers */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Customers</CardTitle>
              {counts.customers !== null && (
                <p className="text-xs text-muted-foreground">{counts.customers.toLocaleString()} total</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              View customers and manage carts after orders and payments.
            </p>
            <Link href="/admin/customers">
              <Button className="w-full">Manage Customers</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Balances */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <CreditCard className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Balances</CardTitle>
              {counts.balances !== null && (
                <p className="text-xs text-muted-foreground">{counts.balances.toLocaleString()} outstanding</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              View outstanding balances across all customers.
            </p>
            <Link href="/admin/balances">
              <Button className="w-full">Manage Balances</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Customer Accounts */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <CardTitle>Customer Accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Close customer accounts when necessary.
            </p>
            <Link href="/admin/customer-accounts">
              <Button className="w-full">Manage Accounts</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Inventory Report */}
        <Card className="hover:shadow-md transition-all duration-200 sm:col-span-2 lg:col-span-3">
          <CardHeader className="flex items-center gap-3">
            <ClipboardList className="h-6 w-6 text-primary" />
            <CardTitle>Inventory Report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              View live inventory values and stock updates in real time.
            </p>
            <Link href="/admin/inventory">
              <Button className="w-full">Manage Inventory</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
