"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { buildRetryTargets, explainPostingFailure, summarizeAgingBuckets, type RetryTarget } from "@/lib/accounting-integrity";

const fmt = (v?: number) => formatCurrency(Math.abs(v ?? 0) < 0.01 ? 0 : v ?? 0);
const toCsvCell = (value: unknown) => {
  const raw = String(value ?? "");
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
  return raw;
};
const ageDaysSince = (createdAt: string) => {
  const ms = new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
};
const renderAgeBadge = (createdAt: string) => {
  const days = ageDaysSince(createdAt);
  if (days >= 8) return <Badge variant="destructive">{days}d overdue</Badge>;
  if (days >= 3) return <Badge variant="warning">{days}d aging</Badge>;
  return <Badge variant="success">{days}d</Badge>;
};
const INTEGRITY_AUDIT_HREF = "/admin/audit?sourcePage=admin%2Faccounting%2Fintegrity";

// ─── Types ───────────────────────────────────────────────────────────────────

type DraftAgingBuckets = { fresh: number; warning: number; old: number; critical: number };
type DraftEntrySample = { id: string; memo: string | null; sourceType: string | null; sourceId: string | null; createdAt: string };
type DuplicatePaymentItem = { id: string; orderId: string | null; amount: number; createdAt: string };
type CustomerOverpaymentItem = { id: string; invoiceNumber: string | null; total: number; amountPaid: number; excess: number; createdAt: string };
type OrderBalanceIssueItem = { id: string; invoiceNumber: string | null; status: string; total: number; amountPaid: number; balance: number; issue: string; createdAt: string };
type SupplierOverpaymentItem = { purchaseId: string; totalPaid: number; purchaseCost: number; excess: number };

type IntegrityResponse = {
  draftEntries: number;
  arLedger: number;
  customerBalances: number;
  arDifference: number;
  inventoryLedger: number;
  inventoryValuation: number;
  inventoryDifference: number;
  inventoryPurchaseBacked?: number;
  inventoryGlOnly?: number;
  negativeStockCount: number;
  apLedger: number;
  apOperational: number;
  apDifference: number;
  apOperationalBacked?: number;
  apGlOnly?: number;
  trialBalance: number;
  // Extended reconciliation
  glRevenue: number;
  revenueOperational: number;
  revenueDifference: number;
  revenueOrderBacked?: number;
  revenueGlOnly?: number;
  glCogs: number;
  cogsOperational: number;
  cogsDifference: number;
  cogsOrderBacked?: number;
  cogsGlOnly?: number;
  glVat: number;
  vatOperational: number;
  vatDifference: number;
  vatOrderBacked?: number;
  vatGlOnly?: number;
  glStoreCredit: number;
  storeCreditOperational: number;
  storeCreditDifference: number;
  glCash: number;
  glBank: number;
  // Data quality
  draftAging: DraftAgingBuckets;
  draftEntriesSample: DraftEntrySample[];
  duplicatePayments: { count: number; items: DuplicatePaymentItem[] };
  customerOverpayments: { count: number; items: CustomerOverpaymentItem[] };
  orderBalanceIssues: { count: number; items: OrderBalanceIssueItem[] };
  supplierOverpayments: { count: number; items: SupplierOverpaymentItem[] };
  // Posting completeness
  missingPostings?: Record<string, number>;
  missingPostingItems?: {
    orders: Array<{ id: string; invoiceNumber: string | null; total: number; status: string; createdAt: string }>;
    payments: Array<{ id: string; amount: number; status: string | null; createdAt: string; postingFailure?: { action: string; reason?: string; meta?: Record<string, unknown> | null } | null }>;
    expenses: Array<{ id: string; amount: number; createdAt: string }>;
    purchases: Array<{ id: string; quantity: number; unitCost: number; status: string; createdAt: string }>;
    supplierPayments: Array<{ id: string; amount: number; createdAt: string }>;
    creditPayouts: Array<{ id: string; amount: number; createdAt: string }>;
    settlements: Array<{ id: string; totalBalance: number; createdAt: string }>;
  };
  recentPostFailures?: Array<{ id: string; action: string; entityType: string; entityId: string; meta: string | null; createdAt: string }>;
};
type IntegrityDrilldownKey = "ar" | "inventory" | "ap" | "revenue" | "cogs" | "vat" | "store_credit";
type IntegrityDrilldownLedgerRow = {
  id: string;
  entryId: string;
  date: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  description: string | null;
  debit: number;
  credit: number;
  amount: number;
  traceStatus?: "matched_operational" | "gl_only";
  traceCategory?: string | null;
  traceNote?: string | null;
};
type IntegrityDrilldownOperationalRow = {
  id: string;
  date: string | null;
  type: string;
  reference: string;
  detail: string | null;
  amount: number;
};
type IntegrityDrilldownResponse = {
  key: IntegrityDrilldownKey;
  label: string;
  code: string;
  asOf: string | null;
  difference: number;
  methodology: string[];
  alerts?: Array<{ tone: "info" | "warning"; message: string }>;
  ledger: {
    code: string;
    name: string;
    total: number;
    rows: IntegrityDrilldownLedgerRow[];
  };
  operational: {
    label: string;
    total: number;
    rows: IntegrityDrilldownOperationalRow[];
  } | null;
};

type ThresholdConfig = {
  arDifference: number;
  inventoryDifference: number;
  apDifference: number;
  trialBalance: number;
  revenueDifference: number;
  vatDifference: number;
  cogsDifference: number;
  storeCreditDifference: number;
  draftEntries: boolean;
  negativeStock: boolean;
};
type IntegrityAcknowledgement = { id: string; asOf: string; createdAt: string; actor?: string; warningSignature: string; warningKeys: string[]; note: string };
type PrecheckRow = { ok: boolean; entityType: string; entityId: string; source?: string; reason?: string; periodName?: string };
type WarningRow = {
  key: string;
  label: string;
  value: number;
  warn: boolean;
  href?: string;
  drilldownKey?: IntegrityDrilldownKey;
};

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "orders", label: "Orders" },
  { value: "payments", label: "Payments" },
  { value: "expenses", label: "Expenses" },
  { value: "purchases", label: "Purchases" },
  { value: "supplierPayments", label: "Supplier payments" },
  { value: "creditPayouts", label: "Credit payouts" },
  { value: "settlements", label: "Settlements" },
  { value: "failures", label: "Posting failures" },
] as const;

const sourceMeta: Record<string, { label: string; link: (id: string) => string; type: RetryTarget["entityType"] }> = {
  orders: { label: "Orders", link: (id) => `/admin/orders/${id}`, type: "ORDER" },
  payments: { label: "Payments", link: (id) => `/admin/payments?id=${id}`, type: "PAYMENT" },
  expenses: { label: "Expenses", link: (id) => `/admin/expenses?q=${id}`, type: "EXPENSE" },
  purchases: { label: "Purchases", link: (id) => `/admin/purchases?purchaseId=${id}`, type: "PURCHASE" },
  supplierPayments: { label: "Supplier payments", link: (id) => `/admin/supplier-payments?paymentId=${id}`, type: "SUPPLIER_PAYMENT" },
  creditPayouts: { label: "Store-credit cash payouts", link: (id) => `/admin/payments?id=${id}`, type: "CREDIT_PAYOUT" },
  settlements: { label: "Delivery settlements", link: () => "/admin/delivery/reconciliation/settlements", type: "DELIVERY_SETTLEMENT" },
};

// ─── Sub-panels ──────────────────────────────────────────────────────────────

type MissingItem = { id: string; createdAt: string; invoiceNumber?: string | null };
type MissingPostingsPanelProps = {
  filteredMissingItems: IntegrityResponse["missingPostingItems"] | null;
  missingPostings: Record<string, number> | undefined;
  pinnedSource: string;
  retryingKey: string;
  canPostNow: boolean;
  onRetry: (target: RetryTarget) => void;
};

function MissingPostingsPanel({ filteredMissingItems, missingPostings, pinnedSource, retryingKey, canPostNow, onRetry }: MissingPostingsPanelProps) {
  if (!filteredMissingItems) return null;

  const sources = Object.entries(sourceMeta).filter(([source]) => pinnedSource === "all" || pinnedSource === source);
  const hasSome = sources.some(([source]) => ((filteredMissingItems as Record<string, MissingItem[]>)[source] || []).length > 0);

  return (
    <div id="missing-postings" className="mt-3 border-t pt-3">
      <div className="text-xs font-semibold text-muted-foreground mb-2">Missing postings — sample (first 20 per source)</div>
      <div className="space-y-3 text-xs">
        {sources.map(([source, cfg]) => {
          const rows = ((filteredMissingItems as Record<string, MissingItem[]>)[source] || []) as MissingItem[];
          const totalCount = Number(missingPostings?.[source] ?? 0);
          if (!rows.length) return null;
          return (
            <div key={source}>
              <div className="font-medium mb-1 flex items-center gap-2">
                {cfg.label}
                {totalCount > rows.length && (
                  <span className="text-amber-600 font-normal">showing {rows.length} of {totalCount} — export CSV for full list</span>
                )}
              </div>
              <div className="space-y-1">
                {rows.map((row) => {
                  const retryKey = `${cfg.type}:${row.id}`;
                  const displayLabel = row.invoiceNumber ? `${row.invoiceNumber} (${row.id})` : row.id;
                  const paymentRow = source === "payments" ? (filteredMissingItems.payments ?? []).find((x) => x.id === row.id) : null;
                  const details = paymentRow?.postingFailure ? explainPostingFailure({ action: paymentRow.postingFailure.action, reason: paymentRow.postingFailure.reason, meta: null }) : null;
                  return (
                    <div key={row.id} className="flex flex-wrap items-center gap-2">
                      {renderAgeBadge(row.createdAt)}
                      <a href={cfg.link(row.id)} className="underline font-mono text-[11px]">{displayLabel}</a>
                      {details && <span className="text-muted-foreground">{details.reason}: {details.hint}</span>}
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onRetry({ entityType: cfg.type, entityId: row.id, source })} disabled={retryingKey === retryKey || !canPostNow}>
                        {retryingKey === retryKey ? "Posting..." : "Post now"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!hasSome && <div className="text-muted-foreground">No missing postings found.</div>}
      </div>
    </div>
  );
}

function PostingFailuresPanel({ failures }: { failures: IntegrityResponse["recentPostFailures"] }) {
  if (!failures?.length) return null;
  return (
    <div id="posting-failures" className="mt-3 border-t pt-3">
      <div className="text-xs font-semibold text-muted-foreground mb-2">Recent posting failures</div>
      <div className="space-y-2 text-xs">
        {failures.map((row) => {
          const details = explainPostingFailure({ action: row.action, reason: row.meta, meta: row.meta });
          return (
            <div key={row.id} className="flex flex-wrap items-center gap-2">
              {renderAgeBadge(row.createdAt)}
              <span className="font-medium">{row.entityType}</span>
              <a href={sourceMeta[row.entityType?.toLowerCase()]?.link(row.entityId) ?? "#"} className="underline font-mono text-[11px]">{row.entityId}</a>
              <span className="text-muted-foreground">{details.reason}: {details.hint}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Balance detail: GL vs Operational for all reconcilable accounts
type BalanceTraceLink = { href: string; label: string };
type BalanceRow = {
  label: string;
  code: string;
  ledger: number;
  operational: number;
  difference: number;
  warn: boolean;
  ledgerTrace?: BalanceTraceLink;
  operationalTrace?: BalanceTraceLink;
  drilldownKey?: IntegrityDrilldownKey;
  reviewNote?: string;
  varianceSummary?: string;
};

function BalanceDetailPanel({ rows, onOpenDrilldown }: { rows: BalanceRow[]; onOpenDrilldown: (row: BalanceRow) => void }) {
  return (
    <div className="rounded border text-xs overflow-x-auto">
      <div className="border-b px-3 py-2">
        <div className="font-semibold text-muted-foreground">GL vs Operational reconciliation</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Open both traces on the same row to compare posted ledger lines against the operational source records.
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b bg-muted/30 text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium">Account</th>
            <th className="px-3 py-1.5 text-right font-medium">GL Ledger</th>
            <th className="px-3 py-1.5 text-right font-medium">Operational</th>
            <th className="px-3 py-1.5 text-right font-medium">Difference</th>
            <th className="px-3 py-1.5 text-left font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b last:border-0 hover:bg-muted/10">
              <td className="px-3 py-1.5">
                <span className="font-medium">{row.label}</span>
                <span className="ml-1 text-muted-foreground">{row.code}</span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                <div>{fmt(row.ledger)}</div>
                {row.ledgerTrace && (
                  <a href={row.ledgerTrace.href} className="text-[11px] underline text-blue-700">
                    {row.ledgerTrace.label}
                  </a>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {row.operationalTrace ? (
                  <>
                    <div>{fmt(row.operational)}</div>
                    <a href={row.operationalTrace.href} className="text-[11px] underline text-blue-700">
                      {row.operationalTrace.label}
                    </a>
                  </>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${row.warn ? "text-amber-600" : "text-green-700"}`}>
                {row.operationalTrace ? fmt(row.difference) : <span className="text-muted-foreground">-</span>}
              </td>
              <td className="px-3 py-1.5">
                <div className="flex flex-col items-start gap-1">
                  {row.drilldownKey && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => onOpenDrilldown(row)}
                    >
                      Trace snapshot
                    </Button>
                  )}
                  <span className={row.warn ? "text-amber-700" : "text-muted-foreground"}>
                    {row.reviewNote ?? (row.operationalTrace ? "Compare both traces." : "GL-only watch item.")}
                  </span>
                  {row.varianceSummary && <span className="text-[11px] text-muted-foreground">{row.varianceSummary}</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceDrilldownDialog({
  open,
  onOpenChange,
  row,
  data,
  isLoading,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: BalanceRow | null;
  data?: IntegrityDrilldownResponse;
  isLoading: boolean;
  error?: Error | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {row ? `${row.label} snapshot trace` : "Snapshot trace"}
          </DialogTitle>
          <DialogDescription>
            Review the exact GL and operational contributors used for this reconciliation snapshot before posting any fix.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {row && (
            <div className="grid gap-2 rounded border bg-muted/20 p-3 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">GL ledger</div>
                <div className="font-semibold tabular-nums">{fmt(data?.ledger.total ?? row.ledger)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Operational</div>
                <div className="font-semibold tabular-nums">{fmt(data?.operational?.total ?? row.operational)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Difference</div>
                <div className={`font-semibold tabular-nums ${Math.abs(data?.difference ?? row.difference) > 0.01 ? "text-amber-600" : "text-green-700"}`}>
                  {fmt(data?.difference ?? row.difference)}
                </div>
              </div>
            </div>
          )}

          {isLoading && <div className="text-muted-foreground">Loading snapshot contributors...</div>}
          {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-700">{error.message}</div>}

          {!isLoading && !error && data && (
            <>
              <div className="rounded border px-3 py-2 text-xs">
                <div className="mb-2 font-semibold text-muted-foreground">Method</div>
                <div className="space-y-1 text-muted-foreground">
                  {data.methodology.map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              </div>

              {data.alerts && data.alerts.length > 0 && (
                <div className="space-y-2">
                  {data.alerts.map((alert) => (
                    <div
                      key={alert.message}
                      className={`rounded border px-3 py-2 text-xs ${
                        alert.tone === "warning"
                          ? "border-amber-300 bg-amber-50 text-amber-900"
                          : "border-blue-200 bg-blue-50 text-blue-900"
                      }`}
                    >
                      {alert.message}
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded border">
                  <div className="border-b px-3 py-2">
                    <div className="font-semibold text-muted-foreground">GL contributors</div>
                    <div className="text-[11px] text-muted-foreground">
                      {data.ledger.rows.length} line(s) on account {data.ledger.code} {data.ledger.name}
                    </div>
                  </div>
                  <div className="max-h-[26rem] overflow-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/30 text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">Date</th>
                          <th className="px-3 py-1.5 text-left font-medium">Source</th>
                          <th className="px-3 py-1.5 text-left font-medium">Trace</th>
                          <th className="px-3 py-1.5 text-left font-medium">Reference</th>
                          <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.ledger.rows.map((item) => (
                          <tr
                            key={item.id}
                            className={`border-b last:border-0 ${item.traceStatus === "gl_only" ? "bg-amber-50/40" : ""}`}
                          >
                            <td className="px-3 py-1.5 align-top">{item.date.slice(0, 10)}</td>
                            <td className="px-3 py-1.5 align-top">
                              <div>{item.sourceType}</div>
                              <a href={`/admin/accounting/journal?entry=${encodeURIComponent(item.entryId)}`} className="text-[11px] underline text-blue-700">
                                Journal {item.entryId}
                              </a>
                            </td>
                            <td className="px-3 py-1.5 align-top">
                              <div
                                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                  item.traceStatus === "gl_only"
                                    ? "bg-amber-100 text-amber-900"
                                    : item.traceStatus === "matched_operational"
                                      ? "bg-green-100 text-green-800"
                                      : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {item.traceStatus === "gl_only"
                                  ? "GL only"
                                  : item.traceStatus === "matched_operational"
                                    ? "Matches operational"
                                    : "Review"}
                              </div>
                              {item.traceCategory && (
                                <div className="mt-1 text-[11px] text-muted-foreground">{item.traceCategory}</div>
                              )}
                            </td>
                            <td className="px-3 py-1.5 align-top">
                              <div className="font-mono text-[11px]">{item.sourceId || item.entryId}</div>
                              <div className="text-muted-foreground">{item.description || item.memo || "Posted line"}</div>
                              {item.traceNote && <div className="text-[11px] text-muted-foreground">{item.traceNote}</div>}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums align-top">{fmt(item.amount)}</td>
                          </tr>
                        ))}
                        {!data.ledger.rows.length && (
                          <tr>
                            <td colSpan={5} className="px-3 py-2 text-muted-foreground">No GL contributors found.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded border">
                  <div className="border-b px-3 py-2">
                    <div className="font-semibold text-muted-foreground">{data.operational?.label || "Operational contributors"}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {data.operational?.rows.length ?? 0} row(s) used in the operational snapshot
                    </div>
                  </div>
                  <div className="max-h-[26rem] overflow-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/30 text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">Date</th>
                          <th className="px-3 py-1.5 text-left font-medium">Type</th>
                          <th className="px-3 py-1.5 text-left font-medium">Reference</th>
                          <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.operational?.rows || []).map((item) => (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="px-3 py-1.5 align-top">{item.date ? item.date.slice(0, 10) : "Snapshot"}</td>
                            <td className="px-3 py-1.5 align-top">{item.type}</td>
                            <td className="px-3 py-1.5 align-top">
                              <div className="font-mono text-[11px]">{item.reference}</div>
                              <div className="text-muted-foreground">{item.detail || "Operational contributor"}</div>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums align-top">{fmt(item.amount)}</td>
                          </tr>
                        ))}
                        {!data.operational?.rows.length && (
                          <tr>
                            <td colSpan={4} className="px-3 py-2 text-muted-foreground">No operational contributors found.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Draft entries with age breakdown and traceable sample
function DraftAgingPanel({ aging, samples }: { aging: DraftAgingBuckets; samples: DraftEntrySample[] }) {
  const total = aging.fresh + aging.warning + aging.old + aging.critical;
  if (total === 0) return null;
  return (
    <div id="draft-aging" className="rounded border px-3 py-2 text-xs">
      <div className="font-semibold text-muted-foreground mb-2">
        Draft journal entries — age breakdown
        <a href="/admin/accounting/journal?status=DRAFT" className="ml-2 underline text-blue-600 font-normal">View all drafts</a>
      </div>
      <div className="flex flex-wrap gap-4 mb-2">
        <span className="text-green-700">{aging.fresh} fresh (&lt;3d)</span>
        <span className="text-amber-500">{aging.warning} warning (3–7d)</span>
        <span className="text-orange-600">{aging.old} old (8–30d)</span>
        {aging.critical > 0 && <span className="text-red-700 font-semibold">{aging.critical} critical (&gt;30d)</span>}
      </div>
      {samples.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <div className="text-muted-foreground mb-1">Oldest entries:</div>
          {samples.map((entry) => {
            const days = ageDaysSince(entry.createdAt);
            return (
              <div key={entry.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={days > 30 ? "destructive" : days > 7 ? "warning" : "secondary"}>{days}d</Badge>
                <a href={`/admin/accounting/journal?id=${entry.id}`} className="underline font-mono text-[11px]">{entry.id}</a>
                {entry.sourceType && <span className="text-muted-foreground">{entry.sourceType}</span>}
                {entry.sourceId && (
                  <a href={sourceMeta[entry.sourceType?.toLowerCase() ?? ""]?.link(entry.sourceId) ?? "#"} className="underline text-[11px]">
                    {entry.sourceId}
                  </a>
                )}
                {entry.memo && <span className="text-muted-foreground truncate max-w-[200px]">{entry.memo}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Data quality issues panel: duplicates, customer/supplier overpayments, balance inconsistencies
function DataQualityPanel({
  duplicates,
  customerOverpayments,
  orderBalanceIssues,
  supplierOverpayments,
}: {
  duplicates: IntegrityResponse["duplicatePayments"];
  customerOverpayments: IntegrityResponse["customerOverpayments"];
  orderBalanceIssues: IntegrityResponse["orderBalanceIssues"];
  supplierOverpayments: IntegrityResponse["supplierOverpayments"];
}) {
  const hasAny =
    (duplicates?.count ?? 0) > 0 ||
    (customerOverpayments?.count ?? 0) > 0 ||
    (orderBalanceIssues?.count ?? 0) > 0 ||
    (supplierOverpayments?.count ?? 0) > 0;

  if (!hasAny) return (
    <div className="rounded border px-3 py-2 text-xs text-green-700">
      No data quality issues found (duplicates, overpayments, balance inconsistencies).
    </div>
  );

  return (
    <div id="data-quality" className="rounded border text-xs space-y-0 divide-y">
      <div className="px-3 py-2 font-semibold text-muted-foreground">Data quality issues</div>

      {/* Duplicate payments */}
      {(duplicates?.count ?? 0) > 0 && (
        <div className="px-3 py-2">
          <div className="font-medium mb-1 text-amber-700">
            Duplicate payments — {duplicates.count} group(s) detected
          </div>
          <p className="text-muted-foreground mb-2">Same order + same amount posted within 24 h. Possible double-billing.</p>
          <div className="space-y-1">
            {duplicates.items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                {renderAgeBadge(item.createdAt)}
                <a href={`/admin/payments?id=${item.id}`} className="underline font-mono text-[11px]">Payment {item.id}</a>
                {item.orderId && (
                  <a href={`/admin/orders/${item.orderId}`} className="underline text-blue-600">Order →</a>
                )}
                <span className="tabular-nums">{fmt(item.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer overpayments */}
      {(customerOverpayments?.count ?? 0) > 0 && (
        <div className="px-3 py-2">
          <div className="font-medium mb-1 text-amber-700">
            Customer overpayments — {customerOverpayments.count} order(s)
          </div>
          <p className="text-muted-foreground mb-2">amountPaid exceeds order total. Refund or apply credit.</p>
          <div className="space-y-1">
            {customerOverpayments.items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                {renderAgeBadge(item.createdAt)}
                <a href={`/admin/orders/${item.id}`} className="underline font-mono text-[11px]">
                  {item.invoiceNumber ?? item.id}
                </a>
                <span className="text-muted-foreground">Total {fmt(item.total)} · Paid {fmt(item.amountPaid)}</span>
                <Badge variant="warning">+{fmt(item.excess)} excess</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Order balance issues */}
      {(orderBalanceIssues?.count ?? 0) > 0 && (
        <div className="px-3 py-2">
          <div className="font-medium mb-1 text-amber-700">
            Order balance inconsistencies — {orderBalanceIssues.count} order(s)
          </div>
          <p className="text-muted-foreground mb-2">Status/amountPaid/balance fields do not agree. Manual review needed.</p>
          <div className="space-y-1">
            {orderBalanceIssues.items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                {renderAgeBadge(item.createdAt)}
                <a href={`/admin/orders/${item.id}`} className="underline font-mono text-[11px]">
                  {item.invoiceNumber ?? item.id}
                </a>
                <Badge variant="secondary">{item.status}</Badge>
                <span className="text-muted-foreground">
                  Total {fmt(item.total)} · Paid {fmt(item.amountPaid)} · Balance {fmt(item.balance)}
                </span>
                <Badge variant="warning">
                  {item.issue === "paid_with_balance" ? "PAID but balance > 0" : item.issue === "overpaid" ? "Overpaid" : "Inconsistent"}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Supplier overpayments */}
      {(supplierOverpayments?.count ?? 0) > 0 && (
        <div className="px-3 py-2">
          <div className="font-medium mb-1 text-amber-700">
            Supplier overpayments — {supplierOverpayments.count} purchase(s)
          </div>
          <p className="text-muted-foreground mb-2">Total supplier payments exceed the purchase cost. Possible data entry error.</p>
          <div className="space-y-1">
            {supplierOverpayments.items.map((item) => (
              <div key={item.purchaseId} className="flex flex-wrap items-center gap-2">
                <a href={`/admin/purchases?purchaseId=${item.purchaseId}`} className="underline font-mono text-[11px]">
                  Purchase {item.purchaseId}
                </a>
                <span className="text-muted-foreground">
                  Cost {fmt(item.purchaseCost)} · Paid {fmt(item.totalPaid)}
                </span>
                <Badge variant="warning">+{fmt(item.excess)} excess</Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function AccountingIntegrityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: sessionData } = useSession();
  const role = String((sessionData?.user as { role?: string } | undefined)?.role || "");
  const canPostNow = role === "ADMIN" || role === "ACCOUNTANT";
  const canHighImpact = role === "ADMIN";

  const [asOf, setAsOf] = useState(searchParams.get("asOf") || new Date().toISOString().slice(0, 10));
  const [onlyProblems, setOnlyProblems] = useState(searchParams.get("problems") === "1");
  const [itemSearch, setItemSearch] = useState(searchParams.get("q") || "");
  const [pinnedSource, setPinnedSource] = useState(searchParams.get("source") || "all");
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showBlockedOnly, setShowBlockedOnly] = useState(false);
  const [ackDialogOpen, setAckDialogOpen] = useState(false);
  const [ackNote, setAckNote] = useState("Reviewed and triaged");
  const [ackBusy, setAckBusy] = useState(false);
  const [precheckBusy, setPrecheckBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [retryingKey, setRetryingKey] = useState("");
  const [drilldownRow, setDrilldownRow] = useState<BalanceRow | null>(null);
  const [precheckResult, setPrecheckResult] = useState<{ total: number; ready: number; blocked: number; rows: PrecheckRow[] } | null>(null);
  const [bulkResult, setBulkResult] = useState<{ total: number; posted: number; skipped: number; rows: Array<{ source?: string; entityType: string; entityId: string; posted: boolean; skipped: boolean; reason?: string }> } | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const prevDataRef = useRef<IntegrityResponse | undefined>(undefined);

  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("asOf", asOf);
    if (onlyProblems) sp.set("problems", "1"); else sp.delete("problems");
    if (itemSearch.trim()) sp.set("q", itemSearch.trim()); else sp.delete("q");
    if (pinnedSource !== "all") sp.set("source", pinnedSource); else sp.delete("source");
    const next = sp.toString();
    if (next !== searchParams.toString()) router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [asOf, onlyProblems, itemSearch, pinnedSource, searchParams, pathname, router]);

  const params = useMemo(() => { const sp = new URLSearchParams(); sp.set("asOf", asOf); return sp.toString(); }, [asOf]);
  const todayYmd = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const asOfIsStale = Boolean(asOf && asOf < todayYmd);

  const { data: prefData } = useClientQuery<{ value: ThresholdConfig | null }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const thresholds: ThresholdConfig = useMemo(() => ({
    arDifference: prefData?.value?.arDifference ?? 0.01,
    inventoryDifference: prefData?.value?.inventoryDifference ?? 0.01,
    apDifference: prefData?.value?.apDifference ?? 0.01,
    trialBalance: prefData?.value?.trialBalance ?? 0.01,
    revenueDifference: prefData?.value?.revenueDifference ?? 0.01,
    vatDifference: prefData?.value?.vatDifference ?? 0.01,
    cogsDifference: prefData?.value?.cogsDifference ?? 0.01,
    storeCreditDifference: prefData?.value?.storeCreditDifference ?? 0.01,
    draftEntries: prefData?.value?.draftEntries ?? true,
    negativeStock: prefData?.value?.negativeStock ?? true,
  }), [prefData?.value]);

  const { data, isLoading, isFetching, isError, error, refetch } = useClientQuery<IntegrityResponse>({
    queryKey: ["accounting", "integrity", "asOf", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/integrity?${params}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Failed to load integrity checks.");
      return payload as IntegrityResponse;
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });
  const drilldownKey = drilldownRow?.drilldownKey || "";
  const {
    data: drilldownData,
    isLoading: drilldownLoading,
    error: drilldownError,
  } = useClientQuery<IntegrityDrilldownResponse, Error>({
    queryKey: ["accounting", "integrity", "drilldown", drilldownKey, asOf],
    enabled: Boolean(drilldownKey),
    queryFn: async () => {
      const sp = new URLSearchParams();
      sp.set("key", drilldownKey);
      sp.set("asOf", asOf);
      const res = await fetch(`/api/admin/accounting/integrity/drilldown?${sp.toString()}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "Failed to load integrity drilldown.");
      }
      return payload as IntegrityDrilldownResponse;
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    if (data && data !== prevDataRef.current) {
      prevDataRef.current = data;
      setLastCheckedAt(new Date());
    }
  }, [data]);

  const { data: ackData, refetch: refetchAck } = useClientQuery<{ value: IntegrityAcknowledgement[] | null }>({
    queryKey: ["accounting", "integrity-acknowledgements"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.acknowledgements").then((r) => r.json()),
  });
  const { data: lastSyncData, refetch: refetchLastSync } = useClientQuery<{ value: { at?: string; by?: string } | null }>({
    queryKey: ["accounting", "integrity-last-sync"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.lastSync").then((r) => r.json()),
  });

  const acknowledgements = useMemo(() => (Array.isArray(ackData?.value) ? ackData.value : []), [ackData?.value]);
  const missingPostingTotal = useMemo(() => Object.values(data?.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0), [data?.missingPostings]);
  const searchNeedle = itemSearch.trim().toLowerCase();

  const filteredRecentFailures = useMemo(() => {
    const rows = data?.recentPostFailures || [];
    if (!searchNeedle) return rows;
    return rows.filter((row) => [row.entityType, row.entityId, row.action, row.meta].some((v) => String(v || "").toLowerCase().includes(searchNeedle)));
  }, [data?.recentPostFailures, searchNeedle]);

  const filteredMissingItems = useMemo(() => {
    const items = data?.missingPostingItems;
    if (!items) return null;
    if (!searchNeedle) return items;
    const inc = (v: unknown) => String(v ?? "").toLowerCase().includes(searchNeedle);
    return {
      orders: items.orders.filter((r) => [r.id, r.invoiceNumber, r.status].some(inc)),
      payments: items.payments.filter((r) => [r.id, r.status, r.postingFailure?.reason].some(inc)),
      expenses: items.expenses.filter((r) => [r.id].some(inc)),
      purchases: items.purchases.filter((r) => [r.id, r.status].some(inc)),
      supplierPayments: items.supplierPayments.filter((r) => [r.id].some(inc)),
      creditPayouts: items.creditPayouts.filter((r) => [r.id].some(inc)),
      settlements: items.settlements.filter((r) => [r.id].some(inc)),
    };
  }, [data?.missingPostingItems, searchNeedle]);

  const visibleRetryTargets = useMemo(() => buildRetryTargets(filteredMissingItems, pinnedSource), [filteredMissingItems, pinnedSource]);
  const agingRows = useMemo(() => {
    if (!filteredMissingItems) return [] as Array<{ createdAt: string }>;
    const sources = pinnedSource === "all" ? Object.keys(sourceMeta) : [pinnedSource];
    return sources.flatMap((s) => (filteredMissingItems as Record<string, Array<{ createdAt: string }>>)[s] || []);
  }, [filteredMissingItems, pinnedSource]);
  const agingSummary = useMemo(() => summarizeAgingBuckets(agingRows), [agingRows]);

  const n = useCallback((v?: number | null) => Number(v ?? 0), []);
  const absDiff = useCallback((v?: number) => Math.abs(n(v)), [n]);
  const buildScopedHref = useCallback((path: string, query?: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value) sp.set(key, value);
    }
    const qs = sp.toString();
    return qs ? `${path}?${qs}` : path;
  }, []);

  const warningRows: WarningRow[] = useMemo(() => ([
    { key: "draft_entries", label: "Draft entries", value: n(data?.draftEntries), warn: thresholds.draftEntries && n(data?.draftEntries) > 0, href: "#draft-aging" },
    { key: "trial_balance", label: "Trial balance delta", value: n(data?.trialBalance), warn: absDiff(data?.trialBalance) > thresholds.trialBalance, href: buildScopedHref("/admin/accounting/journal", { outOfBalance: "1", reviewMode: "1", varianceSort: "1", end: asOf }) },
    { key: "ar_difference", label: "AR difference", value: n(data?.arDifference), warn: absDiff(data?.arDifference) > thresholds.arDifference, drilldownKey: "ar" },
    { key: "inventory_difference", label: "Inventory difference", value: n(data?.inventoryDifference), warn: absDiff(data?.inventoryDifference) > thresholds.inventoryDifference, drilldownKey: "inventory" },
    { key: "ap_difference", label: "AP difference", value: n(data?.apDifference), warn: absDiff(data?.apDifference) > thresholds.apDifference, drilldownKey: "ap" },
    { key: "revenue_difference", label: "Revenue difference", value: n(data?.revenueDifference), warn: absDiff(data?.revenueDifference) > thresholds.revenueDifference, drilldownKey: "revenue" },
    { key: "vat_difference", label: "VAT difference", value: n(data?.vatDifference), warn: absDiff(data?.vatDifference) > thresholds.vatDifference, drilldownKey: "vat" },
    { key: "cogs_difference", label: "COGS difference", value: n(data?.cogsDifference), warn: absDiff(data?.cogsDifference) > thresholds.cogsDifference, drilldownKey: "cogs" },
    { key: "store_credit_difference", label: "Store credit difference", value: n(data?.storeCreditDifference), warn: absDiff(data?.storeCreditDifference) > thresholds.storeCreditDifference, drilldownKey: "store_credit" },
    { key: "negative_stock", label: "Negative stock", value: n(data?.negativeStockCount), warn: thresholds.negativeStock && n(data?.negativeStockCount) > 0, href: buildScopedHref("/admin/accounting/inventory-valuation", { asOf }) },
    { key: "missing_postings", label: "Missing postings", value: missingPostingTotal, warn: missingPostingTotal > 0, href: "#missing-postings" },
    { key: "recent_failures", label: "Recent posting failures", value: filteredRecentFailures.length, warn: filteredRecentFailures.length > 0, href: "#posting-failures" },
    { key: "duplicates", label: "Duplicate payments", value: n(data?.duplicatePayments?.count), warn: n(data?.duplicatePayments?.count) > 0, href: "#data-quality" },
    { key: "customer_overpay", label: "Customer overpayments", value: n(data?.customerOverpayments?.count), warn: n(data?.customerOverpayments?.count) > 0, href: "#data-quality" },
    { key: "order_balance", label: "Order balance issues", value: n(data?.orderBalanceIssues?.count), warn: n(data?.orderBalanceIssues?.count) > 0, href: "#data-quality" },
    { key: "supplier_overpay", label: "Supplier overpayments", value: n(data?.supplierOverpayments?.count), warn: n(data?.supplierOverpayments?.count) > 0, href: "#data-quality" },
  ]), [data, thresholds, missingPostingTotal, filteredRecentFailures.length, asOf, buildScopedHref, absDiff, n]);

  const activeWarningKeys = useMemo(() => warningRows.filter((r) => r.warn).map((r) => `${r.key}:${r.value}`).sort(), [warningRows]);
  const warningSignature = useMemo(() => activeWarningKeys.join("|"), [activeWarningKeys]);
  const latestAck = acknowledgements[0] || null;
  const isCurrentWarningAcknowledged = Boolean(latestAck && latestAck.warningSignature === warningSignature && latestAck.asOf === asOf);

  const balanceDetailRows: BalanceRow[] = useMemo(() => [
    {
      label: "AR (Receivables)", code: "1100",
      ledger: n(data?.arLedger), operational: n(data?.customerBalances), difference: n(data?.arDifference),
      warn: absDiff(data?.arDifference) > thresholds.arDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "1100", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/orders", { outstandingOnly: "1", end: asOf }), label: "Open operational balances" },
      drilldownKey: "ar",
      reviewNote: "Use Trace snapshot to separate receivable-basis AR from GL-only journal activity.",
    },
    {
      label: "Inventory", code: "1200",
      ledger: n(data?.inventoryLedger), operational: n(data?.inventoryValuation), difference: n(data?.inventoryDifference),
      warn: absDiff(data?.inventoryDifference) > thresholds.inventoryDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "1200", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/accounting/inventory-valuation", { asOf }), label: "Open valuation detail" },
      drilldownKey: "inventory",
      reviewNote: "Check quantity and cost drivers before posting any adjustment.",
      varianceSummary: absDiff(data?.inventoryDifference) > 0.01
        ? `Purchase-backed GL ${fmt(data?.inventoryPurchaseBacked)}; GL-only/manual ${fmt(data?.inventoryGlOnly)}.`
        : undefined,
    },
    {
      label: "AP (Payables)", code: "2000",
      ledger: n(data?.apLedger), operational: n(data?.apOperational), difference: n(data?.apDifference),
      warn: absDiff(data?.apDifference) > thresholds.apDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "2000", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/supplier-payments", { exposureView: "received", outstandingOnly: "1" }), label: "Open operational AP" },
      drilldownKey: "ap",
      reviewNote: "Use Trace snapshot to separate matched purchase AP from GL-only journals before posting any fix.",
      varianceSummary: absDiff(data?.apDifference) > 0.01
        ? `Operational-backed AP ${fmt(data?.apOperationalBacked)}; GL-only journals ${fmt(data?.apGlOnly)}.`
        : undefined,
    },
    {
      label: "Revenue", code: "4000",
      ledger: n(data?.glRevenue), operational: n(data?.revenueOperational), difference: n(data?.revenueDifference),
      warn: absDiff(data?.revenueDifference) > thresholds.revenueDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "4000", sourceType: "ORDER", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/orders", { end: asOf }), label: "Open order totals" },
      drilldownKey: "revenue",
      reviewNote: "Missing order postings usually explain persistent revenue gaps.",
      varianceSummary: absDiff(data?.revenueDifference) > 0.01
        ? `Order-backed GL ${fmt(data?.revenueOrderBacked)}; GL-only/manual ${fmt(data?.revenueGlOnly)}.`
        : undefined,
    },
    {
      label: "COGS", code: "5000",
      ledger: n(data?.glCogs), operational: n(data?.cogsOperational), difference: n(data?.cogsDifference),
      warn: absDiff(data?.cogsDifference) > thresholds.cogsDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "5000", sourceType: "ORDER", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/orders", { end: asOf }), label: "Open sold-order detail" },
      drilldownKey: "cogs",
      reviewNote: "Check sales posting completeness and inventory timing together.",
      varianceSummary: absDiff(data?.cogsDifference) > 0.01
        ? `Order-backed GL ${fmt(data?.cogsOrderBacked)}; GL-only/manual ${fmt(data?.cogsGlOnly)}.`
        : undefined,
    },
    {
      label: "VAT Payable", code: "2100",
      ledger: n(data?.glVat), operational: n(data?.vatOperational), difference: n(data?.vatDifference),
      warn: absDiff(data?.vatDifference) > thresholds.vatDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "2100", sourceType: "ORDER", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: buildScopedHref("/admin/orders", { end: asOf }), label: "Open taxable orders" },
      drilldownKey: "vat",
      reviewNote: "Validate tax-bearing orders against posted VAT liability lines.",
      varianceSummary: absDiff(data?.vatDifference) > 0.01
        ? `Order-backed GL ${fmt(data?.vatOrderBacked)}; GL-only/manual ${fmt(data?.vatGlOnly)}.`
        : undefined,
    },
    {
      label: "Store Credit", code: "2200",
      ledger: n(data?.glStoreCredit), operational: n(data?.storeCreditOperational), difference: n(data?.storeCreditDifference),
      warn: absDiff(data?.storeCreditDifference) > thresholds.storeCreditDifference,
      ledgerTrace: { href: buildScopedHref("/admin/accounting/journal", { account: "2200", end: asOf }), label: "Open GL entries" },
      operationalTrace: { href: "/admin/customers", label: "Open customer credits" },
      drilldownKey: "store_credit",
      reviewNote: "Review credit issuance, application, and payout activity together.",
    },
    {
      label: "Cash", code: "1000",
      ledger: n(data?.glCash), operational: 0, difference: 0,
      warn: n(data?.glCash) < 0,
      ledgerTrace: n(data?.glCash) < 0
        ? { href: buildScopedHref("/admin/accounting/journal", { account: "1000", end: asOf }), label: "Open GL entries" }
        : undefined,
      reviewNote: "Negative cash usually indicates a posting or period-cutoff issue.",
    },
    {
      label: "Bank", code: "1010",
      ledger: n(data?.glBank), operational: 0, difference: 0,
      warn: n(data?.glBank) < 0,
      ledgerTrace: n(data?.glBank) < 0
        ? { href: buildScopedHref("/admin/accounting/journal", { account: "1010", end: asOf }), label: "Open GL entries" }
        : undefined,
      reviewNote: "Negative bank balances should be cleared before close.",
    },
  ], [data, thresholds, asOf, buildScopedHref, absDiff, n]);
  const visibleBalanceDetailRows = useMemo(
    () => (onlyProblems ? balanceDetailRows.filter((row) => row.warn) : balanceDetailRows),
    [balanceDetailRows, onlyProblems],
  );
  const openDrilldownByKey = useCallback((key: IntegrityDrilldownKey) => {
    const target = balanceDetailRows.find((row) => row.drilldownKey === key) || null;
    if (target) setDrilldownRow(target);
  }, [balanceDetailRows]);

  const callActions = async (body: unknown) => {
    const res = await fetch("/api/admin/accounting/integrity/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Action failed.");
    return payload as Record<string, unknown>;
  };

  const runSync = async () => {
    if (!canHighImpact) return toast.error("Only ADMIN can run ledger sync.");
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/accounting/sync", { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to sync accounting.");
      await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "accounting.integrity.lastSync", value: { at: new Date().toISOString(), by: role || "UNKNOWN" } }),
      });
      await refetchLastSync();
      toast.success("Accounting sync complete.");
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to sync accounting.");
    } finally {
      setSyncing(false);
    }
  };

  const runPrecheckVisible = async () => {
    if (!visibleRetryTargets.length) { toast.error("No visible retry targets."); return null; }
    setPrecheckBusy(true);
    try {
      const payload = await callActions({ action: "precheck", targets: visibleRetryTargets });
      const result = {
        total: Number((payload.summary as { total?: number } | undefined)?.total || 0),
        ready: Number((payload.summary as { ready?: number } | undefined)?.ready || 0),
        blocked: Number((payload.summary as { blocked?: number } | undefined)?.blocked || 0),
        rows: Array.isArray(payload.rows) ? (payload.rows as PrecheckRow[]) : [],
      };
      setPrecheckResult(result);
      if (result.blocked > 0) setShowBlockedOnly(true);
      return result;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Precheck failed.");
      return null;
    } finally {
      setPrecheckBusy(false);
    }
  };

  const postAllVisible = async () => {
    if (!canHighImpact) return toast.error("Only ADMIN can run bulk retry.");
    if (showBlockedOnly) return toast.error("Turn off 'Show blocked only' before posting ready rows.");
    if (!visibleRetryTargets.length) return toast.error("No visible retry targets.");
    setBulkBusy(true);
    try {
      const precheck = await runPrecheckVisible();
      if (!precheck) return;
      if (precheck.blocked > 0) return toast.error(`Bulk retry blocked: ${precheck.blocked} row(s) failed safeguards.`);
      const readySet = new Set(precheck.rows.filter((r) => r.ok).map((r) => `${r.entityType}:${r.entityId}`));
      const readyTargets = visibleRetryTargets.filter((t) => readySet.has(`${t.entityType}:${t.entityId}`));
      const payload = await callActions({ action: "bulkRetry", targets: readyTargets });
      const result = {
        total: Number((payload.summary as { total?: number } | undefined)?.total || 0),
        posted: Number((payload.summary as { posted?: number } | undefined)?.posted || 0),
        skipped: Number((payload.summary as { skipped?: number } | undefined)?.skipped || 0),
        rows: Array.isArray(payload.rows) ? (payload.rows as Array<{ source?: string; entityType: string; entityId: string; posted: boolean; skipped: boolean; reason?: string }>) : [],
      };
      setBulkResult(result);
      toast.success(`Bulk retry finished. Posted ${result.posted}, skipped ${result.skipped}.`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk retry failed.");
    } finally {
      setBulkBusy(false);
    }
  };

  const retryPostNow = async (target: RetryTarget) => {
    if (!canPostNow) return toast.error("You do not have permission to post.");
    const key = `${target.entityType}:${target.entityId}`;
    setRetryingKey(key);
    try {
      await callActions({ action: "retryPost", entityType: target.entityType, entityId: target.entityId, source: target.source });
      toast.success("Posting retry complete.");
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setRetryingKey("");
    }
  };

  const acknowledge = async () => {
    if (!activeWarningKeys.length) return toast.error("No active warnings to acknowledge.");
    if (!ackNote.trim()) return toast.error("Acknowledgement note is required.");
    setAckBusy(true);
    try {
      await callActions({ action: "acknowledgeWarnings", asOf, warningKeys: activeWarningKeys, note: ackNote.trim() });
      await refetchAck();
      toast.success("Warnings acknowledged.");
      setAckDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to acknowledge warnings.");
    } finally {
      setAckBusy(false);
    }
  };

  const clearAck = async () => {
    setAckBusy(true);
    try {
      await callActions({ action: "clearAcknowledgement", asOf });
      await refetchAck();
      toast.success("Acknowledgement cleared.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to clear acknowledgement.");
    } finally {
      setAckBusy(false);
    }
  };

  const exportMissingSampleCsv = () => {
    if (!filteredMissingItems) return toast.error("No missing postings sample to export.");
    const lines = [["source", "entityType", "entityId", "invoiceNumber", "createdAt"].join(",")];
    for (const [source, cfg] of Object.entries(sourceMeta)) {
      for (const row of (filteredMissingItems as Record<string, Array<{ id: string; createdAt: string; invoiceNumber?: string | null }>>)[source] || []) {
        lines.push([source, cfg.type, row.id, row.invoiceNumber ?? "", row.createdAt].map(toCsvCell).join(","));
      }
    }
    if (lines.length <= 1) return toast.error("No rows to export.");
    downloadCsv(lines, `integrity-missing-sample-${asOf}.csv`);
  };

  const exportFailuresCsv = () => {
    if (!filteredRecentFailures.length) return toast.error("No posting failures to export.");
    const lines = [["createdAt", "entityType", "entityId", "action", "reason", "hint"].join(",")];
    for (const row of filteredRecentFailures) {
      const d = explainPostingFailure({ action: row.action, reason: row.meta, meta: row.meta });
      lines.push([new Date(row.createdAt).toISOString(), row.entityType, row.entityId, row.action, d.reason, d.hint].map(toCsvCell).join(","));
    }
    downloadCsv(lines, `integrity-failures-${asOf}.csv`);
  };

  const exportPrecheckCsv = () => {
    const rows = showBlockedOnly ? (precheckResult?.rows || []).filter((r) => !r.ok) : precheckResult?.rows || [];
    if (!rows.length) return toast.error("No precheck rows to export.");
    const lines = [["source", "entityType", "entityId", "ok", "reason", "periodName"].join(",")];
    for (const r of rows) lines.push([r.source || "", r.entityType, r.entityId, r.ok ? "yes" : "no", r.reason || "", r.periodName || ""].map(toCsvCell).join(","));
    downloadCsv(lines, `integrity-precheck-${asOf}.csv`);
  };

  const exportRetryCsv = () => {
    if (!bulkResult?.rows?.length) return toast.error("No retry rows to export.");
    const lines = [["source", "entityType", "entityId", "posted", "skipped", "reason"].join(",")];
    for (const r of bulkResult.rows) lines.push([r.source || "", r.entityType, r.entityId, r.posted ? "yes" : "no", r.skipped ? "yes" : "no", r.reason || ""].map(toCsvCell).join(","));
    downloadCsv(lines, `integrity-retry-${asOf}.csv`);
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Data Integrity</h1>
        <p className="text-sm text-muted-foreground">Accounting checks with traceability links. Auto-refreshes every 5 minutes.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Checks</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">

          {/* ── Filters ── */}
          <div className="grid gap-2 md:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">As of date</span>
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Search IDs, refs, notes...</span>
              <Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search..." />
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Pinned source</span>
              <Select value={pinnedSource} onValueChange={setPinnedSource}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-end gap-2 pb-1">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              <span>Show problems only</span>
            </label>
          </div>

          {/* ── Action toolbar ── */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {asOfIsStale && <Button size="sm" variant="secondary" onClick={() => setAsOf(todayYmd)}>Use today</Button>}
              <Button asChild size="sm" variant="outline">
                <a href={`/admin/accounting/inventory-valuation?asOf=${encodeURIComponent(asOf)}`}>Post inventory adjustment</a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground mr-1">Data:</span>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>{isFetching ? "Refreshing..." : "Recalculate"}</Button>
              <Button size="sm" variant="outline" onClick={() => setSyncOpen(true)} disabled={syncing || !canHighImpact}>{syncing ? "Syncing..." : "Sync ledger"}</Button>
              {!canHighImpact && <span className="text-xs text-muted-foreground">Sync is ADMIN-only.</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground mr-1">Export:</span>
              <Button asChild size="sm" variant="outline">
                <a href={`/api/admin/accounting/integrity/export?${params}`}>Full report CSV</a>
              </Button>
              <Button size="sm" variant="outline" onClick={exportMissingSampleCsv}>Missing sample CSV</Button>
              <Button size="sm" variant="outline" onClick={exportFailuresCsv} disabled={!filteredRecentFailures.length}>Failures CSV</Button>
              <Button size="sm" variant="outline" onClick={exportPrecheckCsv} disabled={!precheckResult?.rows?.length}>Precheck CSV</Button>
              <Button size="sm" variant="outline" onClick={exportRetryCsv} disabled={!bulkResult?.rows?.length}>Retry CSV</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground mr-1">Retry:</span>
              <Button size="sm" variant="outline" onClick={runPrecheckVisible} disabled={precheckBusy || !visibleRetryTargets.length}>
                {precheckBusy ? "Running..." : `Run precheck (${visibleRetryTargets.length})`}
              </Button>
              <Button size="sm" variant="outline" onClick={postAllVisible} disabled={bulkBusy || !visibleRetryTargets.length || !canHighImpact}>
                {bulkBusy ? "Posting..." : `Post all visible (${visibleRetryTargets.length})`}
              </Button>
              {!canHighImpact && <span className="text-xs text-muted-foreground">Bulk retry is ADMIN-only.</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground mr-1">Audit:</span>
              <Button asChild size="sm" variant="outline">
                <Link href={INTEGRITY_AUDIT_HREF}>View audit trail</Link>
              </Button>
              <Button size="sm" variant={isCurrentWarningAcknowledged ? "secondary" : "outline"} onClick={() => setAckDialogOpen(true)} disabled={ackBusy || !activeWarningKeys.length}>
                {ackBusy ? "Saving..." : isCurrentWarningAcknowledged ? "Warnings acknowledged" : "Acknowledge warnings"}
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAck} disabled={ackBusy}>Clear acknowledgement</Button>
            </div>
          </div>

          {/* ── Status bar ── */}
          <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
            <span>Last sync: {lastSyncData?.value?.at ? `${new Date(lastSyncData.value.at).toLocaleString()} (${lastSyncData.value.by || "unknown"})` : "not recorded yet"}.</span>
            {lastCheckedAt && <span>Checks loaded: {lastCheckedAt.toLocaleTimeString()}.</span>}
          </div>

          {/* ── Contextual banners ── */}
          {asOfIsStale && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              Viewing as of {asOf}. Transactions and posting gaps after this date are hidden.
            </div>
          )}
          {latestAck && (
            <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">
              Latest acknowledgement: {new Date(String(latestAck.createdAt || "")).toLocaleString()} by {String(latestAck.actor || "Unknown")}.
              {latestAck.note ? ` Note: ${latestAck.note}` : ""}
            </div>
          )}
          {isError && <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">{error instanceof Error ? error.message : "Failed to load integrity checks."}</div>}
          {precheckResult && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              Precheck: {precheckResult.total} total, {precheckResult.ready} ready, {precheckResult.blocked} blocked.
              <div className="mt-1 flex gap-2 items-center">
                <Button size="sm" variant={showBlockedOnly ? "default" : "outline"} className="h-7" onClick={() => setShowBlockedOnly((v) => !v)}>
                  {showBlockedOnly ? "Showing blocked only" : "Show blocked only"}
                </Button>
              </div>
              {(showBlockedOnly ? precheckResult.rows.filter((r) => !r.ok) : precheckResult.rows).slice(0, 8).map((r) => (
                <div key={`${r.entityType}:${r.entityId}`} className="mt-1">
                  {r.source || "source"} — {r.entityType} {r.entityId}: {r.ok ? "ready" : r.reason || "blocked"}
                  {r.periodName ? ` (${r.periodName})` : ""}
                </div>
              ))}
            </div>
          )}
          {bulkResult && (
            <div className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
              Bulk retry: {bulkResult.total} total, {bulkResult.posted} posted, {bulkResult.skipped} skipped.
            </div>
          )}
          {isLoading && <p className="text-muted-foreground">Loading checks...</p>}

          {/* ── Results ── */}
          {!isLoading && !isError && (
            <>
              {/* Summary tiles */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border px-3 py-2">
                  <div className="text-xs text-muted-foreground">Warnings triggered</div>
                  <div className="text-lg font-semibold">{activeWarningKeys.length}</div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-xs text-muted-foreground">Missing postings</div>
                  <div className="text-lg font-semibold">{missingPostingTotal}</div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-xs text-muted-foreground">Trial balance delta</div>
                  <div className={`text-lg font-semibold ${absDiff(data?.trialBalance) > thresholds.trialBalance ? "text-amber-600" : "text-green-700"}`}>
                    {fmt(data?.trialBalance)}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2">
                  <div className="text-xs text-muted-foreground">Data quality issues</div>
                  <div className={`text-lg font-semibold ${(n(data?.duplicatePayments?.count) + n(data?.customerOverpayments?.count) + n(data?.orderBalanceIssues?.count) + n(data?.supplierOverpayments?.count)) > 0 ? "text-amber-600" : "text-green-700"}`}>
                    {n(data?.duplicatePayments?.count) + n(data?.customerOverpayments?.count) + n(data?.orderBalanceIssues?.count) + n(data?.supplierOverpayments?.count)}
                  </div>
                </div>
              </div>

              {/* Severity by signal */}
              <div className="rounded border px-3 py-2">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Severity by signal</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {warningRows.filter((r) => !onlyProblems || r.warn).map((r) => (
                    <div key={r.key} className="flex items-center justify-between rounded border p-2 text-xs">
                      <div>
                        <div className="font-medium">{r.label}</div>
                        <div className="text-muted-foreground tabular-nums">{fmt(r.value)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.warn ? <Badge variant="warning">Warning</Badge> : <Badge variant="success">OK</Badge>}
                        {r.drilldownKey ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => openDrilldownByKey(r.drilldownKey!)}
                          >
                            Drivers
                          </Button>
                        ) : r.href ? (
                          <a href={r.href} className="underline text-blue-600">Drivers</a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* GL vs Operational reconciliation table */}
              {visibleBalanceDetailRows.length > 0 && (
                <BalanceDetailPanel rows={visibleBalanceDetailRows} onOpenDrilldown={setDrilldownRow} />
              )}

              {/* Ledger readiness */}
              <div className="rounded border px-3 py-2 text-xs">
                <div className="mb-2 font-semibold text-muted-foreground">Ledger readiness — missing postings by source</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {Object.entries({
                    orders: "Orders",
                    payments: "Payments",
                    expenses: "Expenses",
                    purchases: "Purchases",
                    supplierPayments: "Supplier payments",
                    creditPayouts: "Credit payouts",
                    settlements: "Settlements",
                  }).map(([key, label]) => (
                    <div key={key} className="flex justify-between items-center">
                      <span>{label}</span>
                      <span className="flex items-center gap-2">
                        <span className={Number(data?.missingPostings?.[key] || 0) > 0 ? "text-amber-600 font-semibold" : ""}>{Number(data?.missingPostings?.[key] || 0)}</span>
                        {Number(data?.missingPostings?.[key] || 0) > 0 && (
                          <a href={`/admin/accounting/integrity?source=${key}`} className="underline text-blue-600 text-[11px]">View →</a>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Aging SLA */}
              <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">
                Aging SLA (visible sample): {agingSummary.fresh} fresh (&lt;3d), {agingSummary.warning} warning (3–7d), {agingSummary.overdue} overdue (8d+).
              </div>

              {/* Draft aging */}
              {data?.draftAging && (
                <DraftAgingPanel
                  aging={data.draftAging}
                  samples={data.draftEntriesSample ?? []}
                />
              )}

              {/* Data quality issues */}
              <DataQualityPanel
                duplicates={data?.duplicatePayments ?? { count: 0, items: [] }}
                customerOverpayments={data?.customerOverpayments ?? { count: 0, items: [] }}
                orderBalanceIssues={data?.orderBalanceIssues ?? { count: 0, items: [] }}
                supplierOverpayments={data?.supplierOverpayments ?? { count: 0, items: [] }}
              />

              {/* Missing postings sample */}
              <MissingPostingsPanel
                filteredMissingItems={filteredMissingItems}
                missingPostings={data?.missingPostings}
                pinnedSource={pinnedSource}
                retryingKey={retryingKey}
                canPostNow={canPostNow}
                onRetry={retryPostNow}
              />

              {/* Recent posting failures */}
              <PostingFailuresPanel failures={filteredRecentFailures} />
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Sync dialog ── */}
      <BalanceDrilldownDialog
        open={Boolean(drilldownRow)}
        onOpenChange={(open) => {
          if (!open) setDrilldownRow(null);
        }}
        row={drilldownRow}
        data={drilldownData}
        isLoading={drilldownLoading}
        error={drilldownError}
      />
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Sync ledger</DialogTitle>
            <DialogDescription>
              Backfills missing journal entries and posts inventory valuation adjustments when needed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setSyncOpen(false)}>Cancel</Button>
            <Button onClick={async () => { await runSync(); setSyncOpen(false); }} disabled={!canHighImpact}>Run sync</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Acknowledge dialog ── */}
      <Dialog open={ackDialogOpen} onOpenChange={setAckDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Acknowledge warnings</DialogTitle>
            <DialogDescription>
              Record what you checked and the follow-up action so other reviewers can see why the warning was accepted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <Input value={ackNote} onChange={(e) => setAckNote(e.target.value)} placeholder="Reviewed and assigned to finance" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAckDialogOpen(false)} disabled={ackBusy}>Cancel</Button>
            <Button onClick={acknowledge} disabled={ackBusy || !ackNote.trim()}>{ackBusy ? "Saving..." : "Save acknowledgement"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function downloadCsv(lines: string[], filename: string) {
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
