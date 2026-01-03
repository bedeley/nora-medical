"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LineChart as LineChartIcon, RefreshCw, Download } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

type SalesPoint = {
  date: string;
  totalRevenue: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function SalesTrendChart() {
  const [range, setRange] = useState("7");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [url, setUrl] = useState(`/api/admin/sales-trend?range=7`);

  const queryClient = useQueryClient();
  const { data, error, isLoading } = useClientQuery<SalesPoint[]>({
    queryKey: ["admin","sales-trend", url],
    queryFn: () => fetcher(url),
    refetchInterval: 10000,
  });

  // 🔽 CSV export handler
  const exportCSV = async () => {
    const res = await fetch(url);
    const trend = (await res.json()) as SalesPoint[];

    if (!trend?.length) {
      alert("No data available to export.");
      return;
    }

    const headers = ["Date", "Revenue"];
    const rows = trend.map((t) => [
      `"${t.date}"`,
      `"${t.totalRevenue.toFixed(2)}"`,
    ]);

    const csv = [headers.join(","), ...rows.map((r: string[]) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.setAttribute(
      "download",
      `sales-trend-${new Date().toISOString().slice(0, 10)}.csv`
    );
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleRangeChange = (value: string) => {
    setRange(value);
    if (value === "custom") {
      if (customStart && customEnd) {
        setUrl(`/api/admin/sales-trend?start=${customStart}&end=${customEnd}`);
      }
    } else {
      setUrl(`/api/admin/sales-trend?range=${value}`);
    }
  };

  const handleCustomSubmit = () => {
    if (!customStart || !customEnd) return;
    setUrl(`/api/admin/sales-trend?start=${customStart}&end=${customEnd}`);
    queryClient.invalidateQueries({ queryKey: ["admin","sales-trend"] });
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between flex-wrap gap-3">
        <CardTitle className="flex items-center gap-2">
          <LineChartIcon className="h-5 w-5 text-primary" />
          Sales Trend
        </CardTitle>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={range} onValueChange={handleRangeChange}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 Days</SelectItem>
              <SelectItem value="30">Last 30 Days</SelectItem>
              <SelectItem value="custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>

          {range === "custom" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <Input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
              <Button onClick={handleCustomSubmit} size="sm">
                Apply
              </Button>
            </div>
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["admin","sales-trend"] })}
            title="Refresh data"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>

          {Array.isArray(data) && data.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-1"
              onClick={exportCSV}
              title="Export CSV"
            >
              <Download className="h-4 w-4" /> Export
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent style={{ width: "100%", height: 300 }}>
        {Boolean(error) && (
          <p className="text-red-500 text-sm">Error loading sales data.</p>
        )}
        {isLoading && (
          <p className="text-muted-foreground text-sm">Loading chart...</p>
        )}
        {data && data.length === 0 && (
          <div className="text-muted-foreground text-sm">
            <p>No sales data in this range.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => handleRangeChange("30")}>
                View last 30 days
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/admin/orders">View orders</Link>
              </Button>
            </div>
          </div>
        )}
        {data && data.length > 0 && (
          <ResponsiveContainer>
            <LineChart
              data={data}
              margin={{ top: 10, right: 20, bottom: 20, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => {
                  try { return new Date(d).toLocaleDateString("en-GH", { month: "short", day: "numeric", timeZone: "Africa/Accra" }); } catch { return d; }
                }}
                tick={{ fontSize: 12 }}
              />
              <YAxis tickFormatter={(v) => formatCurrency(Number(v))} />
              <Tooltip
                formatter={(v: number) => [formatCurrency(v), "Revenue"]}
                labelFormatter={(l) => {
                  try { return `Date: ${new Date(l).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })}`; } catch { return String(l); }
                }}
              />
              <Line
                type="monotone"
                dataKey="totalRevenue"
                stroke="var(--color-primary)"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
