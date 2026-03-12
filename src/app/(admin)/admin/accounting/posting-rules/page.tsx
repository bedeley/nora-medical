"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
};

type AppSettingResponse = {
  key: string;
  value: Record<string, string> | null;
};

const RULES = [
  { key: "CASH_IN_TRANSIT", label: "Cash in transit (delivery settlement holding)" },
  { key: "CASH", label: "Cash account (cash payments)" },
  { key: "BANK", label: "Bank account (MoMo/bank deposits)" },
  { key: "MOMO_CLEARING", label: "MoMo clearing (pending provider receipts)" },
  { key: "GATEWAY_CLEARING", label: "Payment gateway clearing" },
  { key: "AR", label: "Accounts receivable (customer owes)" },
  { key: "INVENTORY", label: "Inventory asset" },
  { key: "AP", label: "Accounts payable (supplier owes)" },
  { key: "VAT_PAYABLE", label: "VAT payable" },
  { key: "STORE_CREDIT", label: "Store credit liability" },
  { key: "ACCRUED_EXPENSES", label: "Accrued expenses liability" },
  { key: "PAYROLL_PAYABLE", label: "Payroll payable liability" },
  { key: "CUSTOMER_DEPOSITS", label: "Customer deposits / unearned revenue" },
  { key: "SALES", label: "Sales revenue" },
  { key: "COGS", label: "Cost of goods sold" },
  { key: "OPERATING_EXPENSE", label: "Operating expenses" },
  { key: "PAYROLL_EXPENSE", label: "Payroll expenses" },
  { key: "DELIVERY_EXPENSE", label: "Delivery & logistics expense" },
  { key: "BANK_CHARGES_EXPENSE", label: "Bank charges & fees expense" },
  { key: "UTILITIES_EXPENSE", label: "Utilities expense" },
  { key: "RENT_EXPENSE", label: "Rent expense" },
  { key: "REPAIRS_MAINTENANCE_EXPENSE", label: "Repairs & maintenance expense" },
  { key: "MARKETING_EXPENSE", label: "Marketing expense" },
] as const;

const DEFAULT_RULE_VALUES: Record<string, string> = {
  CASH_IN_TRANSIT: "1020",
  CASH: "1000",
  BANK: "1010",
  MOMO_CLEARING: "1030",
  GATEWAY_CLEARING: "1040",
  AR: "1100",
  INVENTORY: "1200",
  AP: "2000",
  VAT_PAYABLE: "2100",
  STORE_CREDIT: "2200",
  ACCRUED_EXPENSES: "2300",
  PAYROLL_PAYABLE: "2400",
  CUSTOMER_DEPOSITS: "2500",
  SALES: "4000",
  COGS: "5000",
  OPERATING_EXPENSE: "6000",
  PAYROLL_EXPENSE: "6100",
  DELIVERY_EXPENSE: "6200",
  BANK_CHARGES_EXPENSE: "6300",
  UTILITIES_EXPENSE: "6400",
  RENT_EXPENSE: "6500",
  REPAIRS_MAINTENANCE_EXPENSE: "6600",
  MARKETING_EXPENSE: "6700",
};

export default function PostingRulesPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const enabled = process.env.NEXT_PUBLIC_ACCOUNTING_POSTING_RULES_ENABLED === "true";
  const { data: accountsData } = useClientQuery<LedgerAccount[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetch("/api/admin/accounting/accounts").then((r) => r.json()),
  });
  const { data: settingsData, isLoading } = useClientQuery<AppSettingResponse>({
    queryKey: ["accounting", "posting-rules"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.posting.accounts").then((r) => r.json()),
  });

  const accounts = useMemo(() => (Array.isArray(accountsData) ? accountsData : []), [accountsData]);
  const accountOptions = useMemo(
    () => accounts.filter((acc) => acc.isActive).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );

  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const currentValues = useMemo(
    () => ({
      ...DEFAULT_RULE_VALUES,
      ...(settingsData?.value || {}),
    }),
    [settingsData],
  );
  const values = Object.keys(draft).length ? draft : currentValues;

  const saveRules = async () => {
    try {
      setSaving(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.posting.accounts",
          value: values,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to save posting rules.");
      }
      toast.success("Posting rules updated.");
      setDraft({});
      queryClient.invalidateQueries({ queryKey: ["accounting", "posting-rules"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save posting rules.");
    } finally {
      setSaving(false);
    }
  };

  if (!enabled || !isAdmin) {
    return (
      <section className="container mx-auto py-8 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Posting Rules</h1>
          <p className="text-sm text-muted-foreground">
            This page is restricted. Ask an admin to enable access.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Access disabled</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Set `NEXT_PUBLIC_ACCOUNTING_POSTING_RULES_ENABLED=true` to enable this page
            for admin users.
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Posting Rules</h1>
        <p className="text-sm text-muted-foreground">
          Choose which ledger accounts the system uses when auto-posting entries.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Auto-post account mapping</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading rules...</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {RULES.map((rule) => (
                <label key={rule.key} className="grid gap-2 text-sm">
                  <span className="text-muted-foreground">{rule.label}</span>
                  <select
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={values[rule.key] || ""}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...currentValues,
                        ...prev,
                        [rule.key]: e.target.value,
                      }))
                    }
                  >
                    <option value="">Select account</option>
                    {accountOptions.map((acc) => (
                      <option key={acc.id} value={acc.code}>
                        {acc.code} · {acc.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button className="w-full sm:w-auto" onClick={saveRules} disabled={saving}>
              {saving ? "Saving..." : "Save rules"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setDraft({})}
              disabled={saving}
            >
              Reset changes
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            These mappings are used by the system when it auto-creates journal entries
            for orders, payments, expenses, purchases, and payroll.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
