"use client";

import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

type RecentPayment = {
  id: string;
  amount: number | string;
  createdAt: string | Date;
  user?: { name?: string | null; email?: string | null } | null;
  order?: { id: string; total?: number | string | null } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function RecentPayments() {
  const { data, error, isLoading } = useClientQuery<RecentPayment[]>({
    queryKey: ["admin", "recent-payments"],
    queryFn: () => fetcher("/api/admin/recent"),
    refetchInterval: 5000,
  });

  // ✅ CSV export handler
  const exportCSV = async () => {
    const res = await fetch("/api/admin/recent?mode=full");
    const payments: RecentPayment[] = await res.json();

    if (!payments?.length) {
      alert("No payments available to export.");
      return;
    }

    const headers = [
      "Customer",
      "Email",
      "Amount",
      "Order ID",
      "Status",
      "Date",
    ];
    const rows = payments.map((p) => {
      const total = Number(p.order?.total ?? 0);
      const paid = Number(p.amount ?? 0);
      const ratio = total ? paid / total : 0;
      const status = ratio >= 1 ? "Paid" : ratio > 0 ? "Partial" : "Pending";

      return [
        `"${p.user?.name ?? "Unknown"}"`,
        `"${p.user?.email ?? ""}"`,
        `"${formatCurrency(Number(p.amount || 0))}"`,
        `"${p.order?.id.slice(0, 6) ?? "—"}"`,
        `"${status}"`,
        `"${new Date(p.createdAt).toLocaleString()}"`,
      ].join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `recent-payments-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (error)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-500">Error loading payments</p>
        </CardContent>
      </Card>
    );

  if (isLoading || !data)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Payments</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Loading payments...</p>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Recent Payments</CardTitle>
        {data.length > 0 && (
          <Button
            onClick={exportCSV}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
          >
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        )}
      </CardHeader>

      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Order</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((p) => {
              const total = Number(p.order?.total ?? 0);
              const paid = Number(p.amount ?? 0);
              const ratio = total ? paid / total : 0;
              const status =
                ratio >= 1 ? "Paid" : ratio > 0 ? "Partial" : "Pending";

              return (
                <TableRow key={p.id}>
                  <TableCell>{p.user?.name ?? "Unknown"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.user?.email}
                  </TableCell>
                  <TableCell>{formatCurrency(Number(p.amount || 0))}</TableCell>
                  <TableCell>{p.order?.id.slice(0, 6) ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        status === "Paid"
                          ? "success"
                          : status === "Partial"
                          ? "warning"
                          : "destructive"
                      }
                    >
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {new Date(p.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
