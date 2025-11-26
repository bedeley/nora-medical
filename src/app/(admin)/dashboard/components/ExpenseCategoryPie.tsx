"use client";

import { ResponsiveContainer, PieChart as RePieChart, Pie, Cell, Tooltip as ReTooltip, Legend } from "recharts";
import { formatCurrency } from "@/lib/currency";

type ExpenseSlice = { category: string; amount: number };

export default function ExpenseCategoryPie({ breakdown }: { breakdown: ExpenseSlice[] }) {
  const pieData = (breakdown || [])
    .map((b) => ({
      name: b.category || "Uncategorized",
      value: Number(b.amount || 0),
    }))
    .filter((b) => b.value > 0);

  const total = pieData.reduce((s, d) => s + d.value, 0);
  if (!pieData.length || total <= 0) return null;

  const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#84cc16", "#eab308", "#f97316"];

  return (
    <div className="mt-2">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <RePieChart>
            <ReTooltip formatter={(v: number, n: string) => [formatCurrency(Number(v)), n]} />
            <Legend verticalAlign="bottom" height={24} wrapperStyle={{ fontSize: 12 }} />
            <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="45%" innerRadius={40} outerRadius={80} paddingAngle={2}>
              {pieData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
          </RePieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
