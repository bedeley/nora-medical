"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Package, Users, DollarSign, ClipboardList, CreditCard, Smartphone } from "lucide-react";
import { useSession } from "next-auth/react";
import type { AuthenticatedUser } from "@/lib/auth";

export default function AdminDashboard() {
  const { data: session } = useSession();

  const user = session?.user as AuthenticatedUser | undefined;
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
      <header>
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Manage products, customers, and payments in one place.
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* Products Management */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Package className="h-6 w-6 text-primary" />
            <CardTitle>Products</CardTitle>
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

        {/* Customer Cart */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <CardTitle>Customer Cart</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              View customers and manage carts after orders and payments.
            </p>
            <Link href="/admin/customers">
              <Button className="w-full">Open Customer Cart</Button>
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

        {/* Orders / Payments */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <DollarSign className="h-6 w-6 text-primary" />
            <CardTitle>Orders/Payments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Record payments and update balances for each customer.
            </p>
            <Link href="/admin/orders">
              <Button className="w-full">Open Orders/Payments</Button>
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
              <Button className="w-full">Open MoMo Payments</Button>
            </Link>
          </CardContent>
        </Card>

        {/* Balances */}
        <Card className="hover:shadow-md transition-all duration-200">
          <CardHeader className="flex items-center gap-3">
            <CreditCard className="h-6 w-6 text-primary" />
            <CardTitle>Balances</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              View outstanding balances across all customers.
            </p>
            <Link href="/admin/balances">
              <Button className="w-full">View Balances</Button>
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
              <Button className="w-full">View Inventory</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
