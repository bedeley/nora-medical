"use client";

export const dynamic = "force-dynamic";

import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { chipToneBorderClass, chipToneClass, orderStatusTone } from "@/lib/status-chips";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
  const displayBalance = Number(accountSummary?.balance ?? balance);
  const hasOutstanding = (() => {
    const summaryBalance = Number(accountSummary?.balance ?? 0);
    if (summaryBalance > 0) return true;
    return nonCancelledOrders.some((o) => Number(o.computedBalance ?? 0) > 0);
  })();
  const creditAvailable = Math.max(
    0,
    Number(accountSummary?.storeCredit ?? 0),
  );

  const customerName = (customerMeta?.name || "").trim() || null;
  const customerEmail = (customerMeta?.email || "").trim() || null;
  const orderQuery = new URLSearchParams();
  orderQuery.set("userId", String(userId));
  if (customerEmail) {
    orderQuery.set("q", customerEmail);
  } else if (customerName) {
    orderQuery.set("q", customerName);
  }
  const getStatusBadge = (status: string) => chipToneClass(orderStatusTone(status));
  const formatBalance = (value: number) =>
    value > 0 ? formatCurrency(value) : "None";

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
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/admin/audit?customerId=${encodeURIComponent(
                String(userId),
              )}`}
            >
              Audit log
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/api/admin/customers/${encodeURIComponent(
                String(userId),
              )}/statement?format=pdf`}
              target="_blank"
              rel="noreferrer"
            >
              Statement PDF
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/api/admin/customers/${encodeURIComponent(
                String(userId),
              )}/statement?format=csv`}
              target="_blank"
              rel="noreferrer"
            >
              Statement CSV
            </Link>
          </Button>
          <Link
            href={`/admin/customers?focus=${encodeURIComponent(String(userId))}`}
            className="text-xs underline"
          >
            Back to Customers
          </Link>
        </div>
      </header>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">My Balance</CardTitle>
        </CardHeader>
        <CardContent className="py-3 text-sm space-y-1">
          {hasOutstanding && (
            <div className={`mb-3 border p-3 text-xs !rounded-none ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
              You have an outstanding balance. Please call{" "}
              <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                {ADMIN_PHONE}
              </a>{" "}
              to arrange payment.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This page shows whether you currently have any outstanding balance or store credit on
            your account. For detailed history, use your order list below.
          </p>
          <div className="flex justify-between">
            <span>Outstanding balance</span>
            <span className={displayBalance > 0 ? "font-semibold text-red-600" : "font-medium text-green-700"}>
              {formatBalance(displayBalance)}
            </span>
          </div>
          {creditAvailable > 0 && (
            <div className="mt-3">
              <p className={`text-xs rounded border px-2 py-1 ${chipToneClass("success")} ${chipToneBorderClass("success")}`}>
                Store credit available:{" "}
                <span className="font-semibold">
                  {formatCurrency(creditAvailable)}
                </span>
                . This credit will be used automatically when you place new orders. If you would
                like it applied to an existing outstanding balance, please call{" "}
                <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                  {ADMIN_PHONE}
                </a>
                .
              </p>
            </div>
          )}
          {accountSummary?.updatedAt ? (
            <p className="text-[11px] text-muted-foreground mt-2">
              Last synced: {new Date(accountSummary.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Recent Orders</CardTitle>
        </CardHeader>
        <CardContent className="py-3">
          {orders.length === 0 ? (
            <div className="text-xs">
              <p className="text-muted-foreground">No orders found for this customer.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href={`/admin/orders?${orderQuery.toString()}`}
                  className="inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
                >
                  View orders
                </Link>
                <Link
                  href="/admin/customers"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
                >
                  Back to customers
                </Link>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="account-balance-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.slice(0, 5).map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>{new Date(o.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.total ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.totalPaid ?? 0))}
                      </TableCell>
                      <TableCell className={`text-right ${Number(o.computedBalance ?? 0) > 0 ? "text-red-600" : "text-green-700"}`}>
                        {formatCurrency(Number(o.computedBalance ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadge(o.status)}`}>
                          {String(o.status || "").toUpperCase()}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="text-right mt-2">
            <Link href={`/admin/orders?${orderQuery.toString()}`} className="underline text-sm">
              View all orders
            </Link>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
