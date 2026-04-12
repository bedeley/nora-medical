"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type LedgerAccountOption = {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
};

const EXCLUDED_SYSTEM_EXPENSE_CODES = new Set(["5000", "6100", "6990"]);
type ExpensePaymentMode = "cash" | "bank" | "momo";

export default function AddExpenseDialog({
  onAdded,
  buttonClassName,
  buttonSize = "sm",
  buttonVariant = "outline",
  label = "+ Add Expense",
  mode = "add",
  isReversal = false,
  reversalOfId,
  reversalInfo,
  expenseId,
  initial,
  submitText,
}: {
  onAdded?: (timestamp: number) => void;
  buttonClassName?: string;
  buttonSize?: "default" | "sm" | "lg" | "icon" | "icon-sm" | "icon-lg";
  buttonVariant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  label?: string;
  mode?: "add" | "edit";
  isReversal?: boolean;
  reversalOfId?: string;
  reversalInfo?: { remaining?: number | null; reversedSoFar?: number | null };
  expenseId?: string;
  initial?: { category: string; amount: number | string; vendor?: string; reason?: string; note?: string };
  submitText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [errors, setErrors] = useState<{ category?: string; amount?: string; reason?: string; paymentMode?: string }>({});
  const [expenseCategories, setExpenseCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [form, setForm] = useState({
    category: initial?.category ?? "",
    amount: initial?.amount !== undefined ? String(initial.amount) : "",
    vendor: initial?.vendor ?? "",
    reason: initial?.reason ?? "",
    note: initial?.note ?? "",
    payNow: false,
    paymentMode: "" as "" | ExpensePaymentMode,
  });
  const formatAmount = (value: number) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const remainingCap = typeof reversalInfo?.remaining === "number" ? reversalInfo.remaining : null;
  const reversalMin = isReversal && remainingCap !== null ? `-${remainingCap}` : undefined;

  useEffect(() => {
    if (!open || !initial) return;
    if (mode === "edit" || isReversal) {
      setForm({
        category: initial.category,
        amount: String(initial.amount ?? ""),
        vendor: initial.vendor ?? "",
        reason: initial.reason ?? "",
        note: initial.note ?? "",
        payNow: false,
        paymentMode: "",
      });
      setErrors({});
    }
  }, [open, mode, initial, isReversal]);

  useEffect(() => {
    if (!open) return;
    setErrors({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    const loadExpenseCategories = async () => {
      try {
        setLoadingCategories(true);
        const res = await fetch("/api/admin/accounting/accounts", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as LedgerAccountOption[];
        if (ignore || !Array.isArray(data)) return;
        const options = data
          .filter(
            (row) =>
              row.isActive &&
              row.type === "EXPENSE" &&
              !EXCLUDED_SYSTEM_EXPENSE_CODES.has(String(row.code || "").trim()),
          )
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) => ({
            value: `${row.code} ${row.name}`,
            label: `${row.code} · ${row.name}`,
          }));
        const hasCurrent = options.some((row) => row.value === form.category);
        if (form.category && !hasCurrent) {
          options.unshift({
            value: form.category,
            label: `${form.category} (legacy)`,
          });
        }
        setExpenseCategories(options);
      } finally {
        if (!ignore) setLoadingCategories(false);
      }
    };
    loadExpenseCategories();
    return () => {
      ignore = true;
    };
  }, [open, form.category]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: { category?: string; amount?: string; reason?: string; paymentMode?: string } = {};
    const amountValue = Number(form.amount);
    if (!form.category.trim()) nextErrors.category = "Category is required.";
    if (!form.amount.trim() || !Number.isFinite(amountValue)) {
      nextErrors.amount = "Enter a valid amount.";
    } else if (!isReversal && amountValue <= 0) {
      nextErrors.amount = "Amount must be greater than 0.";
    } else if (isReversal && amountValue >= 0) {
      nextErrors.amount = "Reversal amount must be negative.";
    } else if (isReversal && remainingCap !== null && amountValue < -remainingCap) {
      nextErrors.amount = `Max reversal is GH₵${formatAmount(remainingCap)}.`;
    }
    if ((mode === "edit" || isReversal) && !form.reason.trim()) {
      nextErrors.reason = "Reason is required.";
    }
    if (!isReversal && form.payNow && !form.paymentMode) {
      nextErrors.paymentMode = "Select payment mode.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    if (isReversal && !reversalOfId) {
      toast.error("Missing original expense for reversal.");
      return;
    }
    if (mode === "edit" && !expenseId) {
      toast.error("Missing expense id for update.");
      return;
    }
    setLoading(true);
    try {
      const endpoint = mode === "edit" && expenseId ? `/api/admin/expenses/${expenseId}` : "/api/admin/expenses";
      const method = mode === "edit" && expenseId ? "PATCH" : "POST";
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: expenseId,
          category: form.category.trim(),
          amount: isReversal && amountValue > 0 ? -Math.abs(amountValue) : amountValue,
          vendor: form.vendor.trim(),
          reason: form.reason.trim(),
          note: form.note.trim(),
          payNow: !isReversal && mode === "add" ? Boolean(form.payNow) : undefined,
          paymentMode:
            !isReversal && mode === "add" && form.payNow ? form.paymentMode : undefined,
          isReversal,
          reversalOfId,
        }),
      });
      if (!res.ok) {
        let payload: { error?: string; details?: { fieldErrors?: Record<string, string[] | undefined> } } = {};
        try {
          payload = await res.json();
        } catch {}
        const reasonError = payload.details?.fieldErrors?.reason?.[0];
        if (reasonError) {
          setErrors((prev) => ({ ...prev, reason: reasonError }));
          return;
        }
        const message = payload.error || "Failed to save expense";
        throw new Error(message);
      }
      toast.success(mode === "edit" ? "Expense updated successfully" : isReversal ? "Reversal added successfully" : "Expense added successfully");
      setOpen(false);
      setForm({
        category: initial?.category ?? "",
        amount: initial?.amount !== undefined ? String(initial?.amount) : "",
        vendor: initial?.vendor ?? "",
        reason: initial?.reason ?? "",
        note: initial?.note ?? "",
        payNow: false,
        paymentMode: "",
      });
      setErrors({});
      onAdded?.(Date.now());
    } catch (err) {
      console.error(err);
      const fallback = mode === "edit" ? "Error updating expense" : "Error adding expense";
      toast.error(err instanceof Error ? err.message : fallback);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={buttonVariant} size={buttonSize} className={buttonClassName}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" ? "Edit Expense" : isReversal ? "Reverse Expense" : "Add New Expense"}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Update the coded expense details. Changes are audit logged and some posted expenses may be locked."
              : isReversal
              ? "Create a reversing entry for the selected expense. Reversals require a reason and a negative amount."
              : "Record a coded operating expense. Leave Pay now off to track it as accrued and settle it later."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3 mt-2">
          <div>
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={form.category}
              onChange={(e) => {
                setForm({ ...form, category: e.target.value });
                if (errors.category) setErrors((prev) => ({ ...prev, category: "" }));
              }}
              required
              aria-invalid={!!errors.category}
              className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
                errors.category ? "border-red-500" : ""
              }`}
            >
              <option value="">
                {loadingCategories ? "Loading categories..." : "Select expense account category"}
              </option>
              {expenseCategories.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.category && <p className="mt-1 text-xs text-red-600">{errors.category}</p>}
          </div>
          <div>
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min={isReversal ? reversalMin : "0"}
              max={isReversal ? "-0.01" : undefined}
              value={form.amount}
              onChange={(e) => {
                const next = e.target.value;
                if (errors.amount) setErrors((prev) => ({ ...prev, amount: "" }));
                if (isReversal) {
                  if (next === "" || next === "-") {
                    setForm({ ...form, amount: next });
                    return;
                  }
                  const normalized = next.startsWith("-") ? next : `-${next.replace(/^-+/, "")}`;
                  setForm({ ...form, amount: normalized });
                  return;
                }
                setForm({ ...form, amount: next });
              }}
              required
              aria-invalid={!!errors.amount}
              className={errors.amount ? "border-red-500" : ""}
            />
            {errors.amount && <p className="mt-1 text-xs text-red-600">{errors.amount}</p>}
            {isReversal && (reversalInfo?.remaining !== null || reversalInfo?.reversedSoFar !== null) ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {typeof reversalInfo?.reversedSoFar === "number"
                  ? `Already reversed: GH₵${formatAmount(reversalInfo.reversedSoFar)}. `
                  : ""}
                {typeof reversalInfo?.remaining === "number"
                  ? `Remaining: GH₵${formatAmount(reversalInfo.remaining)}. Amount prefilled.`
                  : ""}
              </p>
            ) : null}
            {isReversal && remainingCap !== null && Number.isFinite(Number(form.amount)) && Number(form.amount) < -remainingCap ? (
              <p className="mt-1 text-xs text-destructive">
                Max reversal is GH₵{formatAmount(remainingCap)}.
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="vendor">Vendor</Label>
            <Input
              id="vendor"
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              placeholder="Optional payee/vendor"
            />
          </div>
          <div>
            <Label htmlFor="reason">
              Reason
              {(mode === "edit" || isReversal) && <span className="text-destructive"> *</span>}
            </Label>
            <Input
              id="reason"
              value={form.reason}
              onChange={(e) => {
                setForm({ ...form, reason: e.target.value });
                if (errors.reason) setErrors((prev) => ({ ...prev, reason: "" }));
              }}
              placeholder={isReversal ? "Required for reversal" : "Optional reason"}
              required={mode === "edit" || isReversal}
              aria-invalid={!!errors.reason}
              className={errors.reason ? "border-red-500" : ""}
            />
            {errors.reason && <p className="mt-1 text-xs text-red-600">{errors.reason}</p>}
          </div>
          <div>
            <Label htmlFor="note">Note</Label>
            <Textarea
              id="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Optional details..."
            />
          </div>
          {!isReversal && mode === "add" ? (
            <>
              <div className="flex items-center gap-2">
                <input
                  id="payNow"
                  type="checkbox"
                  checked={form.payNow}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setForm((prev) => ({
                      ...prev,
                      payNow: checked,
                      paymentMode: checked ? prev.paymentMode : "",
                    }));
                    if (!checked) {
                      setErrors((prev) => ({ ...prev, paymentMode: "" }));
                    }
                  }}
                />
                <Label htmlFor="payNow">Pay now</Label>
              </div>
              {form.payNow ? (
                <div>
                  <Label htmlFor="paymentMode">Payment mode</Label>
                  <select
                    id="paymentMode"
                    value={form.paymentMode}
                    onChange={(e) => {
                      const value = e.target.value as "" | ExpensePaymentMode;
                      setForm((prev) => ({ ...prev, paymentMode: value }));
                      if (errors.paymentMode) setErrors((prev) => ({ ...prev, paymentMode: "" }));
                    }}
                    className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
                      errors.paymentMode ? "border-red-500" : ""
                    }`}
                  >
                    <option value="">Select payment mode</option>
                    <option value="cash">Cash</option>
                    <option value="bank">Bank transfer</option>
                    <option value="momo">MoMo</option>
                  </select>
                  {errors.paymentMode ? (
                    <p className="mt-1 text-xs text-red-600">{errors.paymentMode}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading
                ? mode === "edit" ? "Updating..." : "Saving..."
                : submitText || (mode === "edit" ? "Update" : isReversal ? "Create reversal" : "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
