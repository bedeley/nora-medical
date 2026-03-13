"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type BankAccount = {
  id: string;
  name: string;
  bankName?: string | null;
  accountNumberMasked?: string | null;
  currency: string;
  isActive: boolean;
};

type BankTxn = {
  id: string;
  postedAt: string;
  amount: number | string;
  description?: string | null;
  reference?: string | null;
  type: "DEBIT" | "CREDIT";
  matched: boolean;
};

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
};

type BankMatchRule = {
  id: string;
  name: string;
  matchText: string;
  matchMode: "CONTAINS" | "STARTS_WITH" | "ENDS_WITH" | "REGEX";
  accountId?: string | null;
  account?: LedgerAccount | null;
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  amountTolerance?: number | string | null;
  priority?: number | string | null;
  isActive: boolean;
};

export default function BankAccountsPage() {
  const queryClient = useQueryClient();
  const { data } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetch("/api/admin/accounting/banks").then((r) => r.json()),
  });
  const { data: accountsData } = useClientQuery<LedgerAccount[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetch("/api/admin/accounting/accounts").then((r) => r.json()),
  });
  const banks = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const [selectedBankId, setSelectedBankId] = useState("");
  const activeBank = useMemo(
    () => banks.find((b) => b.id === selectedBankId) || banks[0],
    [banks, selectedBankId],
  );

  const { data: transactions } = useClientQuery<BankTxn[]>({
    queryKey: ["accounting", "bank-transactions", activeBank?.id],
    queryFn: () =>
      fetch(`/api/admin/accounting/banks/${activeBank?.id}/transactions`).then((r) => r.json()),
    enabled: Boolean(activeBank?.id),
  });

  const { data: rulesData } = useClientQuery<BankMatchRule[]>({
    queryKey: ["accounting", "bank-rules", activeBank?.id],
    queryFn: () => fetch(`/api/admin/accounting/banks/${activeBank?.id}/rules`).then((r) => r.json()),
    enabled: Boolean(activeBank?.id),
  });

  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountMasked, setAccountMasked] = useState("");

  const [postedAt, setPostedAt] = useState("");
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"DEBIT" | "CREDIT">("CREDIT");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  const [ruleName, setRuleName] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [ruleMode, setRuleMode] = useState<BankMatchRule["matchMode"]>("CONTAINS");
  const [ruleAccountId, setRuleAccountId] = useState("");
  const [ruleMin, setRuleMin] = useState("");
  const [ruleMax, setRuleMax] = useState("");
  const [ruleTolerance, setRuleTolerance] = useState("0.00");
  const [rulePriority, setRulePriority] = useState("0");
  const [ruleActive, setRuleActive] = useState(true);
  const [importing, setImporting] = useState(false);

  const createBank = async () => {
    if (!accountName.trim()) {
      toast.error("Account name is required.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/banks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName.trim(),
          bankName: bankName.trim() || undefined,
          accountNumberMasked: accountMasked.trim() || undefined,
          currency: "GHS",
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create bank account");
      toast.success("Bank account added.");
      setBankName("");
      setAccountName("");
      setAccountMasked("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "banks"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create bank account.");
    } finally {
      setSaving(false);
    }
  };

  const addTransaction = async () => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    const numericAmount = Number(amount);
    if (!postedAt || !Number.isFinite(numericAmount) || numericAmount === 0) {
      toast.error("Enter a valid date and amount.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postedAt,
          amount: numericAmount,
          type,
          description: description.trim() || undefined,
          reference: reference.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to add transaction");
      toast.success("Transaction added.");
      setPostedAt("");
      setAmount("");
      setDescription("");
      setReference("");
      queryClient.invalidateQueries({
        queryKey: ["accounting", "bank-transactions", activeBank.id],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to add transaction.");
    } finally {
      setSaving(false);
    }
  };

  const createRule = async () => {
    if (!activeBank?.id) {
      toast.error("Select a bank account first.");
      return;
    }
    if (!ruleName.trim() || !ruleText.trim()) {
      toast.error("Provide a rule name and match text.");
      return;
    }
    const minAmount = ruleMin === "" ? null : Number(ruleMin);
    const maxAmount = ruleMax === "" ? null : Number(ruleMax);
    const tolerance = ruleTolerance === "" ? 0 : Number(ruleTolerance);
    const priority = rulePriority === "" ? 0 : Number(rulePriority);
    if (ruleMin !== "" && !Number.isFinite(minAmount as number)) {
      toast.error("Enter a valid minimum amount.");
      return;
    }
    if (ruleMax !== "" && !Number.isFinite(maxAmount as number)) {
      toast.error("Enter a valid maximum amount.");
      return;
    }
    if (!Number.isFinite(tolerance)) {
      toast.error("Enter a valid tolerance.");
      return;
    }
    if (!Number.isFinite(priority)) {
      toast.error("Enter a valid priority.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: ruleName.trim(),
          matchText: ruleText.trim(),
          matchMode: ruleMode,
          accountId: ruleAccountId || null,
          minAmount,
          maxAmount,
          amountTolerance: tolerance,
          priority,
          isActive: ruleActive,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create rule.");
      toast.success("Match rule saved.");
      setRuleName("");
      setRuleText("");
      setRuleMode("CONTAINS");
      setRuleAccountId("");
      setRuleMin("");
      setRuleMax("");
      setRuleTolerance("0.00");
      setRulePriority("0");
      setRuleActive(true);
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create rule.");
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: BankMatchRule) => {
    if (!activeBank?.id) return;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update rule.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update rule.");
    }
  };

  const bumpRulePriority = async (rule: BankMatchRule, delta: number) => {
    if (!activeBank?.id) return;
    const next = Number(rule.priority || 0) + delta;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: next }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update priority.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update priority.");
    }
  };

  const deleteRule = async (rule: BankMatchRule) => {
    if (!activeBank?.id) return;
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/${rule.id}`, {
        method: "DELETE",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete rule.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete rule.");
    }
  };

  const importRules = async (file: File) => {
    if (!activeBank?.id) return;
    try {
      setImporting(true);
      const text = await file.text();
      const res = await fetch(`/api/admin/accounting/banks/${activeBank.id}/rules/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to import rules.");
      toast.success(`Imported ${j.imported ?? 0} rule(s).`);
      queryClient.invalidateQueries({ queryKey: ["accounting", "bank-rules", activeBank.id] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to import rules.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Bank Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Track bank accounts and reconcile transactions.
        </p>
        <div className="mt-3">
          <Button asChild size="sm" variant="outline">
            <a
              href={
                activeBank?.id
                  ? `/admin/import-export?focusImport=bankTransactions&bankId=${encodeURIComponent(activeBank.id)}`
                  : "/admin/import-export?focusImport=bankTransactions"
              }
            >
              Bulk import transactions
            </a>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add bank account</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Account name" value={accountName} onChange={(e) => setAccountName(e.target.value)} />
          <Input placeholder="Bank name (optional)" value={bankName} onChange={(e) => setBankName(e.target.value)} />
          <Input placeholder="Account # (masked)" value={accountMasked} onChange={(e) => setAccountMasked(e.target.value)} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createBank} disabled={saving}>
              {saving ? "Saving..." : "Add bank"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bank transactions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {banks.length > 0 ? (
            <select
              className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={activeBank?.id || ""}
              onChange={(e) => setSelectedBankId(e.target.value)}
            >
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name} ({bank.currency})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-muted-foreground">Add a bank account to begin.</p>
          )}

          {activeBank ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} />
              <Input
                placeholder="Amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as "DEBIT" | "CREDIT")}
              >
                <option value="CREDIT">Credit (in)</option>
                <option value="DEBIT">Debit (out)</option>
              </select>
              <Input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
              <Input placeholder="Reference" value={reference} onChange={(e) => setReference(e.target.value)} />
              <div className="sm:col-span-2 lg:col-span-3">
                <Button className="w-full sm:w-auto" onClick={addTransaction} disabled={saving}>
                  {saving ? "Saving..." : "Add transaction"}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="text-sm space-y-1">
            {(transactions || []).length === 0 ? (
              <p className="text-muted-foreground">No transactions yet.</p>
            ) : (
              (transactions || []).map((txn) => (
                <div key={txn.id} className="flex justify-between border-b py-1">
                  <span>
                    {new Date(txn.postedAt).toLocaleDateString()} · {txn.description || "Transaction"}
                  </span>
                  <span>
                    {txn.type === "CREDIT" ? "+" : "-"} {Number(txn.amount).toFixed(2)}{" "}
                    {txn.matched ? "✓" : ""}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Matching rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!activeBank ? (
            <p className="text-sm text-muted-foreground">Select a bank account to configure rules.</p>
          ) : (
            <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Input
                  placeholder="Rule name"
                  title="Short label so staff can understand the rule at a glance."
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                />
                <Input
                  placeholder="Match text"
                  title="Text to look for in the bank transaction description."
                  value={ruleText}
                  onChange={(e) => setRuleText(e.target.value)}
                />
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  title="How to match the text against the description."
                  value={ruleMode}
                  onChange={(e) => setRuleMode(e.target.value as BankMatchRule["matchMode"])}
                >
                  <option value="CONTAINS">Contains</option>
                  <option value="STARTS_WITH">Starts with</option>
                  <option value="ENDS_WITH">Ends with</option>
                  <option value="REGEX">Regex</option>
                </select>
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  title="If set, only match when the transaction should map to this ledger account."
                  value={ruleAccountId}
                  onChange={(e) => setRuleAccountId(e.target.value)}
                >
                  <option value="">Any account</option>
                  {(accountsData || []).map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} · {acc.name}
                    </option>
                  ))}
                </select>
                <Input
                  placeholder="Min amount (optional)"
                  title="Only match when the amount is at or above this value."
                  inputMode="decimal"
                  value={ruleMin}
                  onChange={(e) => setRuleMin(e.target.value)}
                />
                <Input
                  placeholder="Max amount (optional)"
                  title="Only match when the amount is at or below this value."
                  inputMode="decimal"
                  value={ruleMax}
                  onChange={(e) => setRuleMax(e.target.value)}
                />
                <Input
                  placeholder="Tolerance (GHS)"
                  title="Allowed amount difference for matching (use 0 for exact match)."
                  inputMode="decimal"
                  value={ruleTolerance}
                  onChange={(e) => setRuleTolerance(e.target.value)}
                />
                <Input
                  placeholder="Priority (higher wins)"
                  title="Higher priority rules are applied first."
                  inputMode="numeric"
                  value={rulePriority}
                  onChange={(e) => setRulePriority(e.target.value)}
                />
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  title="Turn the rule on or off without deleting it."
                  value={ruleActive ? "active" : "inactive"}
                  onChange={(e) => setRuleActive(e.target.value === "active")}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2">
                  <Button className="w-full sm:w-auto" onClick={createRule} disabled={saving}>
                    {saving ? "Saving..." : "Add rule"}
                  </Button>
                  <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                    <a href={`/api/admin/accounting/banks/${activeBank.id}/rules/export`}>
                      Export CSV
                    </a>
                  </Button>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded border px-2 py-1">Import CSV</span>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      disabled={importing}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importRules(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {importing ? <span className="text-xs text-muted-foreground">Importing...</span> : null}
                </div>
              </div>

              <div className="text-sm space-y-2">
                {(rulesData || []).length === 0 ? (
                  <p className="text-muted-foreground">No rules yet.</p>
                ) : (
                  (rulesData || []).map((rule) => (
                    <div key={rule.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                      <div>
                        <div className="font-medium">
                          {rule.name} {rule.isActive ? "" : "(inactive)"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {rule.matchMode} &quot;{rule.matchText}&quot; · {rule.account?.name || "Any account"} ·
                          priority {Number(rule.priority || 0)} ·
                          {rule.minAmount ? ` min ${Number(rule.minAmount).toFixed(2)}` : ""}{" "}
                          {rule.maxAmount ? ` max ${Number(rule.maxAmount).toFixed(2)}` : ""} · tol{" "}
                          {Number(rule.amountTolerance || 0).toFixed(2)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => bumpRulePriority(rule, 1)}>
                          ↑
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => bumpRulePriority(rule, -1)}>
                          ↓
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => toggleRule(rule)}>
                          {rule.isActive ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteRule(rule)}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
