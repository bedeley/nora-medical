"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function RevenueSummary() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useClientQuery({
    queryKey: ["reports", "revenue"],
    queryFn: () => fetcher("/api/reports/revenue"),
    refetchInterval: 15000,
  });

  async function downloadCSV() {
    try {
      const res = await fetch("/api/reports/revenue?format=csv");
      if (!res.ok) throw new Error("Failed to export CSV");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "revenue-report.csv";
      a.click();
      toast.success("Revenue report downloaded");
    } catch {
      toast.error("Error downloading CSV");
    }
  }

  if (isLoading || !data) {
    return (
      <p className="text-center text-muted-foreground mt-6">
        Loading revenue data...
      </p>
    );
  }

  return (
    <Card className="shadow-sm hover:shadow-md transition-all">
      <CardHeader className="flex justify-between items-center">
        <CardTitle>Revenue Overview</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["reports", "revenue"] })}>
            <RefreshCcw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={downloadCSV}>
            <Download className="w-4 h-4 mr-1" /> Export CSV
          </Button>
        </div>
      </CardHeader>

      <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
        <div>
          <p className="text-sm text-muted-foreground">Total Sales</p>
          <p className="text-xl font-semibold">
            {formatCurrency(data.totalSales)}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Total Paid</p>
          <p className="text-xl font-semibold text-green-600">
            {formatCurrency(data.totalPaid)}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Outstanding</p>
          <p className="text-xl font-semibold text-red-500">
            {formatCurrency(data.outstandingBalance)}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Orders</p>
          <p className="text-xl font-semibold">{data.orderCount}</p>
        </div>
      </CardContent>
    </Card>
  );
}
