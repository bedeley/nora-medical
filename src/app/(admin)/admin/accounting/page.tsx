"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

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

const DEFAULT_PERIOD_REMINDER_DAYS = 7;

function daysUntil(dateText: string) {
  const now = new Date();
  const target = new Date(`${dateText.slice(0, 10)}T23:59:59.999`);
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

export default function AccountingHomePage() {
  const [equityOpen, setEquityOpen] = useState(false);
  const [equityAmount, setEquityAmount] = useState("");
  const [equityNotes, setEquityNotes] = useState("");
  const [equitySource, setEquitySource] = useState<"CASH" | "BANK">("CASH");
  const [equityBankId, setEquityBankId] = useState("");
  const [equitySaving, setEquitySaving] = useState(false);

  const { data: bankAccounts } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetch("/api/admin/accounting/banks").then((r) => r.json()),
  });

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

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Manage your chart of accounts, journals, and tax settings.
        </p>
      </div>
      <IntegrityBanner />
      <PeriodCloseReminderBanner />
      <AccountingSnapshot />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Chart of Accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Maintain your ledger structure and account groupings.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/accounts">Open accounts</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Journal Entries</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Create and review entries that power reporting.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/journal">Open journal</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tax Codes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Configure VAT rates and tax treatments.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/tax-codes">Manage VAT</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>View P&amp;L, balance sheet, and trial balance.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/reports">Open reports</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Inventory Valuation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Compare ledger inventory to stock valuation and post adjustments.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/inventory-valuation">Open valuation</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AR/AP Aging</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>See overdue customer and supplier balances by age.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/aging">Open aging</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bank Reconciliation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Connect bank activity to ledger entries.</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/accounting/reconciliations">Open reconciliations</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cash Reconciliation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Record cash counts and post over/short adjustments.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/cash-reconciliations">Open cash reconciliation</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Owner Equity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Record owner equity contributions without manual journal entry.</p>
            <Button size="sm" variant="outline" onClick={() => setEquityOpen(true)}>
              Record equity
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bank Accounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Manage bank accounts, transactions, and matching rules.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/banks">Open banks</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Fiscal Periods</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Open or close periods to lock posting windows.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/periods">Manage periods</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Data Integrity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Review checks for accounting data consistency.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/integrity">View checks</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reconcile Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Compare operational totals to ledger totals and spot deltas.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/reconcile">Open reconcile</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Accounting Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Configure integrity thresholds and alerts.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/settings">Open settings</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Posting Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Choose which accounts auto-posting uses for core transactions.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/posting-rules">Open rules</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

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
    </section>
  );
}

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
    .filter((period) => period.status === "OPEN")
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())[0];

  if (!nextOpenPeriod) return null;
  const remaining = daysUntil(nextOpenPeriod.endDate);
  if (remaining < 0 || remaining > reminderDays) return null;

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardContent className="py-3 text-sm flex flex-wrap items-center justify-between gap-2">
        <span className="text-amber-900">
          Period close reminder: <span className="font-medium">{nextOpenPeriod.name}</span> ends in{" "}
          <span className="font-medium">{remaining}</span> day(s) on{" "}
          <span className="font-medium">{new Date(nextOpenPeriod.endDate).toLocaleDateString()}</span>.
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function IntegrityBanner() {
  const { data: prefData } = useClientQuery<{ value: { arDifference: number; inventoryDifference: number; draftEntries: boolean; negativeStock: boolean } | null }>({
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
    data && Math.abs(data.inventoryDifference || 0) > thresholds.inventoryDifference ? "Inventory mismatch" : null,
    thresholds.negativeStock && data?.negativeStockCount
      ? `${data.negativeStockCount} negative stock item(s)`
      : null,
  ].filter(Boolean);

  if (!data || issues.length === 0) return null;

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardContent className="py-3 text-sm flex flex-wrap items-center justify-between gap-2">
        <span className="text-amber-900">
          Integrity alerts: {issues.join(", ")}.
        </span>
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/accounting/integrity">Review</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function AccountingSnapshot() {
  const { data } = useClientQuery<OverviewResponse>({
    queryKey: ["accounting", "reports", "overview"],
    queryFn: () => fetch("/api/admin/accounting/reports/overview").then((r) => r.json()),
  });
  const snapshot = data?.snapshot;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Snapshot</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex justify-between">
          <span>Net cash</span>
          <span>{formatCurrency(snapshot?.netCash || 0)}</span>
        </div>
        <div className="flex justify-between">
          <span>Accounts receivable</span>
          <span>{formatCurrency(snapshot?.accountsReceivable || 0)}</span>
        </div>
        <div className="flex justify-between">
          <span>Accounts payable</span>
          <span>{formatCurrency(snapshot?.accountsPayable || 0)}</span>
        </div>
        <div className="flex justify-between">
          <span>VAT payable</span>
          <span>{formatCurrency(snapshot?.vatPayable || 0)}</span>
        </div>
        <div className="flex justify-between">
          <span>Inventory</span>
          <span>{formatCurrency(snapshot?.inventory || 0)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Cash</span>
          <span>{formatCurrency(snapshot?.cash || 0)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Bank</span>
          <span>{formatCurrency(snapshot?.bank || 0)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
