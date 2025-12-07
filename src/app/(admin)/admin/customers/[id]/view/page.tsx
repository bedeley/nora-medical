"use client";

export const dynamic = "force-dynamic";

import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatIdReadable } from "@/lib/utils";
import type { CustomerRow } from "../../page";
import { useEffect, useState } from "react";

type OrderRow = {
  id: string;
  status: string;
  deliveryStatus?: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  deliveredAt?: string | null;
  items?: Array<{
    id: string;
    quantity: number;
    price: number;
    deliveredQuantity?: number;
    returnedQuantity?: number;
    product?: { name?: string | null } | null;
  }>;
  createdAt: string;
  userId?: string | null;
};

type NormalizedOrderRow = OrderRow & {
  totalPaid: number;
  computedBalance: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminCustomerReadOnlyView() {
  const params = useParams<{ id: string }>();
  const userId = params.id;

  // Fetch order history via the same endpoint the customer portal uses, scoped by userId for admins
  const { data: ordersData, error } = useClientQuery<{ orders: OrderRow[] }>({
    queryKey: ["admin", "customer-orders", userId],
    queryFn: () => fetcher(`/api/orders/history?userId=${userId}`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  // Admin-facing balance snapshot (includes store credit)
  type AccountSummary = {
    ordersTotal: number;
    paidTotal: number;
    paymentsTotal: number;
    balance: number;
    storeCredit: number;
    cashRefunds: number;
    updatedAt: string;
  };
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      if (!userId) return;
      try {
        const res = await fetch(`/api/admin/customers/${userId}/balance`);
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as AccountSummary | null;
        if (!cancelled && json) {
          setAccountSummary(json);
        }
      } catch {
        // best-effort; leave summary as-is
      }
    }
    loadBalance();
    const id = setInterval(loadBalance, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userId]);

  // Lightweight customer identity for header context (reuse admin customers summary)
  const { data: customerMeta } = useClientQuery<{
    id: string;
    email: string | null;
    name: string | null;
  } | null>({
    queryKey: ["admin", "customer-meta", userId],
    queryFn: async () => {
      const res = await fetch("/api/admin/customers");
      if (!res.ok) {
        return { id: userId, email: null, name: null };
      }
      const j = (await res.json().catch(() => ({}))) as {
        rows?: CustomerRow[];
      };
      const rows: CustomerRow[] = j.rows || [];
      const match = rows.find(
        (r) => r?.user?.id && String(r.user.id) === String(userId),
      );
      if (match?.user) {
        return {
          id: match.user.id,
          email: match.user.email ?? null,
          name: match.user.name ?? null,
        };
      }
      return { id: userId, email: null, name: null };
    },
    refetchInterval: 60000,
    refetchOnWindowFocus: false,
  });

  const rawOrders: OrderRow[] = (ordersData?.orders || []) as OrderRow[];

  // Mirror the customer portal's normalization so totals and balances match exactly.
  const orders: NormalizedOrderRow[] = rawOrders.map((o) => {
    const totalPaid = Number(o.amountPaid ?? 0);
    const computedBalance = Number(
      o.balance ?? Math.max(0, Number(o.total ?? 0) - totalPaid),
    );
    return {
      ...o,
      totalPaid,
      computedBalance,
    };
  });

  const nonCancelledOrders = orders.filter((o) => o.status !== "CANCELLED");
  const ordersTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.total ?? 0),
    0,
  );
  const paidTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.totalPaid ?? 0),
    0,
  );
  const balance = Math.max(0, ordersTotal - paidTotal);

  const customerName = (customerMeta?.name || "").trim() || null;
  const customerEmail = (customerMeta?.email || "").trim() || null;

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
          <p className="text-xs">
            <span className="font-semibold">Customer:</span>{" "}
            {customerName || "Unknown name"}
            {customerEmail ? (
              <>
                {" "}
                ·{" "}
                <span className="text-muted-foreground">
                  {customerEmail}
                </span>
              </>
            ) : (
              <>
                {" "}
                ·{" "}
                <span className="text-muted-foreground">
                  ID: {formatIdReadable(customerMeta?.id || userId)}
                </span>
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            This view mirrors what the customer sees in their account and orders pages. Changes
            here are not possible; use other admin tools to manage balances and orders.
          </p>
        </div>
        <Link
          href={`/admin/customers?focus=${encodeURIComponent(String(userId))}`}
          className="text-xs underline"
        >
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
              {formatCurrency(ordersTotal)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Total Paid</span>
            <span className="font-medium text-green-700">
              {formatCurrency(paidTotal)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Balance</span>
            <span
              className={
                balance > 0
                  ? "font-semibold text-red-600"
                  : "font-medium text-green-700"
              }
            >
              {formatCurrency(balance)}
            </span>
          </div>
          {accountSummary && (
            <div className="flex justify-between">
              <span>Store credit</span>
              <span
                className={
                  accountSummary.storeCredit > 0
                    ? "font-semibold text-emerald-700"
                    : "font-medium text-muted-foreground"
                }
              >
                {formatCurrency(accountSummary.storeCredit)}
              </span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            This summary is derived from all non-cancelled orders for this customer. Store
            credit reflects credits from returns/adjustments minus amounts auto‑applied to
            orders and any cash payouts of credit.
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
                        {formatCurrency(Number(o.total ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.totalPaid ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.computedBalance ?? 0))}
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
