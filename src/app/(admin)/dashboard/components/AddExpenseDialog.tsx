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
  expenseId?: string;
  initial?: { category: string; amount: number | string; note?: string };
  submitText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    category: initial?.category ?? "",
    amount: initial?.amount !== undefined ? String(initial.amount) : "",
    note: initial?.note ?? "",
  });

  useEffect(() => {
    if (open && mode === "edit" && initial) {
      setForm({
        category: initial.category,
        amount: String(initial.amount ?? ""),
        note: initial.note ?? "",
      });
    }
  }, [open, mode, initial]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = mode === "edit" && expenseId ? `/api/admin/expenses/${expenseId}` : "/api/admin/expenses";
      const method = mode === "edit" && expenseId ? "PATCH" : "POST";
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: form.category.trim(),
          amount: Number(form.amount),
          note: form.note.trim(),
        }),
      });
      if (!res.ok) throw new Error("Failed to save expense");
      toast.success(mode === "edit" ? "Expense updated successfully" : "Expense added successfully");
      setOpen(false);
      setForm({
        category: initial?.category ?? "",
        amount: initial?.amount !== undefined ? String(initial?.amount) : "",
        note: initial?.note ?? "",
      });
      onAdded?.(Date.now());
    } catch (err) {
      console.error(err);
      toast.error(mode === "edit" ? "Error updating expense" : "Error adding expense");
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "edit" ? "Edit Expense" : "Add New Expense"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-3 mt-2">
          <div>
            <Label htmlFor="category">Category</Label>
            <Input
              id="category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              required
            />
          </div>
          <div>
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              required
            />
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
                : submitText || (mode === "edit" ? "Update" : "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
