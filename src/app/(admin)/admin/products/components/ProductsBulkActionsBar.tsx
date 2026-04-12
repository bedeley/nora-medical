"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SupplierOption } from "../types";

export function ProductsBulkActionsBar({
  selectedCount,
  onClearSelection,
  onBulkArchive,
  bulkSupplierOpen,
  onBulkSupplierOpenChange,
  bulkSupplierId,
  onBulkSupplierIdChange,
  bulkSupplierName,
  onBulkSupplierNameChange,
  bulkSupplierReason,
  onBulkSupplierReasonChange,
  bulkSaving,
  onBulkAssignSupplier,
  assignableSuppliers,
  onExportSelected,
}: {
  selectedCount: number;
  onClearSelection: () => void;
  onBulkArchive: (archived: boolean) => void;
  bulkSupplierOpen: boolean;
  onBulkSupplierOpenChange: (open: boolean) => void;
  bulkSupplierId: string;
  onBulkSupplierIdChange: (id: string) => void;
  bulkSupplierName: string;
  onBulkSupplierNameChange: (name: string) => void;
  bulkSupplierReason: string;
  onBulkSupplierReasonChange: (reason: string) => void;
  bulkSaving: boolean;
  onBulkAssignSupplier: () => void;
  assignableSuppliers: SupplierOption[];
  onExportSelected: () => void;
}) {
  if (selectedCount <= 0) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">{selectedCount} selected</span>
        <Button variant="ghost" size="sm" onClick={onClearSelection}>
          Clear
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => onBulkArchive(true)}>
          Archive
        </Button>
        <Button size="sm" variant="outline" onClick={() => onBulkArchive(false)}>
          Unarchive
        </Button>
        <Dialog open={bulkSupplierOpen} onOpenChange={onBulkSupplierOpenChange}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" disabled={selectedCount === 0}>
              Set Supplier
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Bulk set supplier</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">Selected: {selectedCount}</div>
              <div>
                <Label>Choose supplier</Label>
                <select
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={bulkSupplierId}
                  onChange={(event) => {
                    const nextId = event.target.value || "";
                    onBulkSupplierIdChange(nextId);
                    const match = assignableSuppliers.find((supplier) => supplier.id === nextId);
                    if (match) onBulkSupplierNameChange(match.name);
                  }}
                >
                  <option value="">Select supplier</option>
                  {assignableSuppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name} · {supplier.leadTimeDays}d
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Or enter supplier name</Label>
                <Input
                  value={bulkSupplierName}
                  onChange={(event) => {
                    onBulkSupplierNameChange(event.target.value);
                    if (event.target.value.trim()) onBulkSupplierIdChange("");
                  }}
                />
              </div>
              <div>
                <Label>Reason for change</Label>
                <Input
                  value={bulkSupplierReason}
                  onChange={(event) => onBulkSupplierReasonChange(event.target.value)}
                  placeholder="e.g., supplier update / consolidation"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => onBulkSupplierOpenChange(false)} disabled={bulkSaving}>
                  Cancel
                </Button>
                <Button onClick={onBulkAssignSupplier} disabled={bulkSaving}>
                  {bulkSaving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> : "Save"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Button size="sm" onClick={onExportSelected}>
          Export CSV
        </Button>
      </div>
    </div>
  );
}
