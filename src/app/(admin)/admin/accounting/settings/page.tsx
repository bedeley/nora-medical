"use client";

import { useEffect, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type ThresholdConfig = {
  arDifference: number;
  inventoryDifference: number;
  draftEntries: boolean;
  negativeStock: boolean;
};
type StoreCreditApplyPolicy =
  | "oldest_first"
  | "current_order_first"
  | "manual_apply_only";

export default function AccountingSettingsPage() {
  const { data, refetch } = useClientQuery<{ value: ThresholdConfig | null }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const { data: ledgerModeData, refetch: refetchLedgerMode } = useClientQuery<{ value: boolean | null }>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.reporting.useLedger").then((r) => r.json()),
  });
  const { data: storeCreditPolicyData, refetch: refetchStoreCreditPolicy } = useClientQuery<{
    value: StoreCreditApplyPolicy | null;
  }>({
    queryKey: ["accounting", "store-credit", "apply-policy"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.storeCredit.applyPolicy").then((r) =>
        r.json(),
      ),
  });
  const { data: bankTxnEditWindowData, refetch: refetchBankTxnEditWindow } = useClientQuery<{
    value: number | string | null;
  }>({
    queryKey: ["accounting", "bank-transactions", "edit-window-days"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.bankTransactions.editWindowDays").then((r) =>
        r.json(),
      ),
  });

  const [arDifference, setArDifference] = useState("");
  const [inventoryDifference, setInventoryDifference] = useState("");
  const [draftEntries, setDraftEntries] = useState(true);
  const [negativeStock, setNegativeStock] = useState(true);
  const [saving, setSaving] = useState(false);
  const [useLedger, setUseLedger] = useState(false);
  const [savingLedger, setSavingLedger] = useState(false);
  const [storeCreditPolicy, setStoreCreditPolicy] =
    useState<StoreCreditApplyPolicy>("oldest_first");
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [bankTxnEditWindowDays, setBankTxnEditWindowDays] = useState("");
  const [savingBankTxnEditWindow, setSavingBankTxnEditWindow] = useState(false);

  const current = data?.value;
  const displayAr = arDifference !== "" ? arDifference : String(current?.arDifference ?? 0.01);
  const displayInventory =
    inventoryDifference !== "" ? inventoryDifference : String(current?.inventoryDifference ?? 0.01);

  useEffect(() => {
    if (ledgerModeData?.value === null || ledgerModeData?.value === undefined) return;
    setUseLedger(Boolean(ledgerModeData.value));
  }, [ledgerModeData?.value]);
  useEffect(() => {
    const value = String(storeCreditPolicyData?.value || "").trim().toLowerCase();
    if (value === "oldest_first" || value === "current_order_first" || value === "manual_apply_only") {
      setStoreCreditPolicy(value as StoreCreditApplyPolicy);
      return;
    }
    setStoreCreditPolicy("oldest_first");
  }, [storeCreditPolicyData?.value]);
  useEffect(() => {
    const raw = bankTxnEditWindowData?.value;
    const next = Number(
      typeof raw === "number" ? raw : typeof raw === "string" ? raw : 7,
    );
    if (!Number.isFinite(next)) {
      setBankTxnEditWindowDays("7");
      return;
    }
    setBankTxnEditWindowDays(String(Math.min(365, Math.max(0, Math.floor(next)))));
  }, [bankTxnEditWindowData?.value]);

  const saveSettings = async () => {
    const arVal = Number(displayAr);
    const invVal = Number(displayInventory);
    if (!Number.isFinite(arVal) || arVal < 0) {
      toast.error("Enter a valid AR difference threshold.");
      return;
    }
    if (!Number.isFinite(invVal) || invVal < 0) {
      toast.error("Enter a valid inventory difference threshold.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.integrity.thresholds",
          value: {
            arDifference: arVal,
            inventoryDifference: invVal,
            draftEntries,
            negativeStock,
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save settings.");
      toast.success("Settings saved.");
      setArDifference("");
      setInventoryDifference("");
      refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const saveLedgerMode = async () => {
    try {
      setSavingLedger(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.reporting.useLedger",
          value: useLedger,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save reporting mode.");
      toast.success("Reporting mode updated.");
      refetchLedgerMode();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reporting mode.");
    } finally {
      setSavingLedger(false);
    }
  };
  const saveStoreCreditPolicy = async () => {
    try {
      setSavingPolicy(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.storeCredit.applyPolicy",
          value: storeCreditPolicy,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save store-credit policy.");
      toast.success("Store-credit policy updated.");
      refetchStoreCreditPolicy();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save store-credit policy.");
    } finally {
      setSavingPolicy(false);
    }
  };
  const saveBankTxnEditWindow = async () => {
    const numeric = Number(bankTxnEditWindowDays);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 365) {
      toast.error("Enter a valid edit window in days (0 to 365).");
      return;
    }
    try {
      setSavingBankTxnEditWindow(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.bankTransactions.editWindowDays",
          value: Math.floor(numeric),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save transaction edit window.");
      toast.success("Bank transaction edit window updated.");
      refetchBankTxnEditWindow();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save transaction edit window.");
    } finally {
      setSavingBankTxnEditWindow(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Accounting Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure integrity thresholds and alert behavior.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Integrity thresholds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
          <Input
            placeholder="AR difference threshold (GHS)"
            inputMode="decimal"
            value={displayAr}
            onChange={(e) => setArDifference(e.target.value)}
          />
          <Input
            placeholder="Inventory difference threshold (GHS)"
            inputMode="decimal"
            value={displayInventory}
            onChange={(e) => setInventoryDifference(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draftEntries}
              onChange={(e) => setDraftEntries(e.target.checked)}
            />
            Alert on draft journal entries
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={negativeStock}
              onChange={(e) => setNegativeStock(e.target.checked)}
            />
            Alert on negative stock
          </label>
          <div className="sm:col-span-2 lg:col-span-2">
            <Button className="w-full sm:w-auto" onClick={saveSettings} disabled={saving}>
              {saving ? "Saving..." : "Save settings"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reporting source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={useLedger}
              onChange={(e) => setUseLedger(e.target.checked)}
            />
            Use accounting ledger for dashboard and main P&amp;L
          </label>
          <p className="text-xs text-muted-foreground">
            When enabled, the admin dashboard and main P&amp;L use journal entries instead
            of orders/expenses to compute revenue, COGS, and profit. Other KPIs remain operational.
          </p>
          <Button className="w-full sm:w-auto" onClick={saveLedgerMode} disabled={savingLedger}>
            {savingLedger ? "Saving..." : "Save reporting mode"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Store credit auto-apply policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm w-full sm:w-auto min-w-[320px]"
            value={storeCreditPolicy}
            onChange={(e) =>
              setStoreCreditPolicy(e.target.value as StoreCreditApplyPolicy)
            }
          >
            <option value="oldest_first">Oldest open balances first (recommended)</option>
            <option value="current_order_first">Current order first, then oldest balances</option>
            <option value="manual_apply_only">Manual apply only (no checkout auto-apply)</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Controls how store credit is consumed during checkout. Manual Apply actions in
            customer pages still work in all modes.
          </p>
          <Button className="w-full sm:w-auto" onClick={saveStoreCreditPolicy} disabled={savingPolicy}>
            {savingPolicy ? "Saving..." : "Save store-credit policy"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bank transaction edit policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Input
            placeholder="Edit window (days)"
            inputMode="numeric"
            value={bankTxnEditWindowDays}
            onChange={(e) => setBankTxnEditWindowDays(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Transactions older than this window require ADMIN override reason. Closed-period transactions remain locked.
          </p>
          <Button className="w-full sm:w-auto" onClick={saveBankTxnEditWindow} disabled={savingBankTxnEditWindow}>
            {savingBankTxnEditWindow ? "Saving..." : "Save edit policy"}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
