"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

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
  const [errors, setErrors] = useState<{ category?: string; amount?: string; reason?: string }>({});
  const [form, setForm] = useState({
    category: initial?.category ?? "",
    amount: initial?.amount !== undefined ? String(initial.amount) : "",
    vendor: initial?.vendor ?? "",
    reason: initial?.reason ?? "",
    note: initial?.note ?? "",
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
      });
      setErrors({});
    }
  }, [open, mode, initial, isReversal]);

  useEffect(() => {
    if (!open) return;
    setErrors({});
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: { category?: string; amount?: string; reason?: string } = {};
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
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3 mt-2">
          <div>
            <Label htmlFor="category">Category</Label>
            <Input
              id="category"
              value={form.category}
              onChange={(e) => {
                setForm({ ...form, category: e.target.value });
                if (errors.category) setErrors((prev) => ({ ...prev, category: "" }));
              }}
              required
              aria-invalid={!!errors.category}
              className={errors.category ? "border-red-500" : ""}
            />
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
