"use client";

export const dynamic = "force-dynamic";

import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { formatDateGH } from "@/lib/currency";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";
import { useParams } from "next/navigation";

type OrderRow = {
  id: string;
  status: string;
  deliveryStatus?: string;
  total: number;
  amountPaid: number;
  balance: number;
  createdAt: string;
};

type Summary = {
  ordersTotal: number;
  paidTotal: number;
  balance: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminCustomerReadOnlyView() {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const { data: ordersData, error } = useClientQuery<{ orders: OrderRow[] }>({
    queryKey: ["admin", "customer-orders", userId],
    queryFn: () => fetcher(`/api/admin/orders/user/${userId}/list`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });
  const { data: summary } = useClientQuery<Summary>({
    queryKey: ["admin", "customer-summary", userId],
    queryFn: () => fetcher(`/api/admin/orders/user/${userId}/summary`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  const orders = ordersData?.orders || [];
  const nonCancelledOrders = orders.filter((o) => o.status !== "CANCELLED");
  const ordersTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.total || 0),
    0,
  );
  const paidTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.amountPaid || 0),
    0,
  );
  const balance = Math.max(0, ordersTotal - paidTotal);

  const displayOrdersTotal =
    typeof summary?.ordersTotal === "number" ? Number(summary.ordersTotal) : ordersTotal;
  const displayPaidTotal =
    typeof summary?.paidTotal === "number" ? Number(summary.paidTotal) : paidTotal;
  const displayBalance =
    typeof summary?.balance === "number" ? Number(summary.balance) : balance;

  if (error) {
    const msg = (error as Error).message || "Error";
    return (
      <section className="container mx-auto py-8 max-w-4xl">
        <h1 className="text-xl font-semibold mb-4">Customer View</h1>
        <p className="text-sm text-red-600">Failed to load orders: {msg}</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 max-w-4xl space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Customer View (read-only)</h1>
          <p className="text-xs text-muted-foreground">
            This view mirrors what the customer sees in their account and orders pages. Changes
            here are not possible; use other admin tools to manage balances and orders.
          </p>
        </div>
        <Link href="/admin/customers" className="text-xs underline">
          Back to Customers
        </Link>
      </header>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Balance Snapshot</CardTitle>
        </CardHeader>
        <CardContent className="py-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span>Total Due</span>
            <span className="font-medium">
              {formatCurrency(displayOrdersTotal)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Total Paid</span>
            <span className="font-medium text-green-700">
              {formatCurrency(displayPaidTotal)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Balance</span>
            <span
              className={
                displayBalance > 0
                  ? "font-semibold text-red-600"
                  : "font-medium text-green-700"
              }
            >
              {formatCurrency(displayBalance)}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            This summary is derived from all non-cancelled orders for this customer.
          </p>
        </CardContent>
      </Card>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Recent Orders</CardTitle>
        </CardHeader>
        <CardContent className="py-3">
          {orders.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No orders found for this customer.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>{formatDateGH(o.createdAt)}</TableCell>
                      <TableCell>{o.status}</TableCell>
                      <TableCell>
                        {String(o.deliveryStatus || "NOT_DELIVERED").replace(/_/g, " ")}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.total))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.amountPaid))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.balance))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
