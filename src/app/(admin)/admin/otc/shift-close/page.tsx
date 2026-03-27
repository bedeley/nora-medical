"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDateGH } from "@/lib/currency";

type ShiftSummaryResponse = {
  range: { from: string; to: string; day: string };
  summary: {
    expectedCash: number;
    expectedBank: number;
    expectedTotal: number;
    paymentCount: number;
    walkInOrderCount: number;
    outstandingWalkInBalance: number;
    unpostedPaymentCount: number;
  };
};

type ShiftHistoryResponse = {
  items: Array<{
    id: string;
    shiftCloseId: string;
    createdAt: string;
    actor: { id: string; name: string | null; email: string | null; role: string } | null;
    day: string;
    expected: { cash: number; bank: number; total: number };
    actual: { cash: number; bank: number; total: number };
    variance: { cash: number; bank: number; total: number };
    paymentCount: number;
    walkInOrderCount: number;
    outstandingWalkInBalance: number;
    unpostedPaymentCount: number;
    note: string | null;
  }>;
};

type AccountingSyncResponse = {
  ok: boolean;
  posted?: {
    orders?: number;
    payments?: number;
    expenses?: number;
    purchases?: number;
    supplierPayments?: number;
    creditPayouts?: number;
    settlements?: number;
  };
  inventoryAdjustment?: {
    posted?: boolean;
    amount?: number;
    difference?: number;
  };
};

type ShiftClosedStatusResponse = {
  isOpen: boolean;
  isClosed: boolean;
  day: string;
  openEventId: string | null;
  closeEventId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  openedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  closedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  canOpenNow: boolean;
  openWindowStartHourUtc: number;
  requiresHandoverAck: boolean;
  lastClose: {
    shiftCloseId: string;
    createdAt: string;
    closedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function parseAmount(value: string) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export default function OtcShiftClosePage() {
  const [day, setDay] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [actualBank, setActualBank] = useState("");
  const [note, setNote] = useState("");
  const [allowUnpostedOverride, setAllowUnpostedOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<AccountingSyncResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openingShift, setOpeningShift] = useState(false);
  const [openingCashFloat, setOpeningCashFloat] = useState("");
  const [openingNote, setOpeningNote] = useState("");
  const [handoverAcknowledged, setHandoverAcknowledged] = useState(false);
  const [handoverCashCountVerified, setHandoverCashCountVerified] = useState(false);
  const [handoverPaymentSummaryVerified, setHandoverPaymentSummaryVerified] =
    useState(false);
  const [handoverPendingItemsReviewed, setHandoverPendingItemsReviewed] =
    useState(false);
  const [handoverNotes, setHandoverNotes] = useState("");

  const { data, isLoading, isFetching, refetch } = useClientQuery<ShiftSummaryResponse>({
    queryKey: ["admin", "otc-shift-close-summary", day],
    queryFn: () =>
      fetcher(
        day
          ? `/api/admin/otc/shift-close/summary?day=${encodeURIComponent(day)}`
          : "/api/admin/otc/shift-close/summary",
      ),
  });
  const { data: historyData, isFetching: historyFetching, refetch: refetchHistory } =
    useClientQuery<ShiftHistoryResponse>({
      queryKey: ["admin", "otc-shift-close-history"],
      queryFn: () => fetcher("/api/admin/otc/shift-close/history?limit=20"),
    });
  const historyRows = useMemo(() => historyData?.items || [], [historyData?.items]);
  const { data: closedStatus, refetch: refetchClosedStatus } =
    useClientQuery<ShiftClosedStatusResponse>({
      queryKey: ["admin", "otc-shift-close-status", day],
      queryFn: () =>
        fetcher(`/api/admin/otc/shift-close/status?day=${encodeURIComponent(day)}`),
    });

  const summary = data?.summary;
  const closedSnapshot = useMemo(
    () => historyRows.find((row) => row.day === day) || null,
    [historyRows, day],
  );
  const expectedCash = Number(summary?.expectedCash || 0);
  const expectedBank = Number(summary?.expectedBank || 0);
  const expectedTotal = Number(summary?.expectedTotal || 0);
  const actualCashNum = closedStatus?.isClosed
    ? Number(closedSnapshot?.actual.cash || 0)
    : parseAmount(actualCash);
  const actualBankNum = closedStatus?.isClosed
    ? Number(closedSnapshot?.actual.bank || 0)
    : parseAmount(actualBank);
  const actualTotal = actualCashNum + actualBankNum;
  const varianceCash = actualCashNum - expectedCash;
  const varianceBank = actualBankNum - expectedBank;
  const varianceTotal = actualTotal - expectedTotal;

  const hasVariance = useMemo(
    () => Math.abs(varianceCash) > 0.009 || Math.abs(varianceBank) > 0.009,
    [varianceCash, varianceBank],
  );

  useEffect(() => {
    if (!day && data?.range?.day) {
      setDay(data.range.day);
    }
  }, [day, data?.range?.day]);

  const fillExpected = () => {
    setActualCash(expectedCash.toFixed(2));
    setActualBank(expectedBank.toFixed(2));
  };

  const closeShift = async () => {
    if (!summary) return;
    try {
      setSubmitting(true);
      const res = await fetch("/api/admin/otc/shift-close/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day,
          actualCash: actualCashNum,
          actualBank: actualBankNum,
          note: note.trim() || undefined,
          allowUnpostedOverride,
          overrideReason: overrideReason.trim() || undefined,
        }),
      });
      const payload = await res.json().catch(
        () =>
          ({} as {
            error?: string;
            code?: string;
            shiftCloseId?: string;
            unpostedPaymentCount?: number;
          }),
      );
      if (!res.ok) {
        toast.error(payload?.error || "Failed to close shift");
        return;
      }
      toast.success(`Shift closed: ${payload.shiftCloseId || "saved"}`);
      if (Number(payload.unpostedPaymentCount || 0) > 0) {
        toast.warning(
          `${payload.unpostedPaymentCount} OTC payment(s) are still unposted in journal.`,
        );
      }
      await refetch();
      await refetchHistory();
      await refetchClosedStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("otc-shift-status-changed"));
      }
      setActualCash("");
      setActualBank("");
      setNote("");
      setAllowUnpostedOverride(false);
      setOverrideReason("");
    } finally {
      setSubmitting(false);
    }
  };

  const openShift = async () => {
    try {
      setOpeningShift(true);
      const res = await fetch("/api/admin/otc/shift-close/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day,
          note: openingNote.trim() || undefined,
          openingCashFloat: Number(openingCashFloat || 0),
          handoverAcknowledged,
          handoverFromShiftCloseId: closedStatus?.lastClose?.shiftCloseId || undefined,
          handoverChecklist: {
            cashCountVerified: handoverCashCountVerified,
            paymentSummaryVerified: handoverPaymentSummaryVerified,
            pendingItemsReviewed: handoverPendingItemsReviewed,
            notes: handoverNotes.trim() || undefined,
          },
        }),
      });
      const payload = await res.json().catch(() => ({} as { error?: string; alreadyOpen?: boolean }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to open shift");
        return;
      }
      toast.success(payload?.alreadyOpen ? "Shift already open." : "Shift opened.");
      setOpeningCashFloat("");
      setOpeningNote("");
      setHandoverAcknowledged(false);
      setHandoverCashCountVerified(false);
      setHandoverPaymentSummaryVerified(false);
      setHandoverPendingItemsReviewed(false);
      setHandoverNotes("");
      await refetchClosedStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("otc-shift-status-changed"));
      }
    } finally {
      setOpeningShift(false);
    }
  };

  const runAccountingSyncNow = async () => {
    try {
      setSyncing(true);
      setSyncResult(null);
      const res = await fetch("/api/admin/accounting/sync", { method: "POST" });
      const payload = await res
        .json()
        .catch(() => ({} as { error?: string } & AccountingSyncResponse));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to run accounting sync");
        return;
      }
      toast.success("Accounting sync completed");
      setSyncResult(payload);
      setAllowUnpostedOverride(false);
      setOverrideReason("");
      await refetch();
      await refetchHistory();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="container mx-auto max-w-5xl py-8 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">OTC Shift Close</h1>
          <p className="text-sm text-muted-foreground">
            Reconcile OTC cash and bank channels at end of shift.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/orders/otc">
            <Button className="w-full sm:w-auto" variant="outline">OTC Quick Sale</Button>
          </Link>
          <Link href="/admin/orders?customerType=WALK_IN">
            <Button className="w-full sm:w-auto" variant="secondary">OTC Orders</Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Shift Range</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Day</label>
            <Input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Refresh Summary"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {syncResult ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Last Sync Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Orders posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.orders || 0)}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Payments posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.payments || 0)}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Expenses posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.expenses || 0)}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Settlements posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.settlements || 0)}</div>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Purchases posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.purchases || 0)}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Supplier payments posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.supplierPayments || 0)}</div>
              </div>
              <div className="rounded border p-2">
                <div className="text-xs text-muted-foreground">Credit payouts posted</div>
                <div className="font-semibold">{Number(syncResult.posted?.creditPayouts || 0)}</div>
              </div>
            </div>
            <div className="rounded border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Inventory adjustment</div>
              <div className="font-medium">
                {syncResult.inventoryAdjustment?.posted ? "Posted" : "Not posted"}
                {syncResult.inventoryAdjustment?.posted
                  ? ` (${formatCurrency(Number(syncResult.inventoryAdjustment?.amount || 0))})`
                  : ""}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Expected vs Actual</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading summary...</p> : null}
          {summary ? (
            <>
              {closedStatus?.isClosed ? (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
                  Shift for {day} is already closed.
                  {closedStatus.closedBy?.name ? ` Closed by ${closedStatus.closedBy.name}.` : ""}
                </div>
              ) : null}
              {!closedStatus?.isOpen && !closedStatus?.isClosed ? (
                <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm">
                  Shift for {day} is not open yet.
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={openingCashFloat}
                      onChange={(e) => setOpeningCashFloat(e.target.value)}
                      placeholder="Opening cash float"
                    />
                    <Input
                      value={openingNote}
                      onChange={(e) => setOpeningNote(e.target.value)}
                      placeholder="Opening note (optional)"
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {closedStatus?.requiresHandoverAck && closedStatus?.lastClose ? (
                      <div className="rounded border border-blue-200 bg-white p-2 text-xs text-blue-700 space-y-2">
                        <div>Handover from {closedStatus.lastClose.shiftCloseId.slice(0, 8)}...</div>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={handoverAcknowledged}
                            onChange={(e) => setHandoverAcknowledged(e.target.checked)}
                          />
                          I acknowledge handover from previous shift
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={handoverCashCountVerified}
                            onChange={(e) => setHandoverCashCountVerified(e.target.checked)}
                          />
                          Cash count verified
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={handoverPaymentSummaryVerified}
                            onChange={(e) => setHandoverPaymentSummaryVerified(e.target.checked)}
                          />
                          Payment summary verified
                        </label>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={handoverPendingItemsReviewed}
                            onChange={(e) => setHandoverPendingItemsReviewed(e.target.checked)}
                          />
                          Pending items reviewed
                        </label>
                        <Input
                          value={handoverNotes}
                          onChange={(e) => setHandoverNotes(e.target.value)}
                          placeholder="Handover notes (optional)"
                        />
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={openShift}
                      disabled={
                        openingShift ||
                        !closedStatus?.canOpenNow ||
                        Boolean(
                          closedStatus?.requiresHandoverAck &&
                            (!handoverAcknowledged ||
                              !handoverCashCountVerified ||
                              !handoverPaymentSummaryVerified ||
                              !handoverPendingItemsReviewed),
                        )
                      }
                    >
                      {openingShift ? "Opening..." : "Open Shift"}
                    </Button>
                    {!closedStatus?.canOpenNow ? (
                      <span className="text-xs text-blue-700">
                        Staff can open after {String(closedStatus?.openWindowStartHourUtc ?? 6).padStart(2, "0")}:00 UTC.
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Expected Cash</div>
                  <div className="font-semibold">{formatCurrency(expectedCash)}</div>
                </div>
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Expected Bank (MoMo/Transfer)</div>
                  <div className="font-semibold">{formatCurrency(expectedBank)}</div>
                </div>
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Expected Total</div>
                  <div className="font-semibold">{formatCurrency(expectedTotal)}</div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="mb-1 block text-sm font-medium">Actual Cash Counted</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={closedStatus?.isClosed ? actualCashNum.toFixed(2) : actualCash}
                    onChange={(e) => setActualCash(e.target.value)}
                    readOnly={Boolean(closedStatus?.isClosed)}
                    disabled={Boolean(closedStatus?.isClosed)}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Actual Bank/MoMo Counted</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={closedStatus?.isClosed ? actualBankNum.toFixed(2) : actualBank}
                    onChange={(e) => setActualBank(e.target.value)}
                    readOnly={Boolean(closedStatus?.isClosed)}
                    disabled={Boolean(closedStatus?.isClosed)}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={fillExpected}
                    disabled={Boolean(closedStatus?.isClosed)}
                  >
                    Use Expected Amounts
                  </Button>
                </div>
              </div>

              <div className="rounded border bg-muted/20 p-4 text-sm space-y-1">
                <div className="flex justify-between">
                  <span>Cash Variance</span>
                  <span>{formatCurrency(varianceCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Bank Variance</span>
                  <span>{formatCurrency(varianceBank)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total Variance</span>
                  <span>{formatCurrency(varianceTotal)}</span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">OTC Payments in Range</div>
                  <div className="font-semibold">{summary.paymentCount}</div>
                </div>
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">Walk-in Orders Covered</div>
                  <div className="font-semibold">{summary.walkInOrderCount}</div>
                </div>
                <div className="rounded border p-3 text-sm">
                  <div className="text-xs text-muted-foreground">
                    Outstanding OTC Balance (All-time)
                  </div>
                  <div className="font-semibold">
                    {formatCurrency(summary.outstandingWalkInBalance)}
                  </div>
                </div>
              </div>

              {summary.paymentCount === 0 ? (
                <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                  No OTC payments were found for the selected day.
                </div>
              ) : null}

              {summary.unpostedPaymentCount > 0 ? (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
                  {summary.unpostedPaymentCount} OTC payment(s) are not yet posted in journal.
                  Run accounting sync before final reports.
                  <div className="mt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={runAccountingSyncNow}
                      disabled={syncing}
                    >
                      {syncing ? "Syncing..." : "Run accounting sync now"}
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={allowUnpostedOverride}
                        onChange={(e) => setAllowUnpostedOverride(e.target.checked)}
                      />
                      Allow close with override reason
                    </label>
                    {allowUnpostedOverride ? (
                      <div>
                        <label className="mb-1 block text-xs font-medium">
                          Override Reason (required)
                        </label>
                        <Textarea
                          rows={2}
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          placeholder="Explain why shift close is proceeding before posting sync."
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">
                  All OTC payments in this range are posted to journal.
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium">Close Note (optional)</label>
                <Textarea
                  rows={3}
                  value={closedStatus?.isClosed ? String(closedSnapshot?.note || "") : note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={
                    closedStatus?.isClosed
                      ? "Shift already closed for this day."
                      : hasVariance
                        ? "Explain the variance reason."
                        : "Shift close note"
                  }
                  readOnly={Boolean(closedStatus?.isClosed)}
                  disabled={Boolean(closedStatus?.isClosed)}
                />
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={closeShift}
                  disabled={
                    Boolean(closedStatus?.isClosed || !closedStatus?.isOpen) ||
                    submitting ||
                    syncing ||
                    (summary.unpostedPaymentCount > 0 &&
                      (!allowUnpostedOverride || overrideReason.trim().length < 10))
                  }
                >
                  {submitting ? "Closing..." : "Close Shift"}
                </Button>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Recent Shift Closes</CardTitle>
          <div className="flex gap-2">
            <a href={`/api/admin/otc/shift-close/export${day ? `?day=${encodeURIComponent(day)}` : ""}`}>
              <Button variant="outline" size="sm">Export CSV</Button>
            </a>
            <Button variant="outline" size="sm" onClick={() => refetchHistory()} disabled={historyFetching}>
              {historyFetching ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Actual</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead>Unposted</TableHead>
                  <TableHead>Closed By</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-sm text-muted-foreground">
                      No shift closes recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  historyRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.day || "-"}</TableCell>
                      <TableCell>{formatCurrency(row.expected.total)}</TableCell>
                      <TableCell>{formatCurrency(row.actual.total)}</TableCell>
                      <TableCell>{formatCurrency(row.variance.total)}</TableCell>
                      <TableCell>{row.unpostedPaymentCount}</TableCell>
                      <TableCell>{row.actor?.name || row.actor?.email || "System"}</TableCell>
                      <TableCell>{formatDateGH(row.createdAt)}</TableCell>
                      <TableCell>
                        <Link
                          className="underline text-sm"
                          href={`/admin/audit?action=OTC_SHIFT_CLOSE&entityType=OTC_SHIFT&entityId=${encodeURIComponent(row.shiftCloseId)}&sourcePage=admin/otc/shift-close`}
                        >
                          View
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
