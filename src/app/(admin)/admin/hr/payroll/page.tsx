"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency } from "@/lib/currency";

type PayrollStatus = "ALL" | "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
type PayrollRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  runType?: "REGULAR" | "ADJUSTMENT";
  payslipCount?: number;
  totalGross: number | string;
  totalNet: number | string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function PayrollRunsPage() {
  const [status, setStatus] = useState<PayrollStatus>("ALL");
  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "payroll", "runs-page", status],
    queryFn: () => {
      const query = status === "ALL" ? "" : `?status=${status}`;
      return fetcher(`/api/admin/hr/payroll${query}`);
    },
  });

  const rows = useMemo(
    () => (Array.isArray(data?.rows) ? (data.rows as PayrollRun[]) : []),
    [data?.rows],
  );
  const summary = useMemo(() => {
    const stats = {
      draft: 0,
      finalized: 0,
      paid: 0,
      cancelled: 0,
      adjustment: 0,
      gross: 0,
      net: 0,
    };
    for (const run of rows) {
      if (run.status === "DRAFT") stats.draft += 1;
      if (run.status === "FINALIZED") stats.finalized += 1;
      if (run.status === "PAID") stats.paid += 1;
      if (run.status === "CANCELLED") stats.cancelled += 1;
      if (run.runType === "ADJUSTMENT") stats.adjustment += 1;
      stats.gross += Number(run.totalGross || 0);
      stats.net += Number(run.totalNet || 0);
    }
    return stats;
  }, [rows]);

  return (
    <section className="space-y-6 pb-20 md:pb-0">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.28em] text-muted-foreground">
                <Badge variant="outline">Staff workspace</Badge>
                <span>Payroll operations</span>
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">Payroll Runs</h1>
                <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
                  Review payroll batches, track posting status, and move from compensation setup into run-level processing from one queue.
                </p>
                <p className="text-xs text-muted-foreground">
                  {summary.draft > 0
                    ? `${summary.draft} payroll run${summary.draft === 1 ? " is" : "s are"} still in draft and may need review before posting.`
                    : rows.length > 0
                      ? `${rows.length} payroll run${rows.length === 1 ? " is" : "s are"} visible for the current status filter.`
                      : "No payroll runs match the current filter."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-md xl:justify-end">
              <Select value={status} onValueChange={(value) => setStatus(value as PayrollStatus)}>
                <SelectTrigger className="w-40 bg-background/90">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="DRAFT">Draft</SelectItem>
                  <SelectItem value="FINALIZED">Finalized</SelectItem>
                  <SelectItem value="PAID">Paid</SelectItem>
                  <SelectItem value="CANCELLED">Cancelled</SelectItem>
                </SelectContent>
              </Select>
              <Button asChild variant="outline">
                <Link href="/admin/hr/payroll/remittance">Open remittance register</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/hr/compensation">Back to Compensation</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Visible runs</p>
                <p className="text-2xl font-semibold">{rows.length}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Draft</p>
                <p className="text-2xl font-semibold">{summary.draft}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Finalized</p>
                <p className="text-2xl font-semibold">{summary.finalized}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Paid</p>
                <p className="text-2xl font-semibold">{summary.paid}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Adjustment runs</p>
                <p className="text-2xl font-semibold">{summary.adjustment}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Net pay total</p>
                <p className="text-2xl font-semibold">{formatCurrency(summary.net)}</p>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Run List</CardTitle>
          <p className="text-sm text-muted-foreground">
            Open individual runs to finalize payslips, exports, and posting steps.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading payroll runs...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Payslips</TableHead>
                  <TableHead>Gross</TableHead>
                  <TableHead>Net</TableHead>
                  <TableHead>Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No payroll runs found for this filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        {new Date(run.periodStart).toLocaleDateString()} -{" "}
                        {new Date(run.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{run.runType === "ADJUSTMENT" ? "Adjustment" : "Regular"}</TableCell>
                      <TableCell>{run.status}</TableCell>
                      <TableCell>{Number(run.payslipCount || 0)}</TableCell>
                      <TableCell>{formatCurrency(Number(run.totalGross || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(run.totalNet || 0))}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="secondary">
                          <Link href={`/admin/hr/payroll/${run.id}`}>Open</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
