"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown, PieChart, HelpCircle } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Legend,
  Tooltip as RechartsTooltip,
} from "recharts";

type ExpenseSlice = { category: string; amount: number };

type SummaryProps = {
  summary: {
    totalRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
    expenseBreakdown?: ExpenseSlice[];
  };
};

export default function ProfitSummary({ summary }: SummaryProps) {
  const totalRevenue = summary?.totalRevenue ?? 0;
  const totalCOGS = summary?.totalCOGS ?? 0;
  const totalExpense = summary?.totalExpense ?? 0;
  const profit = summary?.profit ?? 0;
  const margin = summary?.margin ?? 0;
  const [view, setView] = useState<"cards" | "pie">("cards");

  const metrics: Array<{
    key: string;
    label: string;
    value: number;
    info: string;
    format?: "currency" | "percent";
    accent?: string;
    asNegative?: boolean;
  }> = [
    {
      key: "revenue",
      label: "Revenue",
      value: totalRevenue,
      info: "Gross sales from non-cancelled orders within the selected filters.",
    },
    {
      key: "cogs",
      label: "COGS",
      value: totalCOGS,
      info: "Cost of goods sold captured on each order item.",
      asNegative: true,
      accent: "text-amber-600",
    },
    {
      key: "expense",
      label: "Operating Expenses",
      value: totalExpense,
      info: "Administrative expenses logged in the expense tracker.",
      asNegative: true,
      accent: "text-red-600",
    },
    {
      key: "profit",
      label: "Net Profit",
      value: profit,
      info: "Revenue minus COGS and expenses for the filtered period.",
      accent: profit >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      key: "margin",
      label: "Margin",
      value: margin,
      info: "Net profit divided by revenue.",
      format: "percent",
      accent: margin >= 0 ? "text-green-600" : "text-red-600",
    },
  ];

  return (
    <Card className="p-4 shadow-md !border-none">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-2">
              <PieChart className="h-5 w-5 text-amber-500" />
              Profit vs Expense Snapshot
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-normal text-muted-foreground">
              Totals respect the filters selected below.
            </span>
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
              <button
                type="button"
                className={`px-2 py-0.5 text-xs rounded-sm ${
                  view === "cards"
                    ? "bg-background shadow-sm font-semibold"
                    : "text-muted-foreground"
                }`}
                onClick={() => setView("cards")}
              >
                Summary
              </button>
              <button
                type="button"
                className={`px-2 py-0.5 text-xs rounded-sm ${
                  view === "pie"
                    ? "bg-background shadow-sm font-semibold"
                    : "text-muted-foreground"
                }`}
                onClick={() => setView("pie")}
              >
                Pie chart
              </button>
            </div>
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="grid gap-4">
        {view === "cards" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {metrics.map((metric) => (
              <div
                key={metric.key}
                className="rounded-md bg-background p-3 shadow-sm"
              >
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {metric.label}
                  <Tooltip content={metric.info}>
                    <HelpCircle
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-label={metric.label}
                    />
                  </Tooltip>
                </p>
                <p className={`text-lg font-semibold ${metric.accent ?? ""}`}>
                  {metric.format === "percent"
                    ? `${metric.value.toFixed(2)}%`
                    : `${metric.asNegative ? "-" : ""}${formatCurrency(
                        metric.value,
                      )}`}
                </p>
                {metric.key === "profit" && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    {profit >= 0 ? (
                      <TrendingUp className="h-3 w-3 text-green-500" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-red-500" />
                    )}
                    Margin {margin.toFixed(2)}%
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="w-full h-72">
            {totalRevenue <= 0 ? (
              <p className="text-xs text-muted-foreground">
                Not enough data to render a pie chart. Adjust the filters above
                to include some revenue.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <RechartsPieChart>
                  <RechartsTooltip
                    formatter={(value: number, name: string) => [
                      formatCurrency(Number(value || 0)),
                      name,
                    ]}
                  />
                  <Legend />
                  <Pie
                    data={[
                      {
                        name: "Revenue",
                        value: Math.max(0, totalRevenue),
                      },
                      {
                        name: "COGS",
                        value: Math.max(0, totalCOGS),
                      },
                      {
                        name: "Operating Expenses",
                        value: Math.max(0, totalExpense),
                      },
                      {
                        name: "Net Profit",
                        value: Math.max(0, profit),
                      },
                    ]}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(entry) =>
                      formatCurrency(
                        Number(
                          (entry as { value?: number | string }).value || 0,
                        ),
                      )
                    }
                    labelLine={false}
                  >
                    <Cell key="revenue" fill="#3b82f6" />
                    <Cell key="cogs" fill="#f97316" />
                    <Cell key="expense" fill="#ef4444" />
                    <Cell
                      key="profit"
                      fill={profit >= 0 ? "#22c55e" : "#94a3b8"}
                    />
                  </Pie>
                </RechartsPieChart>
              </ResponsiveContainer>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              Revenue shown for reference; COGS + Operating Expenses + Net Profit should equal total revenue for the selected period.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
