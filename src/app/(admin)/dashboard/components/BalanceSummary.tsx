"use client";

import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DollarSign, Users, TrendingDown, TrendingUp } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function BalanceSummary() {
  const { data, error, isLoading } = useClientQuery({
    queryKey: ["admin", "summary"],
    queryFn: () => fetcher("/api/admin/summary"),
    refetchInterval: 5000,
  });

  if (error) return <p className="text-red-500">Failed to load summary.</p>;
  if (isLoading || !data) return <p className="text-muted-foreground">Loading summary...</p>;

  const { totalDue, totalPaid, outstanding, customers } = data;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Total Due</CardTitle>
          <DollarSign className="h-5 w-5 text-primary" />
        </CardHeader>
        <CardContent>
          <p className="text-xl font-bold text-primary">
            {formatCurrency(totalDue)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Total Paid</CardTitle>
          <TrendingUp className="h-5 w-5 text-green-500" />
        </CardHeader>
        <CardContent>
          <p className="text-xl font-bold text-green-700">
            {formatCurrency(totalPaid)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Outstanding</CardTitle>
          <TrendingDown className="h-5 w-5 text-red-500" />
        </CardHeader>
        <CardContent>
          <p
            className={`text-xl font-bold ${
              outstanding > 0 ? "text-red-600" : "text-green-700"
            }`}
          >
            {formatCurrency(outstanding)}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Customers</CardTitle>
          <Users className="h-5 w-5 text-purple-500" />
        </CardHeader>
        <CardContent>
          <p className="text-xl font-bold text-purple-700">{customers}</p>
        </CardContent>
      </Card>
    </div>
  );
}
