"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";

export function ProductsHeaderActions({
  isAdmin,
  bulkMinMarginOpen,
  onBulkMinMarginOpenChange,
  bulkMinMarginCategory,
  onBulkMinMarginCategoryChange,
  bulkMinMarginValue,
  onBulkMinMarginValueChange,
  bulkMinMarginReason,
  onBulkMinMarginReasonChange,
  bulkMinMarginSaving,
  onBulkSetMinMargin,
  addProductAction,
}: {
  isAdmin: boolean;
  bulkMinMarginOpen: boolean;
  onBulkMinMarginOpenChange: (open: boolean) => void;
  bulkMinMarginCategory: string;
  onBulkMinMarginCategoryChange: (value: string) => void;
  bulkMinMarginValue: string;
  onBulkMinMarginValueChange: (value: string) => void;
  bulkMinMarginReason: string;
  onBulkMinMarginReasonChange: (value: string) => void;
  bulkMinMarginSaving: boolean;
  onBulkSetMinMargin: () => void;
  addProductAction: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isAdmin ? (
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/audit?sourcePage=admin%2Fproducts">View Audit Log</Link>
        </Button>
      ) : null}
      <Dialog open={bulkMinMarginOpen} onOpenChange={onBulkMinMarginOpenChange}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={!isAdmin}>
            Set min margin
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Bulk minimum margin</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Category</Label>
              <select
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={bulkMinMarginCategory}
                onChange={(event) => onBulkMinMarginCategoryChange(event.target.value)}
              >
                <option value="">Select category</option>
                {PRODUCT_CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Minimum margin %</Label>
              <Input
                type="number"
                step="0.1"
                placeholder="Leave blank to clear"
                value={bulkMinMarginValue}
                onChange={(event) => onBulkMinMarginValueChange(event.target.value)}
              />
            </div>
            <div>
              <Label>Reason for change</Label>
              <Input
                value={bulkMinMarginReason}
                onChange={(event) => onBulkMinMarginReasonChange(event.target.value)}
                placeholder="e.g., pricing guardrail update"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => onBulkMinMarginOpenChange(false)} disabled={bulkMinMarginSaving}>
                Cancel
              </Button>
              <Button onClick={onBulkSetMinMargin} disabled={bulkMinMarginSaving}>
                {bulkMinMarginSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {addProductAction}
    </div>
  );
}
