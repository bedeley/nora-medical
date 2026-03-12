"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";

type DiscountRow = {
  orderId: string;
  invoiceNumber: string | null;
  createdAt: string;
  customerName: string;
  customerType: "REGISTERED" | "WALK_IN";
  createdBy: string;
  status: string;
  grossAmount: number;
  discountAmount: number;
  total: number;
  discountPct: number;
  discountReason: string | null;
};

type DiscountReportResponse = {
  summary: {
    discountedOrders: number;
    totalGross: number;
    totalDiscount: number;
    totalNet: number;
    discountRatePct: number;
  };
  rows: DiscountRow[];
};

export default function OrderDiscountsReportPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [customerType, setCustomerType] = useState<"ALL" | "REGISTERED" | "WALK_IN">("ALL");

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (customerType !== "ALL") sp.set("customerType", customerType);
    return sp.toString();
  }, [start, end, customerType]);

  const { data, isLoading } = useClientQuery<DiscountReportResponse>({
    queryKey: ["accounting", "reports", "order-discounts", { start, end, customerType }],
    queryFn: () =>
      fetch(`/api/admin/accounting/reports/order-discounts?${params}`).then((r) => r.json()),
  });

  const summary = data?.summary || {
    discountedOrders: 0,
    totalGross: 0,
    totalDiscount: 0,
    totalNet: 0,
    discountRatePct: 0,
  };
  const rows = data?.rows || [];

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Order Discounts</h1>
          <p className="text-sm text-muted-foreground">
            Track discount amounts, rates, and reasons by order.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/accounting/reports">Back to Reports</Link>
          </Button>
          <Button asChild variant="outline">
            <a href={`/api/admin/accounting/reports/order-discounts/export?${params}`}>Export CSV</a>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Start date</label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">End date</label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">Customer type</label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={customerType}
              onChange={(e) =>
                setCustomerType(e.target.value as "ALL" | "REGISTERED" | "WALK_IN")
              }
            >
              <option value="ALL">All</option>
              <option value="REGISTERED">Registered</option>
              <option value="WALK_IN">Walk-in</option>
            </select>
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                setStart("");
                setEnd("");
                setCustomerType("ALL");
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Discounted Orders</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{summary.discountedOrders}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Gross Billed</CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold">{formatCurrency(summary.totalGross)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Total Discount</CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold text-amber-700">
            {formatCurrency(summary.totalDiscount)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Discount Rate</CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold">
            {summary.discountRatePct.toFixed(2)}%
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Discounted Orders Detail</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No discounted orders for the selected filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Order</th>
                    <th className="px-3 py-2 text-left">Customer</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Created By</th>
                    <th className="px-3 py-2 text-right">Gross</th>
                    <th className="px-3 py-2 text-right">Discount</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Discount %</th>
                    <th className="px-3 py-2 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.orderId} className="border-b align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/admin/orders/${row.orderId}`} className="underline">
                          {row.invoiceNumber || row.orderId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{row.customerName}</td>
                      <td className="px-3 py-2">{row.customerType}</td>
                      <td className="px-3 py-2">{row.createdBy}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(row.grossAmount)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(row.discountAmount)}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(row.total)}</td>
                      <td className="px-3 py-2 text-right">{row.discountPct.toFixed(2)}%</td>
                      <td className="px-3 py-2">{row.discountReason || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
