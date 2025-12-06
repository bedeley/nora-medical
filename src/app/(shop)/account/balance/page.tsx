"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
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
  const { data, error, isLoading } = useQuery<Balance>({
    queryKey: ["balance", "self"],
    queryFn: () => fetcher("/api/balance?self=1"),
    refetchInterval: 10000,
  });
  const { data: ordersData } = useQuery<OrdersHistory>({
    queryKey: ["orders", "history"],
    queryFn: () => fetcher("/api/orders/history"),
    refetchInterval: 15000,
  });
  const hasOutstanding = (() => {
    const bal = Number(data?.balance ?? 0);
    if (bal > 0) return true;
    const orders = ordersData?.orders || [];
    return orders.some((o) => {
      const amountPaid = Number(o.amountPaid ?? 0);
      const balance = Number(o.balance ?? Math.max(0, Number(o.total) - amountPaid));
      return balance > 0 && o.status !== "CANCELLED";
    });
  })();
  const creditAvailable = Math.max(
    0,
    Number(data?.unappliedFunds ?? 0),
  );

  return (
    <section className="container mx-auto py-10 account-balance-page">
      <Card className="max-w-xl mx-auto !border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle>My Balance</CardTitle>
        </CardHeader>
        <CardContent className="py-3">
          {hasOutstanding && !isLoading && !error && (
            <div className="mb-3 border border-primary/20 bg-primary/10 text-primary p-3 text-sm !rounded-none">
              You have an outstanding balance. Please call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to arrange payment.
            </div>
          )}
          {isLoading ? (
            <p className="text-muted-foreground">Loading balance...</p>
          ) : error || !data ? (
            <p className="text-red-600">Failed to load balance.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              <p className="text-xs text-muted-foreground">
                This page shows whether you currently have any outstanding balance or store credit
                on your account. For detailed history, use your order list below.
              </p>
              <div className="flex justify-between">
                <span>Outstanding balance</span>
                <span className={data.balance > 0 ? "font-semibold text-red-600" : "font-medium text-green-700"}>
                  {data.balance > 0 ? formatCurrency(data.balance) : "None"}
                </span>
              </div>
              {creditAvailable > 0 && (
                <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <p className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded">
                    Store credit available:{" "}
                    <span className="font-semibold">
                      {formatCurrency(creditAvailable)}
                    </span>
                    . You can apply it to your outstanding orders.
                  </p>
                  <button
                    type="button"
                    className="text-xs font-medium px-3 py-1 rounded border border-emerald-600 text-emerald-700 hover:bg-emerald-50"
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/account/credit/apply", {
                          method: "POST",
                        });
                        const j = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          throw new Error(
                            j?.error || "Failed to apply store credit",
                          );
                        }
                        alert(
                          j?.applied
                            ? `Applied ${formatCurrency(
                                Number(j.applied || 0),
                              )} of store credit to your orders.`
                            : "No store credit could be applied.",
                        );
                        // Best-effort refresh via location reload on this simple page.
                        window.location.reload();
                      } catch (e: unknown) {
                        const message =
                          e instanceof Error
                            ? e.message
                            : "Failed to apply store credit";
                        alert(message);
                      }
                    }}
                  >
                    Apply Store Credit
                  </button>
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                Updated: {new Date(data.updatedAt).toLocaleString()}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent orders */}
      <div className="max-w-3xl mx-auto mt-8">
        <h2 className="text-lg font-semibold mb-3">Recent Orders</h2>
        {!ordersData?.orders?.length ? (
          <p className="text-sm text-muted-foreground">
            No recent orders. <Link href="/products" className="underline">Start shopping</Link>
          </p>
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
                const balance = Number(o.balance ?? Math.max(0, Number(o.total) - totalPaid));
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
                        const sc =
                          o.status === "PAID"
                            ? "bg-green-100 text-green-700"
                            : o.status === "PARTIALLY_PAID"
                            ? "bg-yellow-100 text-yellow-800"
                            : o.status === "CANCELLED"
                            ? "bg-gray-200 text-gray-700"
                            : "bg-red-100 text-red-700";
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
        <div className="text-right mt-2">
          <Link href="/orders" className="underline text-sm">View all orders</Link>
        </div>
      </div>
    </section>
  );
}
