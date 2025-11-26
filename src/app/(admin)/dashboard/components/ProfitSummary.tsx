"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown, PieChart, HelpCircle } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import ExpenseCategoryPie from "./ExpenseCategoryPie";
import { Tooltip } from "@/components/ui/tooltip";

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
  const breakdown = summary?.expenseBreakdown ?? [];

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
    <Card className="p-4">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-2">
            <PieChart className="h-5 w-5 text-amber-500" />
            Profit vs Expense Snapshot
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            Totals respect the filters selected below.
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {metrics.map((metric) => (
            <div key={metric.key} className="rounded-md border p-3 bg-muted/30">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {metric.label}
                <Tooltip content={metric.info}>
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label={metric.label} />
                </Tooltip>
              </p>
              <p className={`text-lg font-semibold ${metric.accent ?? ""}`}>
                {metric.format === "percent"
                  ? `${metric.value.toFixed(1)}%`
                  : `${metric.asNegative ? "-" : ""}${formatCurrency(metric.value)}`}
              </p>
              {metric.key === "profit" && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {profit >= 0 ? (
                    <TrendingUp className="h-3 w-3 text-green-500" />
                  ) : (
                    <TrendingDown className="h-3 w-3 text-red-500" />
                  )}
                  Margin {margin.toFixed(1)}%
                </p>
              )}
            </div>
          ))}
        </div>

        <div>
          <p className="text-xs font-semibold text-muted-foreground mb-1">
            Expense Breakdown
          </p>
          {breakdown.length ? (
            <ul className="text-sm space-y-1">
              {breakdown.slice(0, 6).map((b) => (
                <li key={b.category} className="flex items-center justify-between">
                  <span className="truncate">{b.category}</span>
                  <span className="font-medium">{formatCurrency(b.amount)}</span>
                </li>
              ))}
              {breakdown.length > 6 && (
                <li className="text-xs text-muted-foreground">
                  +{breakdown.length - 6} more categories in chart
                </li>
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No expenses recorded for this filter.</p>
          )}
        </div>

        <ExpenseCategoryPie breakdown={breakdown} />
      </CardContent>
    </Card>
  );
}
