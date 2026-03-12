"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";

type Supplier = {
  id: string;
  name: string;
  leadTimeDays: number;
  leadTimeMinDays?: number | null;
  leadTimeMaxDays?: number | null;
  status?: "ACTIVE" | "INACTIVE" | "ON_HOLD";
  deletedAt?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  website?: string | null;
  paymentTerms?: string | null;
  taxId?: string | null;
  currency?: string | null;
  notes?: string | null;
  defaultMinOrderQty?: number | null;
  defaultPackSize?: number | null;
};

type PriceChangeRow = {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  createdAt: string;
  meta?: {
    supplierId?: string | null;
    supplierName?: string | null;
    productId?: string | null;
    productName?: string | null;
    oldUnitCost?: number;
    newUnitCost?: number;
    delta?: number;
    deltaPct?: number | null;
    purchaseId?: string | null;
  } | null;
};

export default function SuppliersPage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const fromAgingHub =
    searchParams.get("sort") === "name_asc" || searchParams.get("sort") === "name_desc";
  const [showArchived, setShowArchived] = useState(false);
  const { data } = useClientQuery<{ rows: Supplier[] }>({
    queryKey: ["admin", "suppliers", showArchived ? "with-archived" : "active-only"],
    queryFn: () => fetch(`/api/admin/suppliers?includeDeleted=${showArchived ? "1" : "0"}`).then((r) => r.json()),
  });
  const suppliers = useMemo(
    () => (Array.isArray(data?.rows) ? data.rows : []),
    [data?.rows],
  );
  const [supplierSort, setSupplierSort] = useState<"name_asc" | "name_desc">("name_asc");
  const [supplierFilter, setSupplierFilter] = useState("");
  const { data: priceChangeData } = useClientQuery<PriceChangeRow[]>({
    queryKey: ["admin", "supplier-price-changes"],
    queryFn: () =>
      fetch("/api/admin/audit?action=SUPPLIER_PRICE_CHANGE&limit=25").then((r) => r.json()),
  });
  const priceChanges = useMemo(
    () => (Array.isArray(priceChangeData) ? priceChangeData : []),
    [priceChangeData],
  );

  const [name, setName] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "INACTIVE" | "ON_HOLD">("ACTIVE");
  const [leadTime, setLeadTime] = useState("14");
  const [leadTimeMin, setLeadTimeMin] = useState("");
  const [leadTimeMax, setLeadTimeMax] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [website, setWebsite] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [taxId, setTaxId] = useState("");
  const [currency, setCurrency] = useState("");
  const [defaultMinOrderQty, setDefaultMinOrderQty] = useState("1");
  const [defaultPackSize, setDefaultPackSize] = useState("1");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<Supplier | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [leadTimeRangeError, setLeadTimeRangeError] = useState("");
  const [editLeadTimeRangeError, setEditLeadTimeRangeError] = useState("");

  useEffect(() => {
    const focusId = searchParams.get("focus");
    if (!focusId || suppliers.length === 0) return;
    const match = suppliers.find((s) => s.id === focusId);
    if (match) {
      setSupplierFilter(match.name);
    }
  }, [searchParams, suppliers]);

  useEffect(() => {
    const sort = searchParams.get("sort");
    if (sort === "name_asc" || sort === "name_desc") {
      setSupplierSort(sort);
    }
  }, [searchParams]);

  const filteredSuppliers = useMemo(() => {
    const term = supplierFilter.trim().toLowerCase();
    const base = !term ? suppliers : suppliers.filter((s) => s.name.toLowerCase().includes(term));
    const sorted = [...base].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }),
    );
    return supplierSort === "name_desc" ? sorted.reverse() : sorted;
  }, [suppliers, supplierFilter, supplierSort]);

  const filteredPriceChanges = useMemo(() => {
    const term = supplierFilter.trim().toLowerCase();
    if (!term) return priceChanges;
    return priceChanges.filter((row) => {
      const supplierName = row.meta?.supplierName?.toLowerCase() || "";
      const supplierId = row.meta?.supplierId || "";
      return supplierName.includes(term) || supplierId === term;
    });
  }, [priceChanges, supplierFilter]);

  const addSupplier = async () => {
    if (!name.trim()) {
      toast.error("Supplier name is required.");
      return;
    }
    const lead = Number(leadTime);
    if (!Number.isFinite(lead) || lead < 1) {
      toast.error("Enter a valid lead time.");
      return;
    }
    if (
      leadTimeMin &&
      leadTimeMax &&
      Number(leadTimeMin) > Number(leadTimeMax)
    ) {
      toast.error("Lead time min cannot exceed max.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          leadTimeDays: lead,
          leadTimeMinDays: leadTimeMin ? Number(leadTimeMin) : undefined,
          leadTimeMaxDays: leadTimeMax ? Number(leadTimeMax) : undefined,
          status,
          contactName: contactName || undefined,
          email: email || undefined,
          phone: phone || undefined,
          address: address || undefined,
          website: website || undefined,
          paymentTerms: paymentTerms || undefined,
          taxId: taxId || undefined,
          currency: currency || undefined,
          defaultMinOrderQty: defaultMinOrderQty ? Number(defaultMinOrderQty) : undefined,
          defaultPackSize: defaultPackSize ? Number(defaultPackSize) : undefined,
          notes: notes || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create supplier.");
      toast.success("Supplier created.");
      setName("");
      setStatus("ACTIVE");
      setLeadTime("14");
      setLeadTimeMin("");
      setLeadTimeMax("");
      setContactName("");
      setEmail("");
      setPhone("");
      setAddress("");
      setWebsite("");
      setPaymentTerms("");
      setTaxId("");
      setCurrency("");
      setDefaultMinOrderQty("1");
      setDefaultPackSize("1");
      setNotes("");
      queryClient.invalidateQueries({ queryKey: ["admin", "suppliers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create supplier.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!leadTimeMin || !leadTimeMax) {
      setLeadTimeRangeError("");
      return;
    }
    const min = Number(leadTimeMin);
    const max = Number(leadTimeMax);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setLeadTimeRangeError("Enter valid lead time values.");
      return;
    }
    setLeadTimeRangeError(min > max ? "Lead time min cannot exceed max." : "");
  }, [leadTimeMin, leadTimeMax]);

  const updateSupplier = async (supplierId: string, payload: Partial<Supplier>) => {
    if (
      payload.leadTimeMinDays != null &&
      payload.leadTimeMaxDays != null &&
      payload.leadTimeMinDays > payload.leadTimeMaxDays
    ) {
      toast.error("Lead time min cannot exceed max.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/suppliers/${supplierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update supplier.");
      queryClient.invalidateQueries({ queryKey: ["admin", "suppliers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update supplier.");
    }
  };

  useEffect(() => {
    if (!editing) {
      setEditLeadTimeRangeError("");
      return;
    }
    const min = editing.leadTimeMinDays;
    const max = editing.leadTimeMaxDays;
    if (min == null || max == null) {
      setEditLeadTimeRangeError("");
      return;
    }
    setEditLeadTimeRangeError(min > max ? "Lead time min cannot exceed max." : "");
  }, [editing, editing?.leadTimeMinDays, editing?.leadTimeMaxDays]);

  const deleteSupplier = async (supplierId: string) => {
    if (!confirm("Archive this supplier?")) return;
    try {
      const res = await fetch(`/api/admin/suppliers/${supplierId}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete supplier.");
      toast.success("Supplier deleted.");
      queryClient.invalidateQueries({ queryKey: ["admin", "suppliers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete supplier.");
    }
  };

  const restoreSupplier = async (supplierId: string) => {
    try {
      const res = await fetch(`/api/admin/suppliers/${supplierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restore: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to restore supplier.");
      toast.success("Supplier restored.");
      queryClient.invalidateQueries({ queryKey: ["admin", "suppliers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to restore supplier.");
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Suppliers</h1>
        <p className="text-sm text-muted-foreground">
          Manage supplier lead times for inventory planning.
        </p>
        {fromAgingHub ? (
          <div className="mt-1 inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-800">
            Applied from Aging Hub
          </div>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add supplier</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            placeholder="Supplier name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <select
              className="border rounded-md h-10 bg-background px-2 w-full"
              value={status}
              onChange={(e) =>
                setStatus((e.target.value as Supplier["status"]) || "ACTIVE")
              }
            >
              <option value="ACTIVE">Active</option>
              <option value="ON_HOLD">On hold</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </div>
          <Input
            placeholder="Lead time (avg days)"
            inputMode="numeric"
            value={leadTime}
            onChange={(e) => setLeadTime(e.target.value)}
          />
          <Input
            placeholder="Lead time min"
            inputMode="numeric"
            value={leadTimeMin}
            onChange={(e) => setLeadTimeMin(e.target.value)}
          />
          <Input
            placeholder="Lead time max"
            inputMode="numeric"
            value={leadTimeMax}
            onChange={(e) => setLeadTimeMax(e.target.value)}
          />
          {leadTimeRangeError ? (
            <p className="text-xs text-red-600 sm:col-span-2">{leadTimeRangeError}</p>
          ) : null}
          <Input
            placeholder="Default MOQ"
            inputMode="numeric"
            value={defaultMinOrderQty}
            onChange={(e) => setDefaultMinOrderQty(e.target.value)}
            title="Minimum order quantity in units (e.g., carton of 12 = MOQ 12)."
          />
          <Input
            placeholder="Default pack size"
            inputMode="numeric"
            value={defaultPackSize}
            onChange={(e) => setDefaultPackSize(e.target.value)}
            title="Ordering increment in units (e.g., carton of 12 = pack size 12)."
          />
          <Input
            placeholder="Contact name"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <Input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            placeholder="Currency (e.g., GHS)"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
          <Input
            placeholder="Payment terms"
            value={paymentTerms}
            onChange={(e) => setPaymentTerms(e.target.value)}
          />
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </Button>
            <Button className="w-full sm:w-auto" onClick={addSupplier} disabled={saving || Boolean(leadTimeRangeError)}>
              {saving ? "Saving..." : "Add supplier"}
            </Button>
          </div>
          {showAdvanced ? (
            <>
              <Input
                className="sm:col-span-2"
                placeholder="Address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
              <Input
                placeholder="Website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
              <Input
                placeholder="Tax ID"
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
              />
              <Input
                className="sm:col-span-2 lg:col-span-3"
                placeholder="Notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <CardTitle>Supplier list</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              placeholder="Filter suppliers"
              className="h-8 w-full sm:w-48"
            />
            {showArchived ? <Badge variant="secondary">Archived on</Badge> : null}
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived suppliers
            </label>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {suppliers.length === 0 ? (
            <p className="text-muted-foreground">No suppliers yet.</p>
          ) : filteredSuppliers.length === 0 ? (
            <p className="text-muted-foreground">No suppliers match that filter.</p>
          ) : (
            filteredSuppliers.map((supplier) => (
              <div key={supplier.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                <div>
                  <div className="font-medium">{supplier.name}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {supplier.deletedAt ? (
                      <Badge variant="secondary">Archived</Badge>
                    ) : null}
                    <span>
                      {supplier.deletedAt ? "INACTIVE" : (supplier.status || "ACTIVE")} · Lead {supplier.leadTimeDays}d
                    {supplier.leadTimeMinDays ? ` (min ${supplier.leadTimeMinDays}d` : ""}
                    {supplier.leadTimeMaxDays ? `, max ${supplier.leadTimeMaxDays}d)` : supplier.leadTimeMinDays ? ")" : ""}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Dialog open={editOpen && editing?.id === supplier.id} onOpenChange={(open) => {
                    setEditOpen(open);
                    if (!open) setEditing(null);
                  }}>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="outline" onClick={() => {
                        setEditing(supplier);
                        setEditOpen(true);
                      }}>
                        Edit
                      </Button>
                    </DialogTrigger>
                    {editing ? (
                      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
                        <DialogHeader>
                          <DialogTitle className="text-base font-semibold">Edit supplier</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Input
                            placeholder="Name"
                            defaultValue={editing.name}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, name: e.target.value } : prev)}
                          />
                          <select
                            className="border rounded-md h-10 bg-background px-2"
                            defaultValue={editing.status || "ACTIVE"}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, status: e.target.value as Supplier["status"] } : prev)}
                          >
                            <option value="ACTIVE">Active</option>
                            <option value="ON_HOLD">On hold</option>
                            <option value="INACTIVE">Inactive</option>
                          </select>
                          <Input
                            placeholder="Lead time (avg)"
                            inputMode="numeric"
                            defaultValue={String(editing.leadTimeDays ?? 14)}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, leadTimeDays: Number(e.target.value) } : prev)}
                          />
                          <Input
                            placeholder="Lead time min"
                            inputMode="numeric"
                            defaultValue={editing.leadTimeMinDays != null ? String(editing.leadTimeMinDays) : ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, leadTimeMinDays: e.target.value ? Number(e.target.value) : null } : prev)}
                          />
                          <Input
                            placeholder="Lead time max"
                            inputMode="numeric"
                            defaultValue={editing.leadTimeMaxDays != null ? String(editing.leadTimeMaxDays) : ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, leadTimeMaxDays: e.target.value ? Number(e.target.value) : null } : prev)}
                          />
                          {editLeadTimeRangeError ? (
                            <p className="text-xs text-red-600 sm:col-span-2">{editLeadTimeRangeError}</p>
                          ) : null}
                          <Input
                            placeholder="Default MOQ"
                            inputMode="numeric"
                            defaultValue={editing.defaultMinOrderQty != null ? String(editing.defaultMinOrderQty) : "1"}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, defaultMinOrderQty: Number(e.target.value) } : prev)}
                          />
                          <Input
                            placeholder="Default pack size"
                            inputMode="numeric"
                            defaultValue={editing.defaultPackSize != null ? String(editing.defaultPackSize) : "1"}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, defaultPackSize: Number(e.target.value) } : prev)}
                          />
                          <Input
                            placeholder="Contact name"
                            defaultValue={editing.contactName || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, contactName: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Email"
                            defaultValue={editing.email || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, email: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Phone"
                            defaultValue={editing.phone || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, phone: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Currency"
                            defaultValue={editing.currency || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, currency: e.target.value.toUpperCase() } : prev)}
                          />
                          <Input
                            placeholder="Payment terms"
                            defaultValue={editing.paymentTerms || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, paymentTerms: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Address"
                            defaultValue={editing.address || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, address: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Website"
                            defaultValue={editing.website || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, website: e.target.value } : prev)}
                          />
                          <Input
                            placeholder="Tax ID"
                            defaultValue={editing.taxId || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, taxId: e.target.value } : prev)}
                          />
                          <Input
                            className="sm:col-span-2"
                            placeholder="Notes"
                            defaultValue={editing.notes || ""}
                            onChange={(e) => setEditing((prev) => prev ? { ...prev, notes: e.target.value } : prev)}
                          />
                        </div>
                        <div className="flex justify-end gap-2 pt-3">
                          <Button variant="secondary" onClick={() => setEditOpen(false)}>
                            Cancel
                          </Button>
                          <Button
                            disabled={Boolean(editLeadTimeRangeError)}
                            onClick={async () => {
                              if (!editing) return;
                              await updateSupplier(editing.id, {
                                name: editing.name?.trim(),
                                status: editing.status,
                                leadTimeDays: editing.leadTimeDays,
                                leadTimeMinDays: editing.leadTimeMinDays ?? null,
                                leadTimeMaxDays: editing.leadTimeMaxDays ?? null,
                                contactName: editing.contactName || null,
                                email: editing.email || null,
                                phone: editing.phone || null,
                                address: editing.address || null,
                                website: editing.website || null,
                                paymentTerms: editing.paymentTerms || null,
                                taxId: editing.taxId || null,
                                currency: editing.currency || null,
                                defaultMinOrderQty: editing.defaultMinOrderQty ?? undefined,
                                defaultPackSize: editing.defaultPackSize ?? undefined,
                                notes: editing.notes || null,
                              });
                              setEditOpen(false);
                            }}
                          >
                            Save
                          </Button>
                        </div>
                      </DialogContent>
                    ) : null}
                  </Dialog>
                  {supplier.deletedAt ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRestoreTarget(supplier);
                        setRestoreOpen(true);
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => deleteSupplier(supplier.id)}>
                      Archive
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent price changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {filteredPriceChanges.length === 0 ? (
            <p className="text-muted-foreground">No recent supplier price changes.</p>
          ) : (
            <div className="space-y-2">
              {filteredPriceChanges.map((row) => {
                const oldUnit = Number(row.meta?.oldUnitCost ?? 0);
                const newUnit = Number(row.meta?.newUnitCost ?? 0);
                const delta = Number(row.meta?.delta ?? newUnit - oldUnit);
                const deltaPct =
                  typeof row.meta?.deltaPct === "number" ? row.meta?.deltaPct : null;
                const supplierName = row.meta?.supplierName || "Supplier";
                const productName = row.meta?.productName || "Product";
                return (
                  <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                    <div>
                      <div className="font-medium">{supplierName}</div>
                      <div className="text-xs text-muted-foreground">{productName}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </div>
                    <div className="text-sm">
                      <span className="font-medium">{formatCurrency(oldUnit)}</span>
                      <span className="mx-2">→</span>
                      <span className="font-medium">{formatCurrency(newUnit)}</span>
                      <span className={delta >= 0 ? "ml-2 text-amber-600" : "ml-2 text-emerald-600"}>
                        {delta >= 0 ? "+" : ""}
                        {formatCurrency(delta)}
                        {deltaPct != null ? ` (${deltaPct.toFixed(1)}%)` : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={restoreOpen}
        onOpenChange={(open) => {
          setRestoreOpen(open);
          if (!open) setRestoreTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Restore supplier</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Restore {restoreTarget?.name}? This will make the supplier active again.
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setRestoreOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!restoreTarget) return;
                await restoreSupplier(restoreTarget.id);
                setRestoreOpen(false);
              }}
            >
              Restore
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
