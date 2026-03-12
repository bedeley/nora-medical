"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { chipToneBorderClass, chipToneClass, orderStatusTone } from "@/lib/status-chips";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Balance = {
  totalDue: number;
  totalPaid: number;
  balance: number;
  paymentsTotal?: number;
  unappliedFunds?: number;
  cashRefunds?: number;
  updatedAt: string | Date;
};

type OrderSummary = {
  id: string;
  status: string;
  createdAt: string | Date;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
};

type OrdersHistory = {
  orders: OrderSummary[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AccountBalancePage() {
  const { status } = useSession();
  const isAuthed = status === "authenticated";
  const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);
  const { data, error, isLoading } = useQuery<Balance>({
    queryKey: ["balance", "self"],
    queryFn: () => fetcher("/api/balance?self=1"),
    refetchInterval: 10000,
    enabled: isAuthed,
  });
  const { data: ordersData } = useQuery<OrdersHistory>({
    queryKey: ["orders", "history"],
    queryFn: () => fetcher("/api/orders/history"),
    refetchInterval: 15000,
    enabled: isAuthed,
  });
  const hasOutstanding = (() => {
    const bal = normalizeBalance(Number(data?.balance ?? 0));
    if (bal > 0) return true;
    const orders = ordersData?.orders || [];
    return orders.some((o) => {
      const amountPaid = Number(o.amountPaid ?? 0);
      const rawBalance = Number(o.balance ?? Math.max(0, Number(o.total) - amountPaid));
      const balance = normalizeBalance(rawBalance);
      return balance > 0 && o.status !== "CANCELLED";
    });
  })();
  const creditAvailable = Math.max(
    0,
    Number(data?.unappliedFunds ?? 0),
  );

  if (status === "unauthenticated") {
    if (typeof window !== "undefined") {
      window.location.href = `/login?callbackUrl=${encodeURIComponent(
        "/account/balance",
      )}`;
    }
    return null;
  }

  return (
    <section className="container mx-auto py-10 account-balance-page">
      <Card className="max-w-3xl mx-auto border shadow-sm">
        <CardHeader className="py-3">
          <CardTitle>My Balance</CardTitle>
        </CardHeader>
        <CardContent className="py-3">
          {hasOutstanding && !isLoading && !error && (
            <div className={`mb-3 flex flex-col gap-2 rounded-md border p-3 text-sm ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
              <div>
                You have an outstanding balance. Please call{" "}
                <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                  {ADMIN_PHONE}
                </a>{" "}
                to arrange payment.
              </div>
              <div>
                <Button asChild size="sm" className="text-white">
                  <Link href="/orders">Pay outstanding</Link>
                </Button>
              </div>
            </div>
          )}
          {!hasOutstanding && !isLoading && !error && data && (
            <div className={`mb-3 rounded-md border p-3 text-sm ${chipToneClass("success")} ${chipToneBorderClass("success")}`}>
              <div>You are all caught up. No outstanding balance at this time.</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href="/products">Browse products</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/contact">Contact support</Link>
                </Button>
              </div>
            </div>
          )}
          {isLoading ? (
            <p className="text-muted-foreground">Loading balance...</p>
          ) : error || !data ? (
            <p className="text-red-600">Failed to load balance.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              <p className="text-xs text-muted-foreground">
                This page shows your current balance and store credit. For full history, review
                your recent orders below.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="border">
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Outstanding balance</p>
                    <p className={normalizeBalance(data.balance) > 0 ? "text-lg font-semibold text-red-600" : "text-lg font-semibold text-green-700"}>
                      {normalizeBalance(data.balance) > 0 ? formatCurrency(normalizeBalance(data.balance)) : "None"}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border">
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Store credit</p>
                    <p className="text-lg font-semibold text-emerald-700">
                      {creditAvailable > 0 ? formatCurrency(creditAvailable) : "None"}
                    </p>
                  </CardContent>
                </Card>
                <Card className="border">
                  <CardContent className="pt-4">
                    <p className="text-xs text-muted-foreground">Last updated</p>
                    <p className="text-sm font-semibold">
                      {new Date(data.updatedAt).toLocaleString()}
                    </p>
                  </CardContent>
                </Card>
              </div>
              {creditAvailable > 0 && (
                <div className="mt-3">
                  <p className={`text-xs rounded border px-2 py-1 ${chipToneClass("success")} ${chipToneBorderClass("success")}`}>
                    Store credit available:{" "}
                    <span className="font-semibold">
                      {formatCurrency(creditAvailable)}
                    </span>
                    . This credit will be used automatically when you place new
                    orders. If you would like it applied to an existing
                    outstanding balance, please call{" "}
                    <a
                      href={ADMIN_PHONE_TEL}
                      className="underline font-medium"
                    >
                      {ADMIN_PHONE}
                    </a>
                    .
                  </p>
                </div>
              )}
              {creditAvailable > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Automatic use: store credit applies to your oldest unpaid
                  order at checkout.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent orders */}
      <div className="max-w-3xl mx-auto mt-8">
        <Card className="border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Recent Orders</CardTitle>
            <Link href="/orders" className="text-sm text-primary underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {!ordersData?.orders?.length ? (
              <div className="text-sm">
                <p className="text-muted-foreground">No recent orders yet.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href="/products">Start shopping</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/contact">Contact us</Link>
                  </Button>
                </div>
              </div>
            ) : (
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
                  {ordersData.orders.slice(0, 5).map((o) => {
                    const totalPaid = Number(o.amountPaid ?? 0);
                    const rawBalance = Number(o.balance ?? Math.max(0, Number(o.total) - totalPaid));
                    const balance = normalizeBalance(rawBalance);
                    return (
                      <TableRow key={o.id}>
                        <TableCell>{new Date(o.createdAt).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">{formatCurrency(Number(o.total))}</TableCell>
                        <TableCell className="text-right">{formatCurrency(totalPaid)}</TableCell>
                        <TableCell className={`text-right ${balance > 0 ? "text-red-600" : "text-green-700"}`}>
                          {formatCurrency(balance)}
                        </TableCell>
                        <TableCell className="text-right">
                          {(() => {
                            const sc = chipToneClass(orderStatusTone(o.status));
                            return (
                              <span className={`text-xs px-2 py-0.5 rounded-full ${sc}`}>
                                {o.status}
                              </span>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
