"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

type PeriodChecklist = {
  draftEntries: number;
  openReconciliations: number;
};

type AppSettingResponse = { key: string; value: unknown };

type CloseChecklistState = {
  bankReviewed: boolean;
  cashReviewed: boolean;
  arApReviewed: boolean;
  inventoryReviewed: boolean;
  vatReviewed: boolean;
};

const DEFAULT_REMINDER_DAYS = 7;

const CLOSE_CHECKLIST_ITEMS: Array<{ key: keyof CloseChecklistState; label: string }> = [
  { key: "bankReviewed", label: "Bank reconciliation reviewed for this period." },
  { key: "cashReviewed", label: "Cash reconciliation reviewed for this period." },
  { key: "arApReviewed", label: "AR/AP aging reviewed and exceptions noted." },
  { key: "inventoryReviewed", label: "Inventory valuation/integrity reviewed." },
  { key: "vatReviewed", label: "VAT report reviewed or marked not applicable." },
];

function endOfDay(dateText: string) {
  return new Date(`${dateText.slice(0, 10)}T23:59:59.999`);
}

function daysUntil(dateText: string) {
  const now = new Date();
  const target = endOfDay(dateText);
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

export default function AccountingPeriodsPage() {
  const queryClient = useQueryClient();
  const { data } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const { data: snapshotData } = useClientQuery<{ periodId: string }[]>({
    queryKey: ["accounting", "period-snapshots"],
    queryFn: () => fetch("/api/admin/accounting/periods/snapshots").then((r) => r.json()),
  });
  const { data: reminderData } = useClientQuery<AppSettingResponse>({
    queryKey: ["app-setting", "accounting.periodClose.reminderDays"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.periodClose.reminderDays").then((r) => r.json()),
  });

  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closePeriod, setClosePeriod] = useState<FiscalPeriod | null>(null);
  const [checklist, setChecklist] = useState<PeriodChecklist | null>(null);
  const [closing, setClosing] = useState(false);
  const [checklistState, setChecklistState] = useState<CloseChecklistState>({
    bankReviewed: false,
    cashReviewed: false,
    arApReviewed: false,
    inventoryReviewed: false,
    vatReviewed: false,
  });
  const [allowOverride, setAllowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [savingReminder, setSavingReminder] = useState(false);
  const [reminderDaysInput, setReminderDaysInput] = useState(String(DEFAULT_REMINDER_DAYS));

  const periods = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const snapshots = Array.isArray(snapshotData) ? snapshotData : [];
  const snapshotIds = new Set(snapshots.map((s) => s.periodId));
  const reminderDays = Math.max(
    1,
    Number(
      typeof reminderData?.value === "number"
        ? reminderData.value
        : Number(reminderData?.value ?? DEFAULT_REMINDER_DAYS),
    ) || DEFAULT_REMINDER_DAYS,
  );
  const openPeriods = useMemo(
    () =>
      periods
        .filter((period) => period.status === "OPEN")
        .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()),
    [periods],
  );
  const nextOpenPeriod = openPeriods[0] || null;
  const daysToPeriodEnd = nextOpenPeriod ? daysUntil(nextOpenPeriod.endDate) : null;
  const showReminder =
    nextOpenPeriod !== null &&
    daysToPeriodEnd !== null &&
    daysToPeriodEnd <= reminderDays &&
    daysToPeriodEnd >= 0;
  const checklistComplete = CLOSE_CHECKLIST_ITEMS.every((item) => checklistState[item.key]);

  useEffect(() => {
    setReminderDaysInput(String(reminderDays));
  }, [reminderDays]);

  const createPeriod = async () => {
    if (!name || !startDate || !endDate) {
      toast.error("Provide name and dates.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, startDate, endDate }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create period.");
      toast.success("Fiscal period created.");
      setName("");
      setStartDate("");
      setEndDate("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create period.");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (period: FiscalPeriod, status: "OPEN" | "CLOSED") => {
    try {
      const res = await fetch(`/api/admin/accounting/periods/${period.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update period.");
      toast.success(`Period ${status === "CLOSED" ? "closed" : "reopened"}.`);
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
      return true;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update period.");
      return false;
    }
  };

  const openCloseDialog = async (period: FiscalPeriod) => {
    setClosePeriod(period);
    setCloseOpen(true);
    setAllowOverride(false);
    setOverrideReason("");
    setChecklistState({
      bankReviewed: false,
      cashReviewed: false,
      arApReviewed: false,
      inventoryReviewed: false,
      vatReviewed: false,
    });
    try {
      const res = await fetch(`/api/admin/accounting/periods/${period.id}/checklist`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to load checklist.");
      setChecklist({
        draftEntries: Number(j.draftEntries || 0),
        openReconciliations: Number(j.openReconciliations || 0),
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load checklist.");
    }
  };

  const handleClose = async () => {
    if (!closePeriod) return;
    const normalizedOverride = overrideReason.trim();
    if (!checklistComplete && (!allowOverride || !normalizedOverride)) {
      toast.error("Complete checklist or provide an override reason.");
      return;
    }
    try {
      setClosing(true);
      const res = await fetch(`/api/admin/accounting/periods/${closePeriod.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "CLOSED",
          checklistConfirmed: checklistComplete,
          overrideReason: checklistComplete ? undefined : normalizedOverride,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to close period.");
      toast.success("Period closed.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
      const ok = true;
      if (ok) {
        setCloseOpen(false);
        setChecklist(null);
        setClosePeriod(null);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to close period.");
    } finally {
      setClosing(false);
    }
  };

  const saveReminderThreshold = async () => {
    const parsed = Number(reminderDaysInput);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      toast.error("Reminder days must be between 1 and 60.");
      return;
    }
    try {
      setSavingReminder(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.periodClose.reminderDays",
          value: Math.trunc(parsed),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save reminder setting.");
      toast.success("Reminder threshold saved.");
      queryClient.invalidateQueries({
        queryKey: ["app-setting", "accounting.periodClose.reminderDays"],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reminder setting.");
    } finally {
      setSavingReminder(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Fiscal Periods</h1>
        <p className="text-sm text-muted-foreground">
          Closing a period prevents new postings inside its date range.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Period-end reminder</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Show reminder when open period end is within this many days.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={60}
              className="w-28"
              value={reminderDaysInput}
              onChange={(e) => setReminderDaysInput(e.target.value)}
            />
            <Button onClick={saveReminderThreshold} disabled={savingReminder}>
              {savingReminder ? "Saving..." : "Save reminder days"}
            </Button>
          </div>
          {showReminder && nextOpenPeriod ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Period <span className="font-medium">{nextOpenPeriod.name}</span> ends in{" "}
              <span className="font-medium">{daysToPeriodEnd}</span> day(s) on{" "}
              <span className="font-medium">{new Date(nextOpenPeriod.endDate).toLocaleDateString()}</span>.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pre-close checklist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            This checklist is enforced when you click <span className="font-medium">Close period</span>.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {CLOSE_CHECKLIST_ITEMS.map((item) => (
              <li key={item.key}>{item.label}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            If any item is not complete, use override and provide reason in the close dialog.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create period</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Period name (e.g. Jan 2025)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createPeriod} disabled={saving}>
              {saving ? "Saving..." : "Create period"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {periods.length === 0 ? (
            <p className="text-muted-foreground">No fiscal periods yet.</p>
          ) : (
            periods.map((period) => (
              <div key={period.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                <div>
                  <div className="font-medium">{period.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(period.startDate).toLocaleDateString()} - {new Date(period.endDate).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <span className="text-xs">{period.status}</span>
                  {snapshotIds.has(period.id) ? (
                    <span className="text-[11px] rounded bg-emerald-100 px-2 py-1 text-emerald-700">
                      Snapshot saved
                    </span>
                  ) : null}
                  {period.status === "OPEN" ? (
                    <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => openCloseDialog(period)}>
                      Close period
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => updateStatus(period, "OPEN")}>
                      Reopen
                    </Button>
                  )}
                  <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                    <a href={`/admin/accounting/periods/${period.id}/snapshot`}>Close report</a>
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close period</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p className="text-muted-foreground">
              Review this checklist before closing {closePeriod?.name || "the period"}.
            </p>
            <div className="flex justify-between">
              <span>Draft journal entries</span>
              <span>{checklist?.draftEntries ?? "-"}</span>
            </div>
            <div className="flex justify-between">
              <span>Open reconciliations</span>
              <span>{checklist?.openReconciliations ?? "-"}</span>
            </div>
            {checklist && checklist.draftEntries > 0 ? (
              <p className="text-xs text-muted-foreground">
                Close blocked until draft entries are posted or voided.
              </p>
            ) : null}
            {checklist && checklist.openReconciliations > 0 ? (
              <p className="text-xs text-muted-foreground">
                Consider closing reconciliations that overlap this period.
              </p>
            ) : null}
            <div className="border rounded p-3 space-y-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">Required checklist</p>
              {CLOSE_CHECKLIST_ITEMS.map((item) => (
                <label key={item.key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checklistState[item.key]}
                    onChange={(e) =>
                      setChecklistState((prev) => ({
                        ...prev,
                        [item.key]: e.target.checked,
                      }))
                    }
                  />
                  <span>{item.label}</span>
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowOverride}
                  onChange={(e) => setAllowOverride(e.target.checked)}
                />
                <span>Allow override (admin/accountant must provide reason).</span>
              </label>
              {allowOverride ? (
                <Input
                  placeholder="Override reason (required if checklist not complete)"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              ) : null}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClose}
              disabled={
                closing ||
                (checklist?.draftEntries ?? 0) > 0 ||
                (!checklistComplete && (!allowOverride || !overrideReason.trim()))
              }
            >
              {closing ? "Closing..." : "Close period"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
