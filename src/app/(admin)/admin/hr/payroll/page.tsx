"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
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

  const rows = Array.isArray(data?.rows) ? (data.rows as PayrollRun[]) : [];

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Payroll Runs</h1>
          <p className="text-muted-foreground">Open payroll runs and review status before posting.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={status} onValueChange={(value) => setStatus(value as PayrollStatus)}>
            <SelectTrigger className="w-40">
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
            <Link href="/admin/hr/compensation">Back to Compensation</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Run List</CardTitle>
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
