"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { buildAdminAuditHref } from "@/lib/admin-audit-links";
import { ADMIN_PHONE } from "@/lib/config";
import { formatCurrency, formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  formatPaystubDateRange,
  getPaystubCurrentBreakdownRows,
  getPaystubPdfFileName,
  getPaystubRoleSummary,
  getPaystubYtdBreakdownRows,
  num,
  PAYSTUB_SOURCE_PAGE,
  type PaystubYtdTotals,
} from "@/lib/hr-paystub-utils";

type Payslip = {
  id: string;
  employeeId: string;
  payrollRunId: string;
  grossPay: number | string;
  netPay: number | string;
  lineItems?: Record<string, unknown> | null;
  createdAt: string;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string | null;
    department?: string | null;
    position?: string | null;
  };
  payrollRun: {
    id: string;
    periodStart: string;
    periodEnd: string;
    status: string;
    runType?: string | null;
  };
};

type PayslipResponse = {
  payslip: Payslip;
  ytdTotals: PaystubYtdTotals;
};

type AuditEntry = {
  id: string;
  action: string;
  createdAt: string;
  actor?: {
    id?: string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
  meta?: {
    resultSummary?: string;
    section?: string;
    operation?: string;
    status?: string;
    after?: {
      recipientEmail?: string;
      fileName?: string;
      byteSize?: number;
      delivery?: string;
    } | null;
  } | null;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body ? String(body.error) : "Request failed";
    throw new Error(message);
  }
  return body as T;
}

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function getPaystubAuditTitle(entry: AuditEntry) {
  const action = String(entry.action || "").trim().toUpperCase();
  if (action === "PAYSLIP_EMAIL") return "Paystub emailed";
  if (action === "PAYSLIP_PDF_DOWNLOAD") return "PDF downloaded";
  if (action === "PAYSLIP_PRINT") return "Paystub printed";
  if (action === "PAYSLIP_CREATE") return "Payslip created";
  return toPlainLabel(entry.meta?.operation) || toPlainLabel(entry.action) || "Paystub activity";
}

function getAuditBadgeVariant(status: string | null | undefined) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "FAILED" || normalized === "ERROR") return "destructive" as const;
  if (normalized === "SUCCESS") return "success" as const;
  return "outline" as const;
}

function getAuditBadgeLabel(status: string | null | undefined) {
  const normalized = String(status || "").trim().toUpperCase();
  if (!normalized) return "Recorded";
  if (normalized === "FAILED") return "Failed";
  if (normalized === "SUCCESS") return "Success";
  return toPlainLabel(normalized) || "Recorded";
}

function getActorLabel(entry: AuditEntry) {
  return entry.actor?.name || entry.actor?.email || "System";
}

function getDownloadFileName(headers: Headers, fallback: string) {
  const disposition = headers.get("content-disposition") || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
  if (plainMatch?.[1]) {
    return plainMatch[1];
  }
  return fallback;
}

function formatByteSize(value: unknown) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kilobytes = bytes / 1024;
    return `${kilobytes >= 10 ? kilobytes.toFixed(0) : kilobytes.toFixed(1)} KB`;
  }
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
}

function getAuditDetailChips(entry: AuditEntry) {
  const details: string[] = [];
  const after = entry.meta?.after;
  if (!after) return details;
  if (after.recipientEmail) details.push(`Recipient: ${after.recipientEmail}`);
  if (after.fileName) details.push(`File: ${after.fileName}`);
  const sizeLabel = formatByteSize(after.byteSize);
  if (sizeLabel) details.push(`Size: ${sizeLabel}`);
  if (after.delivery) details.push(`Channel: ${toPlainLabel(after.delivery)}`);
  return details;
}

export default function PaystubPrintPage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const payslipId = useMemo(() => String(params?.id ?? ""), [params]);
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [activeAction, setActiveAction] = useState<"email" | "download" | "print" | null>(null);

  const { data, isLoading, error } = useQuery<PayslipResponse>({
    queryKey: ["admin", "hr", "paystub", payslipId],
    queryFn: () => fetchJson(`/api/admin/hr/payslips/${payslipId}`),
    enabled: Boolean(payslipId),
  });

  const { data: auditRows, isLoading: activityLoading } = useQuery<AuditEntry[]>({
    queryKey: ["admin", "audit", "paystub-activity", payslipId],
    queryFn: () =>
      fetchJson(
        `/api/admin/audit?entityType=PAYSLIP&entityId=${encodeURIComponent(payslipId)}&limit=4`,
      ),
    enabled: Boolean(payslipId),
  });

  const payload = data;
  const payslip = payload?.payslip;
  const ytdTotals = payload?.ytdTotals;

  useEffect(() => {
    if (payslip?.employee?.email && !email) {
      setEmail(payslip.employee.email);
    }
  }, [payslip, email]);

  const currentRows = useMemo(
    () =>
      payslip
        ? getPaystubCurrentBreakdownRows({
            grossPay: payslip.grossPay,
            netPay: payslip.netPay,
            lineItems: payslip.lineItems,
          })
        : [],
    [payslip],
  );

  const ytdRows = useMemo(() => getPaystubYtdBreakdownRows(ytdTotals), [ytdTotals]);

  const auditHref = useMemo(
    () =>
      payslip
        ? buildAdminAuditHref({
            entityType: "PAYSLIP",
            entityId: payslip.id,
            sourcePage: PAYSTUB_SOURCE_PAGE,
          })
        : "/admin/audit",
    [payslip],
  );

  const periodLabel = payslip
    ? formatPaystubDateRange(payslip.payrollRun.periodStart, payslip.payrollRun.periodEnd)
    : "";
  const employeeName = payslip
    ? `${payslip.employee.firstName} ${payslip.employee.lastName}`.trim()
    : "";
  const runStatusLabel = toPlainLabel(payslip?.payrollRun.status) || "Unknown";
  const runTypeLabel = toPlainLabel(payslip?.payrollRun.runType) || "Regular";
  const isBusy = Boolean(activeAction);

  const refreshActivity = async () => {
    await queryClient.invalidateQueries({
      queryKey: ["admin", "audit", "paystub-activity", payslipId],
    });
  };

  const runAction = async (
    action: "email" | "download" | "print",
    operation: () => Promise<void>,
  ) => {
    setActiveAction(action);
    try {
      await operation();
    } finally {
      setActiveAction(null);
    }
  };

  const handleEmail = async () => {
    const targetEmail = email.trim();
    if (!targetEmail) {
      toast.error("Enter an email address.");
      return;
    }

    await runAction("email", async () => {
      try {
        const response = await fetch(`/api/admin/hr/payslips/${payslipId}/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: targetEmail }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          toast.error(body.error || "Failed to email the paystub.");
          return;
        }
        toast.success(`Paystub emailed to ${targetEmail}.`);
        setEmailOpen(false);
        await refreshActivity();
      } catch {
        toast.error("Failed to email the paystub.");
      }
    });
  };

  const handleDownloadPdf = async () => {
    if (!payslip) return;

    await runAction("download", async () => {
      try {
        const response = await fetch(`/api/admin/hr/payslips/${payslipId}/pdf`, {
          cache: "no-store",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          toast.error(body.error || "Failed to download the paystub PDF.");
          return;
        }

        const blob = await response.blob();
        const fileName = getDownloadFileName(
          response.headers,
          getPaystubPdfFileName(payslip.id),
        );
        const objectUrl = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(objectUrl);

        toast.success("Paystub PDF downloaded.");
        await refreshActivity();
      } catch {
        toast.error("Failed to download the paystub PDF.");
      }
    });
  };

  const handlePrint = async () => {
    await runAction("print", async () => {
      try {
        const response = await fetch(`/api/admin/hr/payslips/${payslipId}/print`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          toast.error(body.error || "Failed to record the print action.");
          return;
        }
        window.print();
        toast.success("Print dialog opened.");
        await refreshActivity();
      } catch {
        toast.error("Failed to record the print action.");
      }
    });
  };

  const handleCopyPaystubLink = async () => {
    const paystubUrl = typeof window !== "undefined" ? window.location.href : "";
    if (!paystubUrl) {
      toast.error("Failed to copy the paystub link.");
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(paystubUrl);
      } else {
        const input = document.createElement("textarea");
        input.value = paystubUrl;
        input.setAttribute("readonly", "true");
        input.style.position = "absolute";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      toast.success("Paystub link copied.");
    } catch {
      toast.error("Failed to copy the paystub link.");
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading paystub...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error.message}</p>;
  }

  if (!payslip) {
    return <p className="text-sm text-muted-foreground">Paystub not found.</p>;
  }

  return (
    <section className="space-y-6 print:mx-auto print:max-w-3xl print:space-y-4">
      <div className="rounded-3xl border bg-gradient-to-br from-white via-slate-50 to-emerald-50 p-4 shadow-sm dark:border-slate-800 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950/70 sm:p-6 print:hidden">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{runStatusLabel}</Badge>
              <Badge variant="outline">{runTypeLabel} run</Badge>
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Paystub</h1>
              <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                Review the official paystub, email it to the employee, download the PDF, or
                print a clean copy from one place.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="secondary">
                <Link href={`/admin/hr/payroll/${payslip.payrollRun.id}`}>Open payroll run</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/hr/staff/${payslip.employee.id}`}>Open employee profile</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={auditHref}>View full audit log</Link>
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" disabled={isBusy}>
                  Email
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Email paystub</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3">
                  <p className="text-sm text-muted-foreground">
                    Send the official PDF copy to the employee or another approved recipient.
                  </p>
                  <Input
                    type="email"
                    placeholder="employee@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleEmail} disabled={activeAction === "email"}>
                    {activeAction === "email" ? "Sending..." : "Send paystub"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button variant="outline" onClick={handleDownloadPdf} disabled={isBusy}>
              {activeAction === "download" ? "Downloading..." : "Download PDF"}
            </Button>
            <Button variant="outline" onClick={handleCopyPaystubLink} disabled={isBusy}>
              Copy link
            </Button>
            <Button onClick={handlePrint} disabled={isBusy}>
              {activeAction === "print" ? "Preparing..." : "Print"}
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border bg-white/90 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/85">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Employee</div>
            <div className="mt-2 font-medium text-slate-900 dark:text-slate-50">{employeeName}</div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {getPaystubRoleSummary(payslip.employee.position, payslip.employee.department)}
            </div>
          </div>
          <div className="rounded-2xl border bg-white/90 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/85">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Pay period</div>
            <div className="mt-2 font-medium text-slate-900 dark:text-slate-50">{periodLabel}</div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">Paystub ID: {payslip.id}</div>
          </div>
          <div className="rounded-2xl border bg-white/90 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/85">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Gross pay</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">
              {formatCurrency(num(payslip.grossPay))}
            </div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">Current period earnings</div>
          </div>
          <div className="rounded-2xl border bg-white/90 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/85">
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Net pay</div>
            <div className="mt-2 text-2xl font-semibold text-emerald-700">
              {formatCurrency(num(payslip.netPay))}
            </div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Created {formatDateGH(payslip.createdAt)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.95fr)]">
        <Card className="overflow-hidden print:rounded-none print:border-slate-300 print:shadow-none">
          <CardHeader className="border-b border-border bg-muted/40 print:border-slate-300 print:bg-white print:px-4 print:py-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <Image src="/logo.svg" alt="Noralls Medical Supplies" width={148} height={44} />
                <div>
                  <div className="hidden text-[10px] uppercase tracking-[0.2em] text-muted-foreground print:block">
                    Employee paystub
                  </div>
                  <CardTitle>Noralls Medical Supplies</CardTitle>
                  <p className="text-xs text-muted-foreground">Official paystub</p>
                </div>
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>Phone: {ADMIN_PHONE}</div>
                <div>Paystub ID: {payslip.id}</div>
                <div>Run status: {runStatusLabel}</div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 p-5 text-sm sm:p-6 print:space-y-4 print:p-4 print:text-black">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border bg-card p-4 print:rounded-none print:border-slate-300 print:p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Employee</div>
                <div className="mt-2 text-base font-semibold text-foreground">{employeeName}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {getPaystubRoleSummary(payslip.employee.position, payslip.employee.department)}
                </div>
                <div className="mt-3 text-sm text-foreground/85">
                  {payslip.employee.email || "No employee email on file"}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4 print:rounded-none print:border-slate-300 print:p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Payroll run
                </div>
                <div className="mt-2 text-base font-semibold text-foreground">{periodLabel}</div>
                <div className="mt-1 text-sm text-muted-foreground">{runTypeLabel} run</div>
                <div className="mt-3 text-sm text-foreground/85">
                  Created on {formatDateTimeGH(payslip.createdAt)}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-border bg-muted/40 p-4 print:rounded-none print:border-slate-300 print:bg-white print:p-3">
                <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
                  Current period
                </div>
                <div className="space-y-3">
                  {currentRows.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-b-0 last:pb-0"
                    >
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(row.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-border bg-muted/40 p-4 print:rounded-none print:border-slate-300 print:bg-white print:p-3">
                <div className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
                  Year to date
                </div>
                <div className="space-y-3">
                  {ytdRows.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-b-0 last:pb-0"
                    >
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-medium text-foreground">
                        {formatCurrency(row.value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 text-xs text-muted-foreground dark:border-emerald-900/70 dark:bg-emerald-950/30 print:rounded-none print:border-slate-300 print:bg-white print:px-0 print:py-3">
              This paystub is confidential and intended for the employee named above.
            </div>
          </CardContent>
        </Card>

        <Card className="print:hidden">
          <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Recent paystub activity</CardTitle>
              <p className="text-sm text-muted-foreground">
                Review recent email, download, print, and paystub creation activity.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={auditHref}>View full audit log</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {activityLoading ? (
              <p className="text-sm text-muted-foreground">Loading paystub activity...</p>
            ) : auditRows && auditRows.length > 0 ? (
              auditRows.map((entry) => (
                <div key={entry.id} className="rounded-2xl border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-foreground">{getPaystubAuditTitle(entry)}</div>
                    <Badge variant={getAuditBadgeVariant(entry.meta?.status)}>
                      {getAuditBadgeLabel(entry.meta?.status)}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {entry.meta?.resultSummary || "Activity recorded for this paystub."}
                  </p>
                  {getAuditDetailChips(entry).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {getAuditDetailChips(entry).map((detail) => (
                        <span
                          key={detail}
                          className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
                        >
                          {detail}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{getActorLabel(entry)}</span>
                    <span>{formatDateTimeGH(entry.createdAt)}</span>
                    {entry.meta?.section ? <span>{toPlainLabel(entry.meta.section)}</span> : null}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No paystub activity has been recorded yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
