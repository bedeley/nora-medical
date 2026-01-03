"use client";

import { useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, Download } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

type TopProduct = {
  name: string;
  totalSold: number;
  revenue: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function TopSellingProducts() {
  const [mode, setMode] = useState<"quantity" | "revenue">("quantity");

  const { data, error, isLoading } = useClientQuery<TopProduct[]>({
    queryKey: ["admin","top-products", mode],
    queryFn: () => fetcher(`/api/admin/top-products?mode=${mode}`),
    refetchInterval: 10000,
  });

  // 🧩 CSV Export Handler
  const exportCSV = async () => {
    const res = await fetch(`/api/admin/top-products?mode=${mode}`);
    const products: TopProduct[] = await res.json();

    if (!products?.length) {
      alert("No data available to export.");
      return;
    }

    const headers = ["Product", "Total Sold", "Revenue"];
    const rows = products.map((p) =>
      [
        `"${p.name}"`,
        `"${p.totalSold}"`,
        `"${formatCurrency(p.revenue)}"`,
      ].join(",")
    );

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute(
      "download",
      `top-products-${mode}-${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          Top Selling Products
        </CardTitle>

        {/* Mode Toggle + Export Button */}
        <div className="flex items-center gap-3">
          <Select
            value={mode}
            onValueChange={(v) => setMode(v as "quantity" | "revenue")}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="View mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quantity">By Quantity</SelectItem>
              <SelectItem value="revenue">By Revenue</SelectItem>
            </SelectContent>
          </Select>

          {Array.isArray(data) && data.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2"
              onClick={exportCSV}
            >
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent style={{ width: "100%", height: 320 }}>
        {Boolean(error) && (
          <p className="text-red-500 text-sm">Error loading chart data.</p>
        )}
        {isLoading && (
          <p className="text-muted-foreground text-sm">Loading chart...</p>
        )}
        {data && data.length === 0 && (
          <div className="text-sm text-muted-foreground">
            <p>No sales data available yet.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/orders">View orders</Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/admin/products">Add products</Link>
              </Button>
            </div>
          </div>
        )}
        {data && data.length > 0 && (
          <ResponsiveContainer>
            <BarChart
              data={data}
              margin={{ top: 10, right: 20, bottom: 20, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip
                formatter={(value: number) =>
                  mode === "revenue"
                    ? [formatCurrency(value), "Revenue"]
                    : [`${value} sold`, "Quantity"]
                }
                labelFormatter={(label) => `Product: ${label}`}
              />
              <Bar
                dataKey={mode === "revenue" ? "revenue" : "totalSold"}
                fill={mode === "revenue" ? "#10b981" : "var(--color-primary)"}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
