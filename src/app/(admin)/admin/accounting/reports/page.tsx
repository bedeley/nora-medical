"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClientQuery } from "@/hooks/use-client-query";
import { toast } from "sonner";

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

// Clickable report card — full card is the link
function ReportCard({
  title,
  description,
  whenToUse,
  href,
}: {
  title: string;
  description: string;
  whenToUse: string;
  href: string;
}) {
  return (
    <Link href={href} className="group block h-full">
      <Card className="h-full transition-colors hover:border-foreground/30 hover:bg-muted/30">
        <CardContent className="p-4 space-y-1.5">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground leading-snug">{description}</p>
          <p className="text-[11px] text-muted-foreground/70 italic leading-snug">{whenToUse}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

// Section group with label and responsive grid
function SectionGroup({
  title,
  cols = 3,
  children,
}: {
  title: string;
  cols?: 2 | 3;
  children: React.ReactNode;
}) {
  const colClass = cols === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest px-0.5">
        {title}
      </h2>
      <div className={`grid gap-3 ${colClass}`}>{children}</div>
    </div>
  );
}

export default function AccountingReportsPage() {
  const [exporting, setExporting] = useState(false);

  const { data: periodsData, isLoading: periodsLoading } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });

  const currentPeriod = Array.isArray(periodsData)
    ? periodsData
        .filter((p) => p.status === "OPEN")
        .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())[0]
    : undefined;

  const handlePackExport = async () => {
    if (!currentPeriod) {
      toast.error("No open fiscal period found to export.");
      return;
    }
    try {
      setExporting(true);
      const start = currentPeriod.startDate.slice(0, 10);
      const end = currentPeriod.endDate.slice(0, 10);
      const res = await fetch(
        `/api/admin/accounting/reports/pack/export?start=${start}&end=${end}&asOf=${end}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "Export failed.");
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `reporting-pack-${currentPeriod.name.replace(/\s+/g, "-").toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast.success(`Pack exported for ${currentPeriod.name}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Ledger-backed financial statements and compliance reports.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Current period badge */}
          {periodsLoading ? (
            <span className="inline-block h-7 w-36 rounded-md bg-muted animate-pulse" />
          ) : currentPeriod ? (
            <span className="text-xs text-muted-foreground border rounded-md px-2.5 py-1.5 leading-none">
              Period:{" "}
              <span className="font-medium text-foreground">{currentPeriod.name}</span>
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">
                open
              </span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground border rounded-md px-2.5 py-1.5 leading-none">
              No open period
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handlePackExport}
            disabled={exporting || periodsLoading || !currentPeriod}
            title={
              !currentPeriod
                ? "No open fiscal period — cannot export"
                : `Export P&L, Balance Sheet, and Trial Balance for ${currentPeriod.name}`
            }
          >
            {exporting ? (
              <>
                <svg
                  className="mr-1.5 h-3 w-3 animate-spin"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M6 1v2M6 9v2M1 6h2M9 6h2" strokeLinecap="round" />
                </svg>
                Exporting…
              </>
            ) : (
              <>
                <svg
                  className="mr-1.5 h-3 w-3"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 1v7M3 5l3 3 3-3M1 10h10" />
                </svg>
                Export all reports
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Report groups */}
      <div className="space-y-7">
        <SectionGroup title="Financial Statements">
          <ReportCard
            title="Profit & Loss"
            description="Revenue minus expenses for a date range. Shows gross profit, operating profit, and net income by account."
            whenToUse="Monthly performance review and period comparison."
            href="/admin/accounting/reports/pl"
          />
          <ReportCard
            title="Balance Sheet"
            description="Assets, liabilities, and equity at a point in time. Includes retained earnings."
            whenToUse="Snapshot of financial position — use before or after period close."
            href="/admin/accounting/reports/balance-sheet"
          />
          <ReportCard
            title="Trial Balance"
            description="All account debit and credit totals for a date range. Debits must equal credits."
            whenToUse="Verify ledger integrity and spot unbalanced entries before closing a period."
            href="/admin/accounting/reports/trial-balance"
          />
        </SectionGroup>

        <SectionGroup title="Tax & Compliance" cols={2}>
          <ReportCard
            title="VAT Report"
            description="Output VAT collected minus input VAT paid for the period. Broken down by tax code."
            whenToUse="Calculate your GRA filing liability and prepare for submission."
            href="/admin/accounting/reports/vat"
          />
          <ReportCard
            title="VAT Filings"
            description="Saved VAT filing snapshots with submission status and export history."
            whenToUse="Review past filings, download records, or confirm a submission was captured."
            href="/admin/accounting/vat-filings"
          />
        </SectionGroup>

        <SectionGroup title="Operational & Automation" cols={2}>
          <ReportCard
            title="Order Discounts"
            description="Discount amount broken down by order, staff member, and reason code."
            whenToUse="Analyse discount patterns and monitor revenue leakage over time."
            href="/admin/accounting/reports/order-discounts"
          />
          <ReportCard
            title="Scheduled Reports"
            description="Configure automated report exports to run on a recurring schedule."
            whenToUse="Set up hands-free monthly exports for management packs or compliance archives."
            href="/admin/accounting/reports/scheduled"
          />
        </SectionGroup>
      </div>

      {/* Pack export footnote */}
      <p className="text-[11px] text-muted-foreground">
        &quot;Export all reports&quot; downloads P&amp;L, Balance Sheet, and Trial Balance as a single CSV
        for the current open period. For custom date ranges, open each report individually.
      </p>
    </section>
  );
}
