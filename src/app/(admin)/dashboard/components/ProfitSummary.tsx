"use client";

import { useEffect, useState } from "react";
import type { PieLabelRenderProps } from "recharts";
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
  const [labelMode, setLabelMode] = useState<"percent" | "amount">("percent");
  const [pieOuterRadius, setPieOuterRadius] = useState(70);
  const [isCompact, setIsCompact] = useState(false);
  const pieInnerRadius = Math.max(32, pieOuterRadius - 32);

  useEffect(() => {
    const updateRadius = () => {
      if (typeof window === "undefined") return;
      const w = window.innerWidth;
      setIsCompact(w < 420);
      if (w >= 1280) {
        setPieOuterRadius(110);
      } else if (w < 420) {
        setPieOuterRadius(78);
      } else {
        setPieOuterRadius(70);
      }
    };
    updateRadius();
    window.addEventListener("resize", updateRadius);
    return () => window.removeEventListener("resize", updateRadius);
  }, []);

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

  const pieData: Array<{ name: string; value: number }> = [
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
  ];
  const pieTotal = pieData.reduce((sum, slice) => sum + slice.value, 0);

  const formatSliceValue = (value: number) => {
    if (!value || !Number.isFinite(value)) return "";
    try {
      const compact = new Intl.NumberFormat("en-GH", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
      return `GH₵${compact}`;
    } catch {
      return `GH₵${value.toFixed(0)}`;
    }
  };

  const formatSlicePercent = (percent?: number) => {
    if (percent === undefined || Number.isNaN(percent)) return "";
    return `${Math.round(percent * 100)}%`;
  };

  const renderSliceLabel = (props: PieLabelRenderProps) => {
    const RADIAN = Math.PI / 180;
    // Place label just outside the slice along the arc
    const outerRadius = Number(props.outerRadius ?? 0);
    const cx = Number(props.cx ?? 0);
    const cy = Number(props.cy ?? 0);
    const midAngle = Number(props.midAngle ?? 0);

    const radius = isCompact ? Math.max(outerRadius - 8, 32) : outerRadius + 10;
    let x = cx + radius * Math.cos(-midAngle * RADIAN);
    let y = cy + radius * Math.sin(-midAngle * RADIAN);

    const percent = typeof props.percent === "number" ? props.percent : undefined;
    const label =
      labelMode === "amount"
        ? formatSliceValue(Number(props.value || 0))
        : formatSlicePercent(percent);
    if (!label || isCompact) return null;

    // If the slice is at the very top of the pie, center the label
    if (midAngle > 80 && midAngle < 100) {
      x = cx;
      y = cy - (outerRadius + 12);
    }

    const textAnchor = x === cx ? "middle" : x >= cx ? "start" : "end";

    const name = String((props as { name?: unknown }).name ?? "");
    // Match label color to the slice / legend color so the percents
    // visually align with the keys under the chart.
    let fillColor = "#e5e7eb";
    if (name === "Revenue") {
      // Lighter blue than the slice for better contrast in dark mode
      fillColor = "#60a5fa";
    } else if (name === "COGS") {
      // Lighter orange
      fillColor = "#fdba74";
    } else if (name === "Operating Expenses") {
      // Lighter red
      fillColor = "#fca5a5";
    } else if (name === "Net Profit") {
      fillColor = profit >= 0 ? "#4ade80" : "#cbd5f5";
    }

    return (
      <text
        x={x}
        y={y}
        fill={fillColor}
        textAnchor={textAnchor as "start" | "end"}
        dominantBaseline="central"
        fontSize={isCompact ? 10 : 12}
        fontWeight={600}
      >
        {label}
      </text>
    );
  };

  const netProfitPercent = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;
  const netProfitCompact = formatSliceValue(Math.abs(profit));

  return (
    <Card className="p-4 shadow-md !border-none mb-4 min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-2">
              <PieChart className="h-5 w-5 text-amber-500" />
              Profit vs Expense Snapshot
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
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
            {view === "pie" && (
              <div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-xs">
                <button
                  type="button"
                  className={`px-2 py-0.5 rounded-sm ${
                    labelMode === "percent"
                      ? "bg-background shadow-sm font-semibold"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setLabelMode("percent")}
                >
                  % labels
                </button>
                <button
                  type="button"
                  className={`px-2 py-0.5 rounded-sm ${
                    labelMode === "amount"
                      ? "bg-background shadow-sm font-semibold"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setLabelMode("amount")}
                >
                  Amounts
                </button>
              </div>
            )}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="grid gap-4 min-w-0">
        {view === "cards" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 min-w-0">
            {metrics.map((metric) => (
              <div
                key={metric.key}
                className="rounded-md bg-background p-3 shadow-sm min-w-0"
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
          <div className="w-full min-w-0">
            {totalRevenue <= 0 ? (
              <p className="text-xs text-muted-foreground">
                Not enough data to render a pie chart. Adjust the filters above
                to include some revenue.
              </p>
            ) : (
              <>
                <div className="relative h-64 sm:h-72 lg:h-80 xl:h-96 min-w-0">
                  {isCompact && (
                    <div className="absolute right-2 top-2 z-10">
                      <Tooltip
                        content={
                          <div className="space-y-1 text-xs">
                            {pieData.map((slice) => {
                              const color =
                                slice.name === "Revenue"
                                  ? "#3b82f6"
                                  : slice.name === "COGS"
                                    ? "#f97316"
                                    : slice.name === "Operating Expenses"
                                      ? "#ef4444"
                                      : profit >= 0
                                        ? "#22c55e"
                                        : "#94a3b8";
                              return (
                                <div key={slice.name} className="flex items-center gap-2">
                                  <span
                                    className="h-2.5 w-2.5 rounded-sm"
                                    style={{ backgroundColor: color }}
                                    aria-hidden="true"
                                  />
                                  <span>{slice.name}</span>
                                </div>
                              );
                            })}
                          </div>
                        }
                      >
                        <button
                          type="button"
                          className="rounded-full border bg-background/90 p-1 text-muted-foreground shadow-sm"
                          aria-label="Show chart legend"
                        >
                          <HelpCircle className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>
                  )}
                  <ResponsiveContainer width="100%" height="100%">
                    <RechartsPieChart margin={{ top: 8, bottom: 24, left: 8, right: 8 }}>
                      <RechartsTooltip
                        formatter={(value, name, item) => {
                          const percent =
                            typeof (item as { percent?: number } | undefined)?.percent === "number"
                              ? (item as { percent?: number }).percent
                              : undefined;
                          const amount = formatCurrency(Number(value || 0));
                          return [`${amount}${percent ? ` (${formatSlicePercent(percent)})` : ""}`, name];
                        }}
                      />
                      {!isCompact && (
                        <Legend
                          verticalAlign="bottom"
                          align="center"
                          wrapperStyle={{ fontSize: 11, marginTop: 4 }}
                        />
                      )}
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={pieOuterRadius}
                        innerRadius={pieInnerRadius}
                        label={isCompact ? false : renderSliceLabel}
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
                      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle">
                        <tspan x="50%" dy={-12} fill="#6b7280" fontSize={isCompact ? 10 : 11}>
                          Net Profit
                        </tspan>
                        <tspan
                          x="50%"
                          dy={14}
                          fill="#111827"
                          fontSize={isCompact ? 16 : 16}
                          fontWeight={600}
                        >
                          {netProfitPercent.toFixed(1)}%
                        </tspan>
                        <tspan x="50%" dy={14} fill="#6b7280" fontSize={isCompact ? 10 : 11}>
                          {netProfitCompact || "GH₵0"}
                        </tspan>
                      </text>
                    </RechartsPieChart>
                  </ResponsiveContainer>
                </div>
                {isCompact && (
                  <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                    {pieData.map((slice) => {
                      const pct = pieTotal > 0 ? (slice.value / pieTotal) * 100 : 0;
                      const color =
                        slice.name === "Revenue"
                          ? "#3b82f6"
                          : slice.name === "COGS"
                            ? "#f97316"
                            : slice.name === "Operating Expenses"
                              ? "#ef4444"
                              : profit >= 0
                                ? "#22c55e"
                                : "#94a3b8";
                      return (
                        <div key={slice.name} className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-sm"
                              style={{ backgroundColor: color }}
                              aria-hidden="true"
                            />
                            <span className="truncate">{slice.name}</span>
                          </span>
                          <span className="tabular-nums">
                            {formatSlicePercent(pct / 100)} · {formatSliceValue(slice.value)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Revenue shown for reference; COGS + Operating Expenses + Net Profit should equal total revenue for the selected period.
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
