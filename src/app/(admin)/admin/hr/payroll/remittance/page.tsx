"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";
import {
  buildGraPayeFilingCsvRows,
  buildMonthlyRemittanceCsvRows,
  buildPayeScheduleCsvRows,
  buildSsnitFilingCsvRows,
  buildSsnitScheduleCsvRows,
} from "@/lib/hr-payroll-remittance-csv";

type MonthlyStatutorySummary = {
  monthKey: string;
  periodStart: string;
  periodEnd: string;
  runCount: number;
  payslipCount: number;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  otherDeductions: number;
  employeeBreakdown: Array<{
    payrollRunId: string;
    employeeId: string;
    employeeName: string;
    email: string | null;
    department: string | null;
    position: string | null;
    grossPay: number;
    payeTax: number;
    ssnitEmployee: number;
    ssnitEmployer: number;
    ssnitTotal: number;
  }>;
  remittancePolicy?: {
    requireReference?: boolean;
  };
  remittance: {
    payeStatus: "PENDING" | "REMITTED";
    ssnitStatus: "PENDING" | "REMITTED";
    payeRemittedAt: string | null;
    ssnitRemittedAt: string | null;
    payePaymentMethod: "BANK" | "CASH" | null;
    ssnitPaymentMethod: "BANK" | "CASH" | null;
    payeReference: string | null;
    ssnitReference: string | null;
    notes: string | null;
    updatedBy: string | null;
    updatedByLabel?: string | null;
    updatedAt: string | null;
  };
};

type MonthlyStatutoryRegisterResponse = {
  rows: MonthlyStatutorySummary[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function PayrollRemittanceRegisterPage() {
  const queryClient = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [month, setMonth] = useState((new Date().getMonth() + 1).toString());
  const [updatingKind, setUpdatingKind] = useState<"PAYE" | "SSNIT" | null>(null);
  const [payeRemitDate, setPayeRemitDate] = useState("");
  const [payeReference, setPayeReference] = useState("");
  const [ssnitRemitDate, setSsnitRemitDate] = useState("");
  const [ssnitReference, setSsnitReference] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<{ kind: "PAYE" | "SSNIT"; status: "PENDING" | "REMITTED" } | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"BANK" | "CASH" | "">("");
  const [recentMonthsExpanded, setRecentMonthsExpanded] = useState(false);

  const yearNum = Number(year);
  const monthNum = Number(month);
  const queryEnabled =
    Number.isFinite(yearNum) &&
    yearNum >= 2000 &&
    yearNum <= 2100 &&
    Number.isFinite(monthNum) &&
    monthNum >= 1 &&
    monthNum <= 12;

  const summaryQuery = useQuery({
    queryKey: ["admin", "hr", "payroll", "remittance", "summary", year, month],
    queryFn: () => fetcher(`/api/admin/hr/payroll/statutory/summary?year=${year}&month=${month}`),
    enabled: queryEnabled,
  });

  const registerQuery = useQuery({
    queryKey: ["admin", "hr", "payroll", "remittance", "register"],
    queryFn: () => fetcher("/api/admin/hr/payroll/statutory/register?months=12"),
  });

  const summary = summaryQuery.data as MonthlyStatutorySummary | undefined;
  const rows = useMemo(
    () =>
      Array.isArray((registerQuery.data as MonthlyStatutoryRegisterResponse | undefined)?.rows)
        ? ((registerQuery.data as MonthlyStatutoryRegisterResponse).rows as MonthlyStatutorySummary[])
        : [],
    [registerQuery.data],
  );

  const monthKey = summary?.monthKey || `${year}-${String(month).padStart(2, "0")}`;
  const requireRemittanceReference = summary?.remittancePolicy?.requireReference === true;
  const remittanceAuditHref = `/admin/audit?sourcePage=admin%2Fhr%2Fpayroll%2Fremittance&entityType=HRPayrollRemittance&entityId=${encodeURIComponent(monthKey)}`;
  const noFinalizedPayroll = Boolean(summary) && Number(summary?.runCount || 0) <= 0;
  const employeeTotals = useMemo(() => {
    const breakdown = Array.isArray(summary?.employeeBreakdown) ? summary.employeeBreakdown : [];
    return breakdown.reduce(
      (acc, row) => {
        acc.gross += Number(row.grossPay || 0);
        acc.paye += Number(row.payeTax || 0);
        acc.ssnitEmployee += Number(row.ssnitEmployee || 0);
        acc.ssnitEmployer += Number(row.ssnitEmployer || 0);
        return acc;
      },
      { gross: 0, paye: 0, ssnitEmployee: 0, ssnitEmployer: 0 },
    );
  }, [summary?.employeeBreakdown]);
  const daysPendingAfterMonthEnd = useMemo(() => {
    if (!summary || noFinalizedPayroll) return 0;
    if (summary.remittance?.payeStatus !== "PENDING" || summary.remittance?.ssnitStatus !== "PENDING") return 0;
    const endDate = new Date(summary.periodEnd);
    if (!Number.isFinite(endDate.getTime())) return 0;
    const now = new Date();
    const days = Math.floor((now.getTime() - endDate.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, days);
  }, [summary, noFinalizedPayroll]);
  const lastRemittanceAction = useMemo(() => {
    if (!summary?.remittance) return null;
    const payeAt = summary.remittance.payeRemittedAt ? new Date(summary.remittance.payeRemittedAt) : null;
    const ssnitAt = summary.remittance.ssnitRemittedAt ? new Date(summary.remittance.ssnitRemittedAt) : null;
    const updatedAt = summary.remittance.updatedAt ? new Date(summary.remittance.updatedAt) : null;
    let liability = "Remittance";
    let actionTime = updatedAt;
    if (payeAt && (!ssnitAt || payeAt.getTime() >= ssnitAt.getTime())) {
      liability = "PAYE";
      actionTime = payeAt;
    } else if (ssnitAt) {
      liability = "SSNIT";
      actionTime = ssnitAt;
    }
    if (!actionTime || !Number.isFinite(actionTime.getTime())) return null;
    return {
      liability,
      actor: summary.remittance.updatedByLabel || summary.remittance.updatedBy || "System",
      at: actionTime.toLocaleString(),
    };
  }, [summary]);

  useEffect(() => {
    setPayeRemitDate("");
    setPayeReference("");
    setSsnitRemitDate("");
    setSsnitReference("");
    setNotes("");
  }, [year, month]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("hr-payroll-remittance-recent-months-expanded");
    if (saved === "true") setRecentMonthsExpanded(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "hr-payroll-remittance-recent-months-expanded",
      recentMonthsExpanded ? "true" : "false",
    );
  }, [recentMonthsExpanded]);

  const refreshData = async () => {
    await Promise.all([summaryQuery.refetch(), registerQuery.refetch()]);
    toast.success("Remittance data refreshed.");
  };

  const downloadMonthlySummaryCsv = () => {
    if (!summary) {
      toast.error("No monthly remittance summary is available yet.");
      return;
    }
    const rows = buildMonthlyRemittanceCsvRows(summary);
    void downloadCsv(
      rows,
      `payroll-remittance-${monthKey}.csv`,
      "Monthly remittance summary CSV downloaded.",
      "MONTHLY_SUMMARY",
    );
  };

  const downloadCsv = async (
    rows: string[][],
    filename: string,
    successMessage: string,
    liability: "PAYE" | "SSNIT" | "MONTHLY_SUMMARY",
    includeTraceHeader = true,
  ) => {
    const fileRows = includeTraceHeader
      ? [["Report month", "Exported at"], [monthKey, new Date().toISOString()], [], ...rows]
      : rows;
    const escapeCell = (value: string) => {
      const text = String(value ?? "");
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
      return text;
    };
    const csv = fileRows.map((row) => row.map(escapeCell).join(",")).join("\n");
    const lineCount = fileRows.length;
    const maxColumns = fileRows.reduce((max, row) => Math.max(max, row.length), 0);
    const byteSize = new TextEncoder().encode(csv).length;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(successMessage);
    try {
      await fetch("/api/admin/hr/payroll/statutory/export-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthKey,
          liability,
          fileName: filename,
          format: "csv",
          rowCount: lineCount,
          columnCount: maxColumns,
          byteSize,
          scopeSnapshot: `month=${monthKey}; liability=${liability}`,
          sourcePage: "admin/hr/payroll/remittance",
        }),
      });
    } catch {
      // best-effort audit logging only
    }
  };

  const downloadPayeScheduleCsv = () => {
    const breakdown = Array.isArray(summary?.employeeBreakdown) ? summary.employeeBreakdown : [];
    if (breakdown.length === 0) {
      toast.error("No employee PAYE schedule is available for this month.");
      return;
    }
    void downloadCsv(
      buildPayeScheduleCsvRows(breakdown),
      `paye-schedule-${monthKey}.csv`,
      "PAYE employee schedule CSV downloaded.",
      "PAYE",
    );
  };

  const downloadSsnitScheduleCsv = () => {
    const breakdown = Array.isArray(summary?.employeeBreakdown) ? summary.employeeBreakdown : [];
    if (breakdown.length === 0) {
      toast.error("No employee SSNIT schedule is available for this month.");
      return;
    }
    void downloadCsv(
      buildSsnitScheduleCsvRows(breakdown),
      `ssnit-schedule-${monthKey}.csv`,
      "SSNIT employee schedule CSV downloaded.",
      "SSNIT",
    );
  };

  const downloadGraPayeFilingCsv = () => {
    const breakdown = Array.isArray(summary?.employeeBreakdown) ? summary.employeeBreakdown : [];
    if (breakdown.length === 0) {
      toast.error("No PAYE filing schedule is available for this month.");
      return;
    }
    void downloadCsv(
      buildGraPayeFilingCsvRows(breakdown),
      `gra-paye-filing-${monthKey}.csv`,
      "GRA PAYE filing CSV downloaded.",
      "PAYE",
      false,
    );
  };

  const downloadSsnitFilingCsv = () => {
    const breakdown = Array.isArray(summary?.employeeBreakdown) ? summary.employeeBreakdown : [];
    if (breakdown.length === 0) {
      toast.error("No SSNIT filing schedule is available for this month.");
      return;
    }
    void downloadCsv(
      buildSsnitFilingCsvRows(breakdown),
      `ssnit-filing-${monthKey}.csv`,
      "SSNIT filing CSV downloaded.",
      "SSNIT",
      false,
    );
  };

  const copyReference = async (value: string | null, label: "PAYE" | "SSNIT") => {
    const text = String(value || "").trim();
    if (!text) {
      toast.error(`${label} reference is empty.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} reference copied.`);
    } catch {
      toast.error("Failed to copy reference.");
    }
  };

  const updateStatus = async (
    kind: "PAYE" | "SSNIT",
    status: "PENDING" | "REMITTED",
    method?: "BANK" | "CASH",
  ) => {
    if (!queryEnabled) {
      toast.error("Enter a valid month.");
      return;
    }
    try {
      setUpdatingKind(kind);
      const reference = kind === "PAYE" ? payeReference.trim() : ssnitReference.trim();
      const remittedAtRaw = kind === "PAYE" ? payeRemitDate : ssnitRemitDate;
      const remittedAtIso = remittedAtRaw ? new Date(`${remittedAtRaw}T12:00:00`).toISOString() : undefined;
      const res = await fetch("/api/admin/hr/payroll/statutory/summary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: yearNum,
          month: monthNum,
          kind,
          status,
          paymentMethod: status === "REMITTED" ? method : undefined,
          remittedAt: remittedAtIso,
          reference: reference || undefined,
          notes: notes.trim() || undefined,
          sourcePage: "admin/hr/payroll/remittance",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || `Failed to update ${kind} remittance status.`);
        return;
      }
      toast.success(`${kind} remittance status updated to ${status.toLowerCase()}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", "remittance", "summary"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", "remittance", "register"] }),
      ]);
    } catch (error) {
      console.error(error);
      toast.error(`Failed to update ${kind} remittance status.`);
    } finally {
      setUpdatingKind(null);
    }
  };

  const requestStatusUpdate = (kind: "PAYE" | "SSNIT") => {
    setPendingUpdate({ kind, status: "REMITTED" });
    setPaymentMethod("");
    setConfirmOpen(true);
  };

  const handleConfirmPending = async () => {
    if (!pendingUpdate) return;
    if (pendingUpdate.status === "REMITTED" && !paymentMethod) {
      toast.error("Select whether remittance is paid via bank or cash.");
      return;
    }
    const next = pendingUpdate;
    const selectedMethod = next.status === "REMITTED" ? paymentMethod : undefined;
    setPendingUpdate(null);
    setConfirmOpen(false);
    await updateStatus(next.kind, next.status, selectedMethod === "" ? undefined : selectedMethod);
    setPaymentMethod("");
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Payroll Remittance Register</h1>
          <p className="text-muted-foreground">Manage PAYE and SSNIT remittance status month by month.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/hr/compensation">Back to Compensation</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={remittanceAuditHref}>View remittance audit</Link>
          </Button>
          <Tooltip content="Download a one-file summary for this month: totals, statuses, and key remittance fields.">
            <Button variant="outline" onClick={downloadMonthlySummaryCsv} disabled={!summary}>
              Download month CSV
            </Button>
          </Tooltip>
          <Tooltip content="Internal employee-by-employee PAYE schedule for review and reconciliation.">
            <Button variant="outline" onClick={downloadPayeScheduleCsv} disabled={!summary || noFinalizedPayroll}>
              Export PAYE schedule
            </Button>
          </Tooltip>
          <Tooltip content="Internal employee-by-employee SSNIT schedule (employee and employer split).">
            <Button variant="outline" onClick={downloadSsnitScheduleCsv} disabled={!summary || noFinalizedPayroll}>
              Export SSNIT schedule
            </Button>
          </Tooltip>
          <Tooltip content="Filing-oriented PAYE export for GRA submission workflow.">
            <Button variant="outline" onClick={downloadGraPayeFilingCsv} disabled={!summary || noFinalizedPayroll}>
              Export GRA PAYE file
            </Button>
          </Tooltip>
          <Tooltip content="Filing-oriented SSNIT export for statutory remittance submission workflow.">
            <Button variant="outline" onClick={downloadSsnitFilingCsv} disabled={!summary || noFinalizedPayroll}>
              Export SSNIT filing file
            </Button>
          </Tooltip>
          <Button variant="outline" onClick={refreshData}>
            Refresh data
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Selected Month</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 w-28" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
            <Select value={month} onValueChange={setMonth}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, i) => (
                  <SelectItem key={String(i + 1)} value={String(i + 1)}>
                    {new Date(2000, i, 1).toLocaleString(undefined, { month: "long" })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Runs / Payslips / Employees</div>
              <div className="font-medium">
                {Number(summary?.runCount || 0)} / {Number(summary?.payslipCount || 0)} / {Number(summary?.employeeCount || 0)}
              </div>
            </div>
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Gross / Net</div>
              <div className="font-medium">
                {formatCurrency(Number(summary?.totalGross || 0))} / {formatCurrency(Number(summary?.totalNet || 0))}
              </div>
            </div>
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Other deductions</div>
              <div className="font-medium">{formatCurrency(Number(summary?.otherDeductions || 0))}</div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Last updated:{" "}
            {summary?.remittance?.updatedAt ? new Date(summary.remittance.updatedAt).toLocaleString() : "Not available"}
            {" | "}
            Updated by: {summary?.remittance?.updatedByLabel || summary?.remittance?.updatedBy || "System"}
          </div>
          <div className="text-xs text-muted-foreground">
            Remittance reference policy: {requireRemittanceReference ? "Required" : "Optional"}
          </div>
          {lastRemittanceAction ? (
            <div className="inline-flex rounded border bg-muted px-2 py-1 text-xs text-muted-foreground">
              Last remittance action: {lastRemittanceAction.liability} by {lastRemittanceAction.actor} at{" "}
              {lastRemittanceAction.at}
            </div>
          ) : null}
          {noFinalizedPayroll ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Remittance actions are read-only for this month because no finalized payroll run was found.
              Finalize payroll first on Compensation and Payroll, then return here to mark PAYE/SSNIT as remitted.
              You can still review totals and export schedule files for this month.
            </div>
          ) : null}
          {!noFinalizedPayroll && daysPendingAfterMonthEnd > 14 ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Both PAYE and SSNIT are still pending {daysPendingAfterMonthEnd} day(s) after month-end.
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Liability</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Remitted at</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>PAYE tax</TableCell>
                <TableCell>{formatCurrency(Number(summary?.payeTax || 0))}</TableCell>
                <TableCell>{summary?.remittance?.payeStatus || "PENDING"}</TableCell>
                <TableCell>
                  {summary?.remittance?.payeRemittedAt ? new Date(summary.remittance.payeRemittedAt).toLocaleString() : "-"}
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span>{summary?.remittance?.payeReference || "-"}</span>
                      {summary?.remittance?.payeReference ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => copyReference(summary.remittance.payeReference, "PAYE")}
                        >
                          Copy
                        </Button>
                      ) : null}
                    </div>
                    {summary?.remittance?.payeReference ? (
                      <p className="text-[11px] text-muted-foreground">Copies PAYE payment reference.</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => requestStatusUpdate("PAYE")}
                      disabled={
                        updatingKind !== null ||
                        noFinalizedPayroll ||
                        Number(summary?.payeTax || 0) <= 0 ||
                        summary?.remittance?.payeStatus === "REMITTED"
                      }
                    >
                      Mark remitted
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/accounting/journal?sourceType=PAYROLL&q=${encodeURIComponent(`STATUTORY:${monthKey}:PAYE`)}`}>
                        Open journal
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>SSNIT (employee + employer)</TableCell>
                <TableCell>
                  <div>{formatCurrency(Number(summary?.ssnitEmployee || 0) + Number(summary?.ssnitEmployer || 0))}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Employee {formatCurrency(Number(summary?.ssnitEmployee || 0))} + Employer{" "}
                    {formatCurrency(Number(summary?.ssnitEmployer || 0))}
                  </div>
                </TableCell>
                <TableCell>{summary?.remittance?.ssnitStatus || "PENDING"}</TableCell>
                <TableCell>
                  {summary?.remittance?.ssnitRemittedAt ? new Date(summary.remittance.ssnitRemittedAt).toLocaleString() : "-"}
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span>{summary?.remittance?.ssnitReference || "-"}</span>
                      {summary?.remittance?.ssnitReference ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => copyReference(summary.remittance.ssnitReference, "SSNIT")}
                        >
                          Copy
                        </Button>
                      ) : null}
                    </div>
                    {summary?.remittance?.ssnitReference ? (
                      <p className="text-[11px] text-muted-foreground">Copies SSNIT payment reference.</p>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => requestStatusUpdate("SSNIT")}
                      disabled={
                        updatingKind !== null ||
                        noFinalizedPayroll ||
                        Number(summary?.ssnitEmployee || 0) + Number(summary?.ssnitEmployer || 0) <= 0 ||
                        summary?.remittance?.ssnitStatus === "REMITTED"
                      }
                    >
                      Mark remitted
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/accounting/journal?sourceType=PAYROLL&q=${encodeURIComponent(`STATUTORY:${monthKey}:SSNIT`)}`}>
                        Open journal
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input type="date" value={payeRemitDate} onChange={(e) => setPayeRemitDate(e.target.value)} placeholder="PAYE remittance date" />
            <Input value={payeReference} onChange={(e) => setPayeReference(e.target.value)} placeholder="PAYE payment reference" />
            <Input type="date" value={ssnitRemitDate} onChange={(e) => setSsnitRemitDate(e.target.value)} placeholder="SSNIT remittance date" />
            <Input value={ssnitReference} onChange={(e) => setSsnitReference(e.target.value)} placeholder="SSNIT payment reference" />
          </div>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for audit (optional)" />
          <p className="text-xs text-muted-foreground">
            Guardrail: remittance cannot be marked as remitted unless the month has finalized payroll and statutory amount due.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Month Reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(() => {
            const scheduledPaye = Number(summary?.payeTax || 0);
            const scheduledSsnit = Number(summary?.ssnitEmployee || 0) + Number(summary?.ssnitEmployer || 0);
            const remittedPaye = summary?.remittance?.payeStatus === "REMITTED" ? scheduledPaye : 0;
            const remittedSsnit = summary?.remittance?.ssnitStatus === "REMITTED" ? scheduledSsnit : 0;
            const variance = Number((scheduledPaye + scheduledSsnit - (remittedPaye + remittedSsnit)).toFixed(2));
            return (
              <>
                <div>Scheduled total: {formatCurrency(scheduledPaye + scheduledSsnit)}</div>
                <div>Marked remitted total: {formatCurrency(remittedPaye + remittedSsnit)}</div>
                <div>Variance: {formatCurrency(variance)}</div>
                {variance !== 0 ? (
                  <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    Reconciliation warning: remitted total does not yet match scheduled statutory total.
                  </div>
                ) : (
                  <div className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                    Reconciliation ok: remitted total matches scheduled statutory total.
                  </div>
                )}
              </>
            );
          })()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Employee Statutory Schedule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            This schedule shows who statutory remittance is for, including PAYE and SSNIT employee/employer splits.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>PAYE</TableHead>
                <TableHead>SSNIT (employee)</TableHead>
                <TableHead>SSNIT (employer)</TableHead>
                <TableHead>SSNIT total</TableHead>
                <TableHead>Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(summary?.employeeBreakdown || []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    No employee statutory schedule for this month yet.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {(summary?.employeeBreakdown || []).map((row) => (
                    <TableRow key={row.employeeId}>
                      <TableCell>
                        <div className="font-medium">{row.employeeName}</div>
                        <div className="text-xs text-muted-foreground">{row.email || row.employeeId}</div>
                      </TableCell>
                      <TableCell>{formatCurrency(Number(row.grossPay || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.payeTax || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.ssnitEmployee || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.ssnitEmployer || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(row.ssnitTotal || 0))}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/hr/staff/${row.employeeId}`}>Employee</Link>
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/hr/payroll/${row.payrollRunId}?employeeId=${encodeURIComponent(row.employeeId)}`}>
                              Payslip month
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/40 font-medium">
                    <TableCell>Total</TableCell>
                    <TableCell>{formatCurrency(employeeTotals.gross)}</TableCell>
                    <TableCell>{formatCurrency(employeeTotals.paye)}</TableCell>
                    <TableCell>{formatCurrency(employeeTotals.ssnitEmployee)}</TableCell>
                    <TableCell>{formatCurrency(employeeTotals.ssnitEmployer)}</TableCell>
                    <TableCell>{formatCurrency(employeeTotals.ssnitEmployee + employeeTotals.ssnitEmployer)}</TableCell>
                    <TableCell>-</TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
            setPendingUpdate(null);
            setPaymentMethod("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm remittance</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Confirm remittance and choose payment method for journal posting.
            </p>
            {requireRemittanceReference ? (
              <p className="text-xs text-amber-700">
                This month requires a payment reference before remittance can be marked as paid.
              </p>
            ) : null}
            <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as "BANK" | "CASH")}>
              <SelectTrigger>
                <SelectValue placeholder="Choose payment method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BANK">Bank</SelectItem>
                <SelectItem value="CASH">Cash</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setConfirmOpen(false);
              setPendingUpdate(null);
              setPaymentMethod("");
            }} disabled={updatingKind !== null}>
              Cancel
            </Button>
            <Button onClick={handleConfirmPending} disabled={updatingKind !== null || !pendingUpdate}>
              {updatingKind ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Recent Months (12)</CardTitle>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRecentMonthsExpanded((current) => !current)}
            >
              {recentMonthsExpanded ? "Hide" : "Show"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className={recentMonthsExpanded ? undefined : "hidden"}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>PAYE</TableHead>
                <TableHead>SSNIT (Emp + Employer)</TableHead>
                <TableHead>PAYE status</TableHead>
                <TableHead>SSNIT status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No remittance data yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.monthKey}>
                    <TableCell>{row.monthKey}</TableCell>
                    <TableCell>{formatCurrency(Number(row.payeTax || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(row.ssnitEmployee || 0) + Number(row.ssnitEmployer || 0))}</TableCell>
                    <TableCell>{row.remittance?.payeStatus || "PENDING"}</TableCell>
                    <TableCell>{row.remittance?.ssnitStatus || "PENDING"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const [rowYear, rowMonth] = row.monthKey.split("-");
                            setYear(rowYear || year);
                            setMonth(String(Number(rowMonth || "1")));
                          }}
                        >
                          Load month
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/audit?sourcePage=admin%2Fhr%2Fpayroll%2Fremittance&entityType=HRPayrollRemittance&entityId=${encodeURIComponent(row.monthKey)}`}>
                            Audit
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
