"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import type { ReportingReconciliationReport } from "@/lib/reporting-reconciliation";

type Props = {
  report: ReportingReconciliationReport | null;
  loading?: boolean;
  title?: string;
  description?: string;
};

function formatDelta(row: ReportingReconciliationReport["rows"][number]) {
  const deltaLabel = `${row.delta >= 0 ? "+" : ""}${formatCurrency(row.delta)}`;
  if (row.percentDelta == null) return deltaLabel;
  return `${deltaLabel} (${row.percentDelta >= 0 ? "+" : ""}${row.percentDelta.toFixed(1)}%)`;
}

export default function ReportingReconciliationPanel({
  report,
  loading = false,
  title = "Ledger Alignment",
  description = "Compares operational and posted-ledger financial metrics for the same filters and flags material drift automatically.",
}: Props) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="rounded-md border p-4 text-sm text-muted-foreground">
            Loading ledger-to-operational reconciliation...
          </div>
        ) : !report ? (
          <div className="rounded-md border p-4 text-sm text-muted-foreground">
            Reconciliation becomes available once both ledger and operational summaries load.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline" className="text-emerald-700">
                {report.alignedCount} aligned
              </Badge>
              <Badge variant="outline" className="text-amber-700">
                {report.withinToleranceCount} within GH₵1
              </Badge>
              <Badge variant="outline" className={report.reviewCount > 0 ? "text-red-700" : "text-emerald-700"}>
                {report.reviewCount} require review
              </Badge>
              <span className="text-muted-foreground">
                Max delta {formatCurrency(report.maxAbsoluteDelta)}
              </span>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              {report.rows.map((row) => (
                <div key={row.key} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{row.label}</div>
                    <Badge
                      variant="outline"
                      className={
                        row.status === "review"
                          ? "text-red-700"
                          : row.status === "within_tolerance"
                            ? "text-amber-700"
                            : "text-emerald-700"
                      }
                    >
                      {row.status === "review"
                        ? "Review"
                        : row.status === "within_tolerance"
                          ? "Within GH₵1"
                          : "Aligned"}
                    </Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Operational</div>
                      <div className="font-medium text-foreground">{formatCurrency(row.operational)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Ledger</div>
                      <div className="font-medium text-foreground">{formatCurrency(row.ledger)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Delta</div>
                      <div className={row.status === "review" ? "font-medium text-red-600" : "font-medium text-foreground"}>
                        {formatDelta(row)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
