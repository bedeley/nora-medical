"use client";

import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  TrendingUp,
  TrendingDown,
  Calendar,
  DollarSign,
  BarChart3,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function RevenueSummary() {
  const { data, error, isLoading } = useClientQuery({
    queryKey: ["admin","revenue-summary"],
    queryFn: () => fetcher("/api/admin/revenue-summary"),
    refetchInterval: 15000,
  });

  if (error)
    return <p className="text-red-500 text-sm">Error loading summary.</p>;

  const monthRevenue = data?.monthRevenue ?? 0;
  const yearRevenue = data?.yearRevenue ?? 0;
  const avgDaily = data?.avgDailyRevenue ?? 0;
  const growth = data?.growthPercent ?? null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* This Month */}
      <Card className="p-4">
        <CardHeader className="flex items-center justify-between pb-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" /> This Month
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">
            {isLoading ? "..." : formatCurrency(monthRevenue)}
          </p>
          <p className="text-xs text-muted-foreground">
            {growth !== null ? (
              <span
                className={`flex items-center gap-1 ${
                  growth >= 0 ? "text-green-600" : "text-red-500"
                }`}
              >
                {growth >= 0 ? (
                  <TrendingUp className="h-3 w-3" />
                ) : (
                  <TrendingDown className="h-3 w-3" />
                )}
                {growth.toFixed(1)}% vs last month
              </span>
            ) : (
              "No comparison available"
            )}
          </p>
        </CardContent>
      </Card>

      {/* This Year */}
      <Card className="p-4">
        <CardHeader className="flex items-center justify-between pb-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-green-500" /> This Year
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">
            {isLoading ? "..." : formatCurrency(yearRevenue)}
          </p>
          <p className="text-xs text-muted-foreground">Cumulative total</p>
        </CardContent>
      </Card>

      {/* Average Daily */}
      <Card className="p-4">
        <CardHeader className="flex items-center justify-between pb-1">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-amber-500" /> Avg. Daily
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">
            {isLoading ? "..." : formatCurrency(avgDaily)}
          </p>
          <p className="text-xs text-muted-foreground">
            Average per day this year
          </p>
        </CardContent>
      </Card>

      {/* Placeholder for total orders (optional future metric) */}
      <Card className="p-4">
        <CardHeader className="flex items-center justify-between pb-1">
          <CardTitle className="text-sm font-medium">Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold">📊 Live</p>
          <p className="text-xs text-muted-foreground">
            Updated every 15 seconds
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
