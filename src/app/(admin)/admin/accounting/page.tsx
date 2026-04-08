"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import {
  OPENING_RETAINED_EARNINGS_SETTING_KEY,
  parseOpeningRetainedEarningsValue,
  type OpeningRetainedEarningsValue,
} from "@/lib/opening-retained-earnings";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

type OverviewResponse = {
  snapshot: {
    cash: number;
    bank: number;
    netCash: number;
    accountsReceivable: number;
    accountsPayable: number;
    vatPayable: number;
    inventory: number;
  };
};

type IntegrityResponse = {
  draftEntries: number;
  arDifference: number;
  inventoryDifference: number;
  negativeStockCount: number;
};

type BankAccount = {
  id: string;
  name: string;
  bankName: string | null;
  accountNumberMasked: string | null;
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

type AppSettingResponse = { key: string; value: unknown };

type AgingResponse = {
  type: "ar" | "ap";
  totals: {
    total: number;
    buckets: { "0-30": number; "31-60": number; "61-90": number; "90+": number };
  };
};

type ReconciliationsResponse = {
  summary: {
    total: number;
    draft: number;
    inProgress: number;
    closed: number;
  };
};

type JournalEntry = {
  id: string;
  entryDate: string;
  memo: string;
  status: "DRAFT" | "POSTED" | "VOID";
  sourceType: string;
  lines: Array<{ debit: number; credit: number }>;
};

type JournalListResponse = {
  items: JournalEntry[];
};

type PeriodChecklistResponse = {
  month: string;
  isClosed: boolean;
  draftEntries: number;
  openReconciliations: number;
  blockers: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PERIOD_REMINDER_DAYS = 7;

function daysUntil(dateText: string) {
  const now = new Date();
  const target = new Date(`${dateText.slice(0, 10)}T23:59:59.999`);
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────

// Clickable module card — the whole card navigates
function ModuleCard({
  title,
  description,
  href,
  badge,
}: {
  title: string;
  description: string;
  href: string;
  badge?: number;
}) {
  return (
    <Link href={href} className="group block h-full">
      <Card className="h-full transition-colors hover:border-foreground/30 hover:bg-muted/30">
        <CardContent className="p-4 space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{title}</p>
            {badge != null && badge > 0 && (
              <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap">
                {badge} pending
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground leading-snug">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

// Action card — for in-page actions like dialogs
function ActionCard({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Card className="h-full">
      <CardContent className="p-4 flex flex-col gap-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground leading-snug">{description}</p>
        </div>
        <Button size="sm" variant="outline" className="w-full mt-auto" onClick={onAction}>
          {actionLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

// Section group with label and responsive grid
function SectionGroup({
  title,
  cols = 4,
  children,
}: {
  title: string;
  cols?: 2 | 3 | 4;
  children: React.ReactNode;
}) {
  const colClass =
    cols === 2
      ? "sm:grid-cols-2"
      : cols === 3
      ? "sm:grid-cols-2 lg:grid-cols-3"
      : "sm:grid-cols-2 lg:grid-cols-4";

  return (
    <div className="space-y-2">
      <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest px-0.5">
        {title}
      </h2>
      <div className={`grid gap-3 ${colClass}`}>{children}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AccountingHomePage() {
  const [equityOpen, setEquityOpen] = useState(false);
  const [equityAmount, setEquityAmount] = useState("");
  const [equityNotes, setEquityNotes] = useState("");
  const [equitySource, setEquitySource] = useState<"CASH" | "BANK">("CASH");
  const [equityBankId, setEquityBankId] = useState("");
  const [equitySaving, setEquitySaving] = useState(false);
  const [openingRetainedEarningsOpen, setOpeningRetainedEarningsOpen] = useState(false);
  const [openingRetainedEarningsAmount, setOpeningRetainedEarningsAmount] = useState("");
  const [openingRetainedEarningsDate, setOpeningRetainedEarningsDate] = useState(new Date().toISOString().slice(0, 10));
  const [openingRetainedEarningsNotes, setOpeningRetainedEarningsNotes] = useState("");
  const [openingRetainedEarningsSaving, setOpeningRetainedEarningsSaving] = useState(false);

  const { data: bankAccounts } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetch("/api/admin/accounting/banks").then((r) => r.json()),
  });
  const {
    data: openingRetainedEarningsSetting,
    refetch: refetchOpeningRetainedEarningsSetting,
  } = useClientQuery<AppSettingResponse>({
    queryKey: ["app-setting", OPENING_RETAINED_EARNINGS_SETTING_KEY],
    queryFn: () =>
      fetch(`/api/admin/settings/app?key=${encodeURIComponent(OPENING_RETAINED_EARNINGS_SETTING_KEY)}`).then((r) => r.json()),
  });
  const openingRetainedEarnings = parseOpeningRetainedEarningsValue(openingRetainedEarningsSetting?.value) as OpeningRetainedEarningsValue | null;

  // Fetch reconciliation summary for the Bank Reconciliation card badge
  const { data: reconData } = useClientQuery<ReconciliationsResponse>({
    queryKey: ["accounting", "reconciliations", "summary"],
    queryFn: () => fetch("/api/admin/accounting/reconciliations").then((r) => r.json()),
  });
  const reconPending =
    reconData?.summary != null
      ? reconData.summary.draft + reconData.summary.inProgress
      : undefined;

  const submitEquity = async () => {
    const amount = Number(equityAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid equity amount.");
      return;
    }
    if (equitySource === "BANK" && !equityBankId) {
      toast.error("Select the bank account for this deposit.");
      return;
    }
    try {
      setEquitySaving(true);
      const res = await fetch("/api/admin/accounting/equity-contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          notes: equityNotes.trim() || undefined,
          source: equitySource,
          bankAccountId: equitySource === "BANK" ? equityBankId : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to record owner equity.");
      toast.success("Owner equity recorded.");
      setEquityAmount("");
      setEquityNotes("");
      setEquitySource("CASH");
      setEquityBankId("");
      setEquityOpen(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to record owner equity.");
    } finally {
      setEquitySaving(false);
    }
  };

  const submitOpeningRetainedEarnings = async () => {
    const amount = Number(openingRetainedEarningsAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid retained earnings amount.");
      return;
    }
    if (!openingRetainedEarningsDate) {
      toast.error("Select the effective date for the opening retained earnings entry.");
      return;
    }
    try {
      setOpeningRetainedEarningsSaving(true);
      const res = await fetch("/api/admin/accounting/opening-retained-earnings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          entryDate: openingRetainedEarningsDate,
          notes: openingRetainedEarningsNotes.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to record opening retained earnings.");
      toast.success("Opening retained earnings configured.");
      setOpeningRetainedEarningsAmount("");
      setOpeningRetainedEarningsNotes("");
      setOpeningRetainedEarningsOpen(false);
      await refetchOpeningRetainedEarningsSetting();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to record opening retained earnings.");
      await refetchOpeningRetainedEarningsSetting();
    } finally {
      setOpeningRetainedEarningsSaving(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-8">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Accounting</h1>
          <p className="text-sm text-muted-foreground">
            Journals, reconciliations, and financial reporting.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/accounting/journal?new=1">+ New Journal Entry</Link>
        </Button>
      </div>

      {/* Alert banners */}
      <div className="space-y-2">
        <IntegrityBanner />
        <PeriodCloseReminderBanner />
      </div>

      {/* Financial position snapshot */}
      <AccountingSnapshot />

      {/* Recent journal activity */}
      <RecentJournalActivity />

      {/* Module groups */}
      <div className="space-y-7">
        <SectionGroup title="Transactions & Ledger">
          <ModuleCard
            title="Journal Entries"
            description="Create, post, and review all accounting entries."
            href="/admin/accounting/journal"
          />
          <ModuleCard
            title="Chart of Accounts"
            description="Maintain ledger structure and account groupings."
            href="/admin/accounting/accounts"
          />
          <ModuleCard
            title="Posting Rules"
            description="Configure which accounts auto-posting uses for core transactions."
            href="/admin/accounting/posting-rules"
          />
          <ModuleCard
            title="Tax Codes"
            description="Manage VAT rates and tax treatment codes."
            href="/admin/accounting/tax-codes"
          />
        </SectionGroup>

        <SectionGroup title="Reconciliation & Banking">
          <ModuleCard
            title="Bank Reconciliation"
            description="Match bank statements to ledger entries."
            href="/admin/accounting/reconciliations"
            badge={reconPending}
          />
          <ModuleCard
            title="Cash Reconciliation"
            description="Record daily cash counts and post over/short adjustments."
            href="/admin/accounting/cash-reconciliations"
          />
          <ModuleCard
            title="Reconcile Totals"
            description="Compare operational totals to ledger and spot discrepancies."
            href="/admin/accounting/reconcile"
          />
          <ModuleCard
            title="Bank Accounts"
            description="Manage bank accounts, transactions, and matching rules."
            href="/admin/accounting/banks"
          />
        </SectionGroup>

        <SectionGroup title="Receivables, Payables & Inventory" cols={3}>
          <ModuleCard
            title="AR Aging"
            description="Overdue customer balances broken down by age bucket."
            href="/admin/accounting/aging?type=ar"
          />
          <ModuleCard
            title="AP Aging"
            description="Overdue supplier payables broken down by age bucket."
            href="/admin/accounting/aging?type=ap"
          />
          <ModuleCard
            title="Inventory Valuation"
            description="Compare ledger inventory to stock valuation and post adjustments."
            href="/admin/accounting/inventory-valuation"
          />
        </SectionGroup>

        <SectionGroup title="Reports & Compliance" cols={3}>
          <ModuleCard
            title="Financial Reports"
            description="P&L, balance sheet, trial balance, and VAT reports."
            href="/admin/accounting/reports"
          />
          <ModuleCard
            title="Profit & Loss"
            description="Detailed income and expense statement with period comparison."
            href="/admin/profit-loss"
          />
          <ModuleCard
            title="VAT Filings"
            description="View and manage saved VAT filing snapshots and submissions."
            href="/admin/accounting/vat-filings"
          />
        </SectionGroup>

        <SectionGroup title="Administration">
          <ModuleCard
            title="Fiscal Periods"
            description="Open or close periods to lock posting windows."
            href="/admin/accounting/periods"
          />
          <ModuleCard
            title="Data Integrity"
            description="Automated checks for accounting data consistency."
            href="/admin/accounting/integrity"
          />
          <ActionCard
            title="Owner Equity"
            description="Record owner contributions without a manual journal entry."
            actionLabel="Record contribution"
            onAction={() => setEquityOpen(true)}
          />
          <ActionCard
            title="Opening Retained Earnings"
            description={
              openingRetainedEarnings
                ? `Configured on ${new Date(openingRetainedEarnings.entryDate).toLocaleDateString()}. One-time go-live setup is locked.`
                : "One-time go-live setup to move historical retained earnings from Opening Balance Equity into retained earnings."
            }
            actionLabel={openingRetainedEarnings ? "View setup" : "Set opening balance"}
            onAction={() => setOpeningRetainedEarningsOpen(true)}
          />
          <ModuleCard
            title="Settings"
            description="Configure integrity thresholds and alert preferences."
            href="/admin/accounting/settings"
          />
        </SectionGroup>
      </div>

      {/* Owner equity dialog */}
      <Dialog open={equityOpen} onOpenChange={setEquityOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record owner equity</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Deposit to
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                value={equitySource}
                onChange={(e) => setEquitySource(e.target.value as "CASH" | "BANK")}
              >
                <option value="CASH">Cash (on hand)</option>
                <option value="BANK">Bank account</option>
              </select>
            </label>
            {equitySource === "BANK" ? (
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Bank account
                <select
                  className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={equityBankId}
                  onChange={(e) => setEquityBankId(e.target.value)}
                >
                  <option value="">Select bank</option>
                  {(bankAccounts || []).map((acct) => (
                    <option key={acct.id} value={acct.id}>
                      {acct.name}
                      {acct.bankName ? ` · ${acct.bankName}` : ""}
                      {acct.accountNumberMasked ? ` · ${acct.accountNumberMasked}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Input
              placeholder="Equity amount"
              inputMode="decimal"
              value={equityAmount}
              onChange={(e) => setEquityAmount(e.target.value)}
            />
            <Input
              placeholder="Notes (optional)"
              value={equityNotes}
              onChange={(e) => setEquityNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEquityOpen(false)} disabled={equitySaving}>
              Cancel
            </Button>
            <Button onClick={submitEquity} disabled={equitySaving}>
              {equitySaving ? "Saving..." : "Save equity"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openingRetainedEarningsOpen} onOpenChange={setOpeningRetainedEarningsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Opening retained earnings</DialogTitle>
            <DialogDescription>
              One-time go-live setup. This debits Opening Balance Equity and credits Retained Earnings.
            </DialogDescription>
          </DialogHeader>
          {openingRetainedEarnings ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <p className="font-medium">Already configured</p>
                <p className="text-muted-foreground">
                  Amount: {formatCurrency(openingRetainedEarnings.amount)}
                </p>
                <p className="text-muted-foreground">
                  Effective date: {new Date(openingRetainedEarnings.entryDate).toLocaleDateString()}
                </p>
                <p className="text-muted-foreground">
                  Journal entry: {openingRetainedEarnings.journalEntryId}
                </p>
                {openingRetainedEarnings.notes ? (
                  <p className="text-muted-foreground">Notes: {openingRetainedEarnings.notes}</p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                This setup is locked after first use. If finance needs a correction later, use a controlled journal adjustment rather than rerunning the setup.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpeningRetainedEarningsOpen(false)}>
                  Close
                </Button>
                <Button asChild>
                  <Link href={`/admin/accounting/journal?entry=${encodeURIComponent(openingRetainedEarnings.journalEntryId)}`}>
                    Open journal entry
                  </Link>
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <>
              <div className="grid gap-3 text-sm">
                <p className="text-xs text-muted-foreground">
                  Use this once after loading opening balances. It reclassifies a portion of Opening Balance Equity into Retained Earnings for pre-app history.
                </p>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  Effective date
                  <Input
                    type="date"
                    value={openingRetainedEarningsDate}
                    onChange={(e) => setOpeningRetainedEarningsDate(e.target.value)}
                  />
                </label>
                <Input
                  placeholder="Retained earnings amount"
                  inputMode="decimal"
                  value={openingRetainedEarningsAmount}
                  onChange={(e) => setOpeningRetainedEarningsAmount(e.target.value)}
                />
                <Input
                  placeholder="Notes (optional)"
                  value={openingRetainedEarningsNotes}
                  onChange={(e) => setOpeningRetainedEarningsNotes(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpeningRetainedEarningsOpen(false)} disabled={openingRetainedEarningsSaving}>
                  Cancel
                </Button>
                <Button onClick={submitOpeningRetainedEarnings} disabled={openingRetainedEarningsSaving}>
                  {openingRetainedEarningsSaving ? "Saving..." : "Save opening retained earnings"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Alert banners ────────────────────────────────────────────────────────────

function PeriodCloseReminderBanner() {
  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const { data: reminderData } = useClientQuery<AppSettingResponse>({
    queryKey: ["app-setting", "accounting.periodClose.reminderDays"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.periodClose.reminderDays").then((r) => r.json()),
  });

  const periods = Array.isArray(periodsData) ? periodsData : [];
  const reminderDays = Math.max(
    1,
    Number(
      typeof reminderData?.value === "number"
        ? reminderData.value
        : Number(reminderData?.value ?? DEFAULT_PERIOD_REMINDER_DAYS),
    ) || DEFAULT_PERIOD_REMINDER_DAYS,
  );

  const nextOpenPeriod = periods
    .filter((p) => p.status === "OPEN")
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())[0];

  const remaining = nextOpenPeriod ? daysUntil(nextOpenPeriod.endDate) : Infinity;
  const shouldShow = Boolean(nextOpenPeriod && remaining >= 0 && remaining <= reminderDays);
  // Derive the month string (YYYY-MM) for the checklist API
  const month = nextOpenPeriod ? nextOpenPeriod.endDate.slice(0, 7) : "";

  // Fetch close checklist — enabled only when the banner is going to show
  const { data: checklist } = useClientQuery<PeriodChecklistResponse>({
    queryKey: ["accounting", "period-checklist", month],
    queryFn: () =>
      fetch(`/api/admin/accounting/periods/monthly-close/checklist?month=${month}`).then((r) =>
        r.json(),
      ),
    enabled: Boolean(shouldShow && month),
  });

  if (!shouldShow || !nextOpenPeriod) return null;

  const draftOk = checklist ? checklist.draftEntries === 0 : null;
  const reconOk = checklist ? checklist.openReconciliations === 0 : null;
  const doneCount = (draftOk ? 1 : 0) + (reconOk ? 1 : 0);
  const totalItems = 2;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-amber-900">
          <svg
            className="h-4 w-4 shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 5v3.5l2 1.5" strokeLinecap="round" />
          </svg>
          <span>
            Period close:{" "}
            <span className="font-medium">{nextOpenPeriod.name}</span> ends in{" "}
            <span className="font-medium">{remaining}</span> day{remaining !== 1 ? "s" : ""} on{" "}
            <span className="font-medium">
              {new Date(nextOpenPeriod.endDate).toLocaleDateString()}
            </span>
            .
          </span>
        </div>
        <Button
          asChild
          size="sm"
          variant="outline"
          className="border-amber-300 hover:bg-amber-100 text-amber-900"
        >
          <Link href="/admin/accounting/periods">Manage periods</Link>
        </Button>
      </div>

      {/* Pre-close checklist */}
      {checklist && (
        <div className="pt-1 border-t border-amber-200">
          <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wide mb-1.5">
            Pre-close checklist — {doneCount} of {totalItems} complete
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <ChecklistItem
              done={draftOk}
              okLabel="No draft journal entries"
              failLabel={`${checklist.draftEntries} draft entr${checklist.draftEntries === 1 ? "y" : "ies"} pending`}
              href="/admin/accounting/journal"
            />
            <ChecklistItem
              done={reconOk}
              okLabel="All reconciliations closed"
              failLabel={`${checklist.openReconciliations} open reconciliation${checklist.openReconciliations === 1 ? "" : "s"}`}
              href="/admin/accounting/reconciliations"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ChecklistItem({
  done,
  okLabel,
  failLabel,
  href,
}: {
  done: boolean | null;
  okLabel: string;
  failLabel: string;
  href: string;
}) {
  if (done === null) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-700">
        <span className="inline-block h-3 w-24 rounded bg-amber-200 animate-pulse" />
      </span>
    );
  }
  if (done) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-700">
        <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2.5 7l3 3 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {okLabel}
      </span>
    );
  }
  return (
    <Link href={href} className="flex items-center gap-1.5 text-xs text-amber-800 hover:underline">
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 3v4M7 9.5h.01" strokeLinecap="round" />
        <circle cx="7" cy="7" r="5.5" />
      </svg>
      {failLabel}
    </Link>
  );
}

function IntegrityBanner() {
  const { data: prefData } = useClientQuery<{
    value: {
      arDifference: number;
      inventoryDifference: number;
      draftEntries: boolean;
      negativeStock: boolean;
    } | null;
  }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const thresholds = {
    arDifference: prefData?.value?.arDifference ?? 0.01,
    inventoryDifference: prefData?.value?.inventoryDifference ?? 0.01,
    draftEntries: prefData?.value?.draftEntries ?? true,
    negativeStock: prefData?.value?.negativeStock ?? true,
  };

  const { data } = useClientQuery<IntegrityResponse>({
    queryKey: ["accounting", "integrity"],
    queryFn: () => fetch("/api/admin/accounting/integrity").then((r) => r.json()),
  });

  const issues = [
    thresholds.draftEntries && data?.draftEntries
      ? `${data.draftEntries} draft journal entr${data.draftEntries === 1 ? "y" : "ies"}`
      : null,
    data && Math.abs(data.arDifference || 0) > thresholds.arDifference ? "AR mismatch" : null,
    data && Math.abs(data.inventoryDifference || 0) > thresholds.inventoryDifference
      ? "Inventory mismatch"
      : null,
    thresholds.negativeStock && data?.negativeStockCount
      ? `${data.negativeStockCount} negative stock item${data.negativeStockCount !== 1 ? "s" : ""}`
      : null,
  ].filter(Boolean);

  if (!data || issues.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <svg
          className="h-4 w-4 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M8 2L1.5 13.5h13L8 2z" strokeLinejoin="round" />
          <path d="M8 6.5v3M8 11.5h.01" strokeLinecap="round" />
        </svg>
        <span>
          <span className="font-semibold">Integrity alert{issues.length > 1 ? "s" : ""}:</span>{" "}
          {issues.join(", ")}.
        </span>
      </div>
      <Button
        asChild
        size="sm"
        variant="outline"
        className="border-amber-300 hover:bg-amber-100 text-amber-900"
      >
        <Link href="/admin/accounting/integrity">Review</Link>
      </Button>
    </div>
  );
}

// ─── Financial position snapshot ─────────────────────────────────────────────

function AccountingSnapshot() {
  const { data, isLoading } = useClientQuery<OverviewResponse>({
    queryKey: ["accounting", "reports", "overview"],
    queryFn: () => fetch("/api/admin/accounting/reports/overview").then((r) => r.json()),
  });

  // Aging breakdown for AR and AP cards — 5 minute stale time (these are expensive queries)
  const { data: arAging } = useClientQuery<AgingResponse>({
    queryKey: ["accounting", "aging", "ar"],
    queryFn: () => fetch("/api/admin/accounting/aging?type=ar").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
  const { data: apAging } = useClientQuery<AgingResponse>({
    queryKey: ["accounting", "aging", "ap"],
    queryFn: () => fetch("/api/admin/accounting/aging?type=ap").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });

  const snapshot = data?.snapshot;

  // Overdue 61+ days for AR and AP
  const arOverdue61 =
    arAging != null
      ? arAging.totals.buckets["61-90"] + arAging.totals.buckets["90+"]
      : null;
  const apOverdue61 =
    apAging != null
      ? apAging.totals.buckets["61-90"] + apAging.totals.buckets["90+"]
      : null;

  type SnapshotCard = {
    label: string;
    value: number | undefined;
    sub: string;
    overdueNote?: string | null;
    href: string;
    positive: boolean | null;
  };

  // Net Cash is split into two cards: Cash on Hand + Bank Balance
  const cards: SnapshotCard[] = [
    {
      label: "Cash on Hand",
      value: snapshot?.cash,
      sub: "Physical cash · cash reconciliations",
      href: "/admin/accounting/cash-reconciliations",
      positive: snapshot == null ? null : (snapshot.cash ?? 0) >= 0,
    },
    {
      label: "Bank Balance",
      value: snapshot?.bank,
      sub: "Across all bank accounts",
      href: "/admin/accounting/banks",
      positive: snapshot == null ? null : (snapshot.bank ?? 0) >= 0,
    },
    {
      label: "Accounts Receivable",
      value: snapshot?.accountsReceivable,
      sub: "Outstanding customer balances",
      overdueNote:
        arOverdue61 != null && arOverdue61 > 0
          ? `${formatCurrency(arOverdue61)} overdue 61+ days`
          : arOverdue61 === 0
          ? "No overdue balances"
          : null,
      href: "/admin/accounting/aging?type=ar",
      positive: snapshot == null ? null : (snapshot.accountsReceivable ?? 0) === 0,
    },
    {
      label: "Accounts Payable",
      value: snapshot?.accountsPayable,
      sub: "Owed to suppliers",
      overdueNote:
        apOverdue61 != null && apOverdue61 > 0
          ? `${formatCurrency(apOverdue61)} overdue 61+ days`
          : apOverdue61 === 0
          ? "All payables current"
          : null,
      href: "/admin/accounting/aging?type=ap",
      positive: snapshot == null ? null : (snapshot.accountsPayable ?? 0) === 0,
    },
    {
      label: "Inventory Value",
      value: snapshot?.inventory,
      sub: "At weighted average cost",
      href: "/admin/accounting/inventory-valuation",
      positive: null,
    },
    {
      label: "VAT Payable",
      value: snapshot?.vatPayable,
      sub: "Output VAT less input VAT",
      href: "/admin/accounting/vat-filings",
      positive: snapshot == null ? null : (snapshot.vatPayable ?? 0) === 0,
    },
  ];

  const borderColor = (positive: boolean | null) => {
    if (positive === null) return "border-l-slate-300";
    return positive ? "border-l-emerald-400" : "border-l-amber-400";
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          Financial Position
        </h2>
        <Link
          href="/admin/accounting/reports"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Full reports →
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="group block">
            <div
              className={`rounded-lg border border-l-4 bg-card p-4 transition-colors hover:bg-muted/30 ${borderColor(c.positive)}`}
            >
              <p className="text-xs text-muted-foreground mb-1">{c.label}</p>
              <p className="text-lg font-semibold tabular-nums">
                {isLoading || c.value == null ? (
                  <span className="inline-block h-5 w-20 rounded bg-muted animate-pulse" />
                ) : (
                  formatCurrency(c.value)
                )}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{c.sub}</p>
              {/* Always render 4th line to keep all cards the same height */}
              <p
                aria-hidden={c.overdueNote == null}
                className={`text-[11px] mt-1 font-medium ${
                  c.overdueNote == null
                    ? "opacity-0 select-none"
                    : c.overdueNote.startsWith("No") || c.overdueNote.startsWith("All")
                    ? "text-emerald-600"
                    : "text-amber-600"
                }`}
              >
                {c.overdueNote ?? "—"}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Recent journal activity ──────────────────────────────────────────────────

function RecentJournalActivity() {
  const { data, isLoading } = useClientQuery<JournalListResponse>({
    queryKey: ["accounting", "journal", "recent"],
    queryFn: () =>
      fetch("/api/admin/accounting/journal?paginate=1&pageSize=5&sortBy=date&sortDir=desc").then(
        (r) => r.json(),
      ),
  });

  const entries = data?.items ?? [];

  // Don't render the section if there's nothing to show after loading
  if (!isLoading && entries.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">
          Recent Activity
        </h2>
        <Link
          href="/admin/accounting/journal"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          View all →
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="h-3.5 w-10 rounded bg-muted animate-pulse" />
                    <div className="h-3.5 w-40 rounded bg-muted animate-pulse" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-4 w-12 rounded-full bg-muted animate-pulse" />
                    <div className="h-3.5 w-16 rounded bg-muted animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ul className="divide-y">
              {entries.map((entry) => {
                const amount = entry.lines.reduce(
                  (sum, line) => sum + Number(line.debit),
                  0,
                );
                const dateStr = new Date(entry.entryDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                });
                const label =
                  entry.memo?.trim() ||
                  entry.sourceType.charAt(0) + entry.sourceType.slice(1).toLowerCase();

                const statusStyle =
                  entry.status === "POSTED"
                    ? "bg-emerald-100 text-emerald-700"
                    : entry.status === "DRAFT"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-muted text-muted-foreground";

                return (
                  <li key={entry.id}>
                    <Link
                      href="/admin/accounting/journal"
                      className="flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs text-muted-foreground shrink-0 w-12 tabular-nums">
                          {dateStr}
                        </span>
                        <span className="text-sm truncate">{label}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span
                          className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusStyle}`}
                        >
                          {entry.status}
                        </span>
                        <span className="text-sm tabular-nums font-medium text-right w-24">
                          {formatCurrency(amount)}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
