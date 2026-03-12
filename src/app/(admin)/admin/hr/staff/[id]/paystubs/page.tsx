"use client";

export const dynamic = "force-dynamic";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";

type PayslipRow = {
  id: string;
  grossPay: number | string;
  netPay: number | string;
  lineItems?: Record<string, number> | null;
  payrollRun: {
    id: string;
    periodStart: string;
    periodEnd: string;
    status?: string;
    runType?: string;
    createdAt?: string;
  };
  employee?: { firstName: string; lastName: string };
};

type EmployeeDetail = {
  id: string;
  firstName: string;
  lastName: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function buildYtd(rows: PayslipRow[]) {
  const totalsByYear: Record<
    number,
    {
      rows: Record<
        string,
        { gross: number; net: number; deductions: number; tax: number; pension: number }
      >;
      regularByPeriod: Map<string, { id: string; status: string; createdAt: number }>;
    }
  > = {};

  const normalized = rows.map((row) => ({
    ...row,
    periodEndTime: new Date(row.payrollRun.periodEnd).getTime(),
    runCreatedTime: row.payrollRun.createdAt ? new Date(row.payrollRun.createdAt).getTime() : 0,
    year: new Date(row.payrollRun.periodEnd).getFullYear(),
    status: (row.payrollRun.status || "").toUpperCase(),
    runType: (row.payrollRun.runType || "").toUpperCase(),
  }));

  for (const row of normalized) {
    if (!totalsByYear[row.year]) {
      totalsByYear[row.year] = {
        rows: {},
        regularByPeriod: new Map(),
      };
    }
  }

  normalized.forEach((candidate) => {
    const yearBucket = totalsByYear[candidate.year];
    if (!yearBucket) return;
    if (candidate.runType !== "REGULAR") return;
    if (candidate.status !== "FINALIZED" && candidate.status !== "PAID") return;
    const key = `${candidate.payrollRun.periodStart}|${candidate.payrollRun.periodEnd}`;
    const existing = yearBucket.regularByPeriod.get(key);
    if (!existing) {
      yearBucket.regularByPeriod.set(key, {
        id: candidate.payrollRun.id,
        status: candidate.status,
        createdAt: candidate.runCreatedTime,
      });
      return;
    }
    const score = candidate.status === "PAID" ? 2 : 1;
    const existingScore = existing.status === "PAID" ? 2 : 1;
    if (score > existingScore || (score === existingScore && candidate.runCreatedTime > existing.createdAt)) {
      yearBucket.regularByPeriod.set(key, {
        id: candidate.payrollRun.id,
        status: candidate.status,
        createdAt: candidate.runCreatedTime,
      });
    }
  });

  for (const row of normalized) {
    const yearBucket = totalsByYear[row.year];
    if (!yearBucket) continue;
    const eligible = normalized.filter((candidate) => {
      if (candidate.year !== row.year) return false;
      if (candidate.payrollRun.id === row.payrollRun.id) return true;
      if (candidate.periodEndTime >= row.periodEndTime) return false;
      if (candidate.runType === "ADJUSTMENT") {
        return candidate.status === "FINALIZED" || candidate.status === "PAID";
      }
      if (candidate.runType === "REGULAR") {
        const key = `${candidate.payrollRun.periodStart}|${candidate.payrollRun.periodEnd}`;
        return yearBucket.regularByPeriod.get(key)?.id === candidate.payrollRun.id;
      }
      return false;
    });

    const totals = eligible.reduce(
      (acc, candidate) => {
        const gross = Number(candidate.grossPay || 0);
        const net = Number(candidate.netPay || 0);
        const tax = Number(candidate.lineItems?.tax || 0);
        const pension = Number(candidate.lineItems?.pension || 0);
        const deductions = Number(candidate.lineItems?.deductions ?? Math.max(0, gross - net));
        return {
          gross: acc.gross + gross,
          net: acc.net + net,
          deductions: acc.deductions + deductions,
          tax: acc.tax + tax,
          pension: acc.pension + pension,
        };
      },
      { gross: 0, net: 0, deductions: 0, tax: 0, pension: 0 }
    );
    yearBucket.rows[row.id] = totals;
  }

  return totalsByYear;
}

export default function EmployeePaystubsPage() {
  const params = useParams();
  const employeeId = useMemo(() => String(params?.id ?? ""), [params]);

  const { data: employeeData } = useQuery({
    queryKey: ["admin", "hr", "employee", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: payslipsData } = useQuery({
    queryKey: ["admin", "hr", "payslips", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/payslips?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const employee = employeeData as EmployeeDetail | undefined;
  const rows = Array.isArray(payslipsData?.rows) ? (payslipsData.rows as PayslipRow[]) : [];
  const sortedRows = [...rows].sort((a, b) => {
    const aPeriod = a.payrollRun?.periodEnd ? new Date(a.payrollRun.periodEnd).getTime() : 0;
    const bPeriod = b.payrollRun?.periodEnd ? new Date(b.payrollRun.periodEnd).getTime() : 0;
    if (aPeriod !== bPeriod) return bPeriod - aPeriod;
    const aCreated = a.payrollRun?.createdAt ? new Date(a.payrollRun.createdAt).getTime() : 0;
    const bCreated = b.payrollRun?.createdAt ? new Date(b.payrollRun.createdAt).getTime() : 0;
    if (aCreated !== bCreated) return bCreated - aCreated;
    return a.id.localeCompare(b.id);
  });
  const fallbackEmployee = rows[0]?.employee;
  const employeeName =
    employee ? `${employee.firstName} ${employee.lastName}` : fallbackEmployee
      ? `${fallbackEmployee.firstName} ${fallbackEmployee.lastName}`
      : "Employee";
  const ytd = buildYtd(sortedRows);

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Paystubs</h1>
          <p className="text-muted-foreground">{employeeName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            Print
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/hr/compensation">Back to compensation</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Paystub History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Current Gross</TableHead>
                <TableHead>Current Net</TableHead>
                <TableHead>Current Tax</TableHead>
                <TableHead>Current Pension</TableHead>
                <TableHead>YTD Gross</TableHead>
                <TableHead>YTD Net</TableHead>
                <TableHead>YTD Tax</TableHead>
                <TableHead>YTD Pension</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Print</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-center text-sm text-muted-foreground">
                    No paystubs yet.
                  </TableCell>
                </TableRow>
              ) : (
                sortedRows.map((row) => {
                  const year = new Date(row.payrollRun.periodEnd).getFullYear();
                  const ytdRow = ytd[year]?.rows[row.id];
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        {new Date(row.payrollRun.periodStart).toLocaleDateString()} -{" "}
                        {new Date(row.payrollRun.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{formatCurrency(Number(row.grossPay || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.netPay || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.lineItems?.tax || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.lineItems?.pension || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(ytdRow?.gross || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(ytdRow?.net || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(ytdRow?.tax || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(ytdRow?.pension || 0))}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/hr/payroll/${row.payrollRun.id}`}>View</Link>
                        </Button>
                      </TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="secondary">
                          <Link href={`/admin/hr/paystubs/${row.id}`}>Print</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
