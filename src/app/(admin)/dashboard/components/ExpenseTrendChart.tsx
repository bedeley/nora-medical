"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TrendingDown } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ExpenseTrendChart({
  refreshKey,
}: {
  refreshKey?: number;
}) {
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useClientQuery({
    queryKey: ["admin","expense-trend"],
    queryFn: () => fetcher("/api/admin/expense-trend"),
    refetchInterval: 60000,
  });

  if (refreshKey) queryClient.invalidateQueries({ queryKey: ["admin","expense-trend"] });

  if (error)
    return <p className="text-red-500 text-sm">Error loading expense trend</p>;

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading trend...</p>;

  return (
    <Card className="p-4 mt-4">
      <CardHeader className="flex items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-red-500">
          <TrendingDown className="h-5 w-5" />
          Expense Trend (Last 30 Days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(d) =>
                  new Date(d).toLocaleDateString("en-GH", {
                    month: "short",
                    day: "numeric",
                    timeZone: "Africa/Accra",
                  })
                }
                tick={{ fontSize: 10 }}
              />
              <YAxis
                tickFormatter={(v) => formatCurrency(Number(v))}
                width={50}
                tick={{ fontSize: 10 }}
              />
              <Tooltip
                formatter={(v: number) => formatCurrency(v)}
                labelFormatter={(label) =>
                  new Date(label).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })
                }
              />
              <Line
                type="monotone"
                dataKey="expense"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
