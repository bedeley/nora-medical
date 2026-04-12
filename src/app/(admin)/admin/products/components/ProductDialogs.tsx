"use client";

/* eslint-disable @next/next/no-img-element */

import type { ChangeEvent, ReactElement } from "react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClientQuery } from "@/hooks/use-client-query";
import { PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";
import { getMarginGuardError } from "@/lib/margin-guard";
import { toast } from "sonner";
import { productEditSchema, productSchema, toTitleCase } from "../productFormSchemas";
import { SYSTEM_SUPPLIER_NAMES, type AdminProduct, type SupplierOption } from "../types";
// Wrapper that fetches the product when it's not on the current page
export function AddProductDialog({ suppliers }: { suppliers: SupplierOption[] }) {
  const queryClient = useQueryClient();
  const systemSupplierNames = useMemo(() => new Set<string>(SYSTEM_SUPPLIER_NAMES), []);
  const assignableSuppliers = useMemo(
    () => suppliers.filter((s) => !systemSupplierNames.has(s.name.trim().toLowerCase())),
    [suppliers, systemSupplierNames],
  );

  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const { data: purchaseConfigData } = useClientQuery<{
    purchaseApprovalQtyThreshold?: number;
    supplierPaymentApprovalThreshold?: number;
  }>({
    queryKey: ["admin", "purchases", "config"],
    queryFn: () => fetch("/api/admin/purchases/config").then((r) => r.json()),
  });

  type ProductFormValues = z.input<typeof productSchema>;
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema) as unknown as Resolver<ProductFormValues>,
    defaultValues: {
      name: "",
      description: "",
      imageUrl: "",
      category: "",
      brand: "",
      supplier: "",
      supplierId: "",
      minMarginPct: undefined,
      marginOverrideReason: undefined,
      price: 0,
      cost: 0,
      stock: 0,
      receiveNow: false,
      paidOnReceipt: false,
      paymentMethod: undefined,
      lotCode: "",
      expiryDate: "",
      requiresLotTracking: false,
      requiresExpiryDate: false,
    },
  });
  const receiveNow = form.watch("receiveNow");
  const paidOnReceipt = form.watch("paidOnReceipt");
  const requiresLotTracking = form.watch("requiresLotTracking");
  const requiresExpiryDate = form.watch("requiresExpiryDate");
  const watchPrice = Number(form.watch("price") || 0);
  const watchCost = Number(form.watch("cost") || 0);
  const watchStock = Number(form.watch("stock") || 0);
  const watchMinMargin = form.watch("minMarginPct");
  const watchOverrideReason = form.watch("marginOverrideReason");
  const purchaseApprovalThreshold = Number(
    purchaseConfigData?.purchaseApprovalQtyThreshold ??
      process.env.NEXT_PUBLIC_PURCHASE_APPROVAL_QTY_THRESHOLD ??
      0,
  );
  const paymentApprovalThreshold = Number(
    purchaseConfigData?.supplierPaymentApprovalThreshold ??
      process.env.NEXT_PUBLIC_SUPPLIER_PAYMENT_APPROVAL_THRESHOLD ??
      0,
  );
  const approvalRequiredForInitialStock =
    Boolean(receiveNow) &&
    Number.isFinite(purchaseApprovalThreshold) &&
    purchaseApprovalThreshold > 0 &&
    watchStock >= purchaseApprovalThreshold;
  const highValueCreditOnlyForInitialStock =
    Boolean(receiveNow) &&
    Number.isFinite(paymentApprovalThreshold) &&
    paymentApprovalThreshold > 0 &&
    watchStock * watchCost >= paymentApprovalThreshold;
  const currentMarginPct = watchPrice > 0 ? ((watchPrice - watchCost) / watchPrice) * 100 : 0;
  const marginError = getMarginGuardError({
    price: watchPrice,
    cost: watchCost,
    minMarginPct: typeof watchMinMargin === "number" ? watchMinMargin : undefined,
  });
  const supplierField = form.register("supplier", {
    onChange: (event) => {
      form.setValue("supplierId", undefined);
      return event;
    },
  });

  useEffect(() => {
    if (!approvalRequiredForInitialStock) return;
    form.setValue("receiveNow", false);
    form.setValue("paidOnReceipt", false);
    form.setValue("paymentMethod", undefined);
  }, [approvalRequiredForInitialStock, form]);

  useEffect(() => {
    if (!highValueCreditOnlyForInitialStock) return;
    form.setValue("paidOnReceipt", false);
    form.setValue("paymentMethod", undefined);
  }, [form, highValueCreditOnlyForInitialStock]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const onSubmit: SubmitHandler<ProductFormValues> = async (values) => {
    const parsed = productSchema.parse(values);
    try {
      form.clearErrors();
      if (Boolean(parsed.receiveNow) && Boolean(parsed.paidOnReceipt) && !parsed.paymentMethod) {
        form.setError("paymentMethod", {
          type: "manual",
          message: "Select payment mode when Pay now is checked.",
        });
        return;
      }
      if (Boolean(parsed.receiveNow) && Boolean(parsed.requiresLotTracking) && !String(parsed.lotCode || "").trim()) {
        form.setError("lotCode", {
          type: "manual",
          message: "Lot/Batch code is required for this product.",
        });
        return;
      }
      if (Boolean(parsed.receiveNow) && Boolean(parsed.requiresExpiryDate) && !String(parsed.expiryDate || "").trim()) {
        form.setError("expiryDate", {
          type: "manual",
          message: "Expiry date is required for this product.",
        });
        return;
      }
      const capitalizedName = toTitleCase(parsed.name || "");
      const payload = {
        ...parsed,
        name: capitalizedName,
        price: Number(parsed.price),
        cost: Number(parsed.cost),
        stock: Number(parsed.stock),
        receiveNow: approvalRequiredForInitialStock ? false : parsed.receiveNow !== false,
        paidOnReceipt:
          highValueCreditOnlyForInitialStock || approvalRequiredForInitialStock
            ? false
            : parsed.paidOnReceipt !== false,
        paymentMethod:
          highValueCreditOnlyForInitialStock ||
          approvalRequiredForInitialStock ||
          parsed.paidOnReceipt === false
            ? undefined
            : parsed.paymentMethod,
        requiresLotTracking: Boolean(parsed.requiresLotTracking) || Boolean(parsed.requiresExpiryDate),
        requiresExpiryDate: Boolean(parsed.requiresExpiryDate),
        marginOverrideReason: parsed.marginOverrideReason?.trim() || undefined,
      };
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message = String(err?.error || "Failed to add product");
        const lower = message.toLowerCase();
        if (lower.includes("supplier")) {
          form.setError("supplier", { type: "server", message });
        } else if (lower.includes("lot/batch code")) {
          form.setError("lotCode", { type: "server", message });
        } else if (lower.includes("expiry date")) {
          form.setError("expiryDate", { type: "server", message });
        } else if (lower.includes("payment mode")) {
          form.setError("paymentMethod", { type: "server", message });
        } else {
          toast.error(message);
        }
        return;
      }
      const created = await res.json().catch(() => ({} as {
        initialPurchase?: { id?: string; status?: string; quantity?: number };
      }));
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      if (created?.initialPurchase?.status === "PENDING_APPROVAL") {
        toast.info(
          `${values.name} saved. Initial purchase (${created.initialPurchase.quantity || 0}) is pending approval in Purchases.`,
        );
      } else if (created?.initialPurchase?.status === "ORDERED") {
        toast.info(`${values.name} saved. Initial order was created and awaits receiving.`);
      } else {
        toast.success(`${values.name} added successfully`);
      }
      form.reset();
      setPreview(null);
      setOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error adding product");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setPreview(null); form.reset(); } }}>
      <DialogTrigger asChild>
        <Button variant="default" data-testid="add-product-trigger">+ Add Product</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Add New Product</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit(onSubmit, () => {})}
          className="space-y-4"
        >
          {/* ── Section 1: Basic Info ── */}
          <div className="rounded-lg border p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Basic info</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <Label>Name</Label>
                <Input
                  {...form.register("name")}
                  placeholder="e.g., Paracetamol 500mg"
                  className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`}
                />
                {form.formState.errors.name && <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>}
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Description</Label>
                <Input
                  {...form.register("description")}
                  placeholder="Brief product description"
                  className={form.formState.errors.description ? "border-red-500" : undefined}
                />
                {form.formState.errors.description && <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>}
              </div>
              <div className="space-y-1">
                <Label>Category</Label>
                <select
                  {...form.register("category")}
                  className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${form.formState.errors.category ? "border-red-500" : ""}`}
                >
                  <option value="">Select a category</option>
                  {PRODUCT_CATEGORY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
                {form.formState.errors.category && <p className="text-xs text-red-600">{String(form.formState.errors.category.message)}</p>}
              </div>
              <div className="space-y-1">
                <Label>Brand</Label>
                <Input
                  {...form.register("brand")}
                  placeholder="e.g., GSK"
                  className={form.formState.errors.brand ? "border-red-500" : undefined}
                />
                {form.formState.errors.brand && <p className="text-xs text-red-600">{String(form.formState.errors.brand.message)}</p>}
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Image</Label>
                <div className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1.5">
                    <Input
                      placeholder="https://… or /images/…"
                      {...form.register("imageUrl")}
                      className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">or upload:</span>
                      <Input type="file" accept="image/*" onChange={handleFileChange} className="text-xs h-8" />
                    </div>
                    {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
                    {form.formState.errors.imageUrl && <p className="text-xs text-red-600">{String(form.formState.errors.imageUrl.message)}</p>}
                  </div>
                  {(() => {
                    const url = (form.watch("imageUrl") as string) || preview || "";
                    return url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" title="Open image">
                        <img src={url} alt="Preview" className="w-16 h-16 rounded-md object-cover border flex-shrink-0" />
                      </a>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>
          </div>

          {/* ── Section 2: Supplier ── */}
          <div className="rounded-lg border p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supplier</p>
            <div className="space-y-1">
              <Label>Select from existing suppliers</Label>
              <select
                className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${form.formState.errors.supplier ? "border-red-500" : ""}`}
                value={form.watch("supplierId") || ""}
                onChange={(e) => {
                  const nextId = e.target.value || "";
                  form.setValue("supplierId", nextId || undefined);
                  const match = assignableSuppliers.find((s) => s.id === nextId);
                  if (match) form.setValue("supplier", match.name);
                  if (form.formState.errors.supplier) form.clearErrors("supplier");
                }}
              >
                <option value="">Choose supplier…</option>
                {assignableSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.leadTimeDays}d lead time</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-muted-foreground">Or enter a new supplier name</Label>
              <Input
                {...supplierField}
                placeholder="Supplier name"
                className={form.formState.errors.supplier ? "border-red-500" : undefined}
              />
            </div>
            {form.formState.errors.supplier && <p className="text-xs text-red-600">{String(form.formState.errors.supplier.message)}</p>}
          </div>

          {/* ── Section 3: Pricing ── */}
          <div className="rounded-lg border p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pricing</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Selling price</Label>
                <Input type="number" step="0.01" placeholder="0.00" {...form.register("price", { valueAsNumber: true })} className={form.formState.errors.price ? "border-red-500" : undefined} />
                {form.formState.errors.price && <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>}
              </div>
              <div className="space-y-1">
                <Label>Initial cost</Label>
                <Input type="number" step="0.01" placeholder="0.00" {...form.register("cost", { valueAsNumber: true })} className={form.formState.errors.cost ? "border-red-500" : undefined} />
                <p className="text-xs text-muted-foreground">Starting average cost. Updated automatically on future purchases.</p>
                {form.formState.errors.cost && <p className="text-xs text-red-600">{String(form.formState.errors.cost.message)}</p>}
              </div>
              <div className="space-y-1">
                <Label>Min margin % <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  type="number" step="0.1" placeholder="e.g. 10"
                  {...form.register("minMarginPct", { setValueAs: (v) => (v === "" || v == null ? undefined : Number(v)) })}
                  className={form.formState.errors.minMarginPct ? "border-red-500" : undefined}
                />
                <p className="text-xs text-muted-foreground">
                  Current margin: <span className={typeof watchMinMargin === "number" && currentMarginPct < watchMinMargin ? "text-amber-600 font-medium" : ""}>{Number.isFinite(currentMarginPct) ? currentMarginPct.toFixed(1) : "0.0"}%</span>
                </p>
                {form.formState.errors.minMarginPct && <p className="text-xs text-red-600">{String(form.formState.errors.minMarginPct.message)}</p>}
              </div>
              {marginError && (
                <div className="space-y-1 sm:col-span-2">
                  <Label>Override reason <span className="text-amber-600 text-xs">(required — margin violation)</span></Label>
                  <Input
                    placeholder="Explain why this price is permitted (min 5 chars)"
                    {...form.register("marginOverrideReason", { setValueAs: (v) => (v ? String(v).trim() : undefined) })}
                    className={!watchOverrideReason || String(watchOverrideReason).trim().length < 5 ? "border-amber-500" : undefined}
                  />
                  <p className="text-xs text-amber-600">{marginError}</p>
                </div>
              )}
            </div>
          </div>

          {/* ── Section 4: Inventory ── */}
          <div className="rounded-lg border p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Inventory</p>
            <div className="space-y-1">
              <Label>{receiveNow ? "Initial stock (units)" : "Initial order qty"}</Label>
              <Input type="number" {...form.register("stock", { valueAsNumber: true })} className={form.formState.errors.stock ? "border-red-500" : undefined} />
              <p className="text-xs text-muted-foreground">
                {receiveNow ? "Stock is added immediately and a received purchase is created." : "Creates a purchase order only — stock stays 0 until received."}
              </p>
              {approvalRequiredForInitialStock && <p className="text-xs text-amber-700">Quantity requires approval — product saved with a pending-approval purchase.</p>}
              {form.formState.errors.stock && <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>}
            </div>

            {/* Lot / expiry tracking */}
            <div className="rounded-md bg-muted/40 p-3 space-y-2">
              <p className="text-xs font-medium">Regulated SKU tracking</p>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input id="requiresLotTracking" type="checkbox" checked={requiresLotTracking === true}
                  onChange={(e) => { const n = e.target.checked; form.setValue("requiresLotTracking", n); if (!n && requiresExpiryDate) form.setValue("requiresExpiryDate", false); }} />
                Require lot / batch tracking
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input id="requiresExpiryDate" type="checkbox" checked={requiresExpiryDate === true}
                  onChange={(e) => { const n = e.target.checked; form.setValue("requiresExpiryDate", n); if (n) form.setValue("requiresLotTracking", true); }} />
                Require expiry date
              </label>
              <p className="text-xs text-muted-foreground">When enabled, purchases and adjustments must include lot codes and/or expiry dates.</p>
            </div>

            {/* Receive now toggle */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input id="receiveNow" type="checkbox" checked={receiveNow !== false}
                  onChange={(e) => { form.setValue("receiveNow", e.target.checked); if (!e.target.checked) { form.setValue("paidOnReceipt", false); form.setValue("paymentMethod", undefined); } }}
                  disabled={approvalRequiredForInitialStock} />
                Receive stock now
              </label>
              <label className={`flex items-center gap-2 text-sm cursor-pointer select-none ${!receiveNow ? "opacity-40 pointer-events-none" : ""}`}>
                <input id="paidOnReceipt" type="checkbox" checked={paidOnReceipt !== false}
                  onChange={(e) => { form.setValue("paidOnReceipt", e.target.checked); if (!e.target.checked) form.setValue("paymentMethod", undefined); }}
                  disabled={!receiveNow || highValueCreditOnlyForInitialStock} />
                Pay supplier now
              </label>
              {highValueCreditOnlyForInitialStock && <p className="text-xs text-amber-700">High-value receipt — created on credit. Record payment after approval.</p>}
              {!receiveNow && <p className="text-xs text-muted-foreground">Enable &quot;Receive now&quot; to record immediate payment.</p>}
            </div>

            {/* Lot/expiry inputs + payment mode */}
            {(receiveNow || requiresLotTracking || requiresExpiryDate) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="lotCode">Lot / Batch code</Label>
                  <Input id="lotCode" placeholder={requiresLotTracking ? "Required" : "Optional"}
                    value={form.watch("lotCode") || ""} onChange={(e) => { form.setValue("lotCode", e.target.value); form.clearErrors("lotCode"); }}
                    className={form.formState.errors.lotCode ? "border-red-500" : undefined} />
                  {form.formState.errors.lotCode && <p className="text-xs text-red-600">{String(form.formState.errors.lotCode.message)}</p>}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="expiryDate">Expiry date</Label>
                  <Input id="expiryDate" type="date" value={form.watch("expiryDate") || ""}
                    onChange={(e) => { form.setValue("expiryDate", e.target.value); form.clearErrors("expiryDate"); }}
                    className={form.formState.errors.expiryDate ? "border-red-500" : undefined} />
                  {form.formState.errors.expiryDate && <p className="text-xs text-red-600">{String(form.formState.errors.expiryDate.message)}</p>}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>Payment method</Label>
                  <select
                    className={`border rounded-md h-9 w-full bg-background text-sm px-2 ${form.formState.errors.paymentMethod ? "border-red-500" : "border-input"}`}
                    value={form.watch("paymentMethod") || ""}
                    onChange={(e) => { form.setValue("paymentMethod", (e.target.value as "cash" | "transfer" | "bank") || undefined); form.clearErrors("paymentMethod"); }}
                    disabled={!receiveNow || paidOnReceipt === false || highValueCreditOnlyForInitialStock}
                  >
                    <option value="" disabled>Select payment method</option>
                    <option value="cash">Cash</option>
                    <option value="transfer">Mobile / Bank transfer</option>
                    <option value="bank">Bank (cheque / direct)</option>
                  </select>
                  {form.formState.errors.paymentMethod && <p className="text-xs text-red-600">{String(form.formState.errors.paymentMethod.message)}</p>}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={uploading}>Save product</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditProductDialogById({
  id,
  products,
  isAdmin,
  suppliers,
  onClose,
}: {
  id: string;
  products: AdminProduct[];
  isAdmin: boolean;
  suppliers: SupplierOption[];
  onClose: () => void;
}) {
  const fromPage = products.find((p) => p.id === id);
  const { data: fetched, isLoading } = useClientQuery<AdminProduct>({
    queryKey: ["admin", "product-single", id],
    queryFn: () => fetch(`/api/products/${id}`).then((r) => r.json()),
    enabled: Boolean(id),
  });
  const product = fetched ?? fromPage;
  if (!product && isLoading) return null;
  if (!product) return null;
  return (
    <EditProductDialog
      product={product}
      isAdmin={isAdmin}
      suppliers={suppliers}
      open={true}
      onOpenChange={(o) => { if (!o) onClose(); }}
    />
  );
}

export function EditProductDialog({
  product,
  isAdmin,
  suppliers,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  product: AdminProduct;
  isAdmin: boolean;
  suppliers: SupplierOption[];
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const systemSupplierNames = useMemo(() => new Set<string>(SYSTEM_SUPPLIER_NAMES), []);
  const assignableSuppliers = useMemo(
    () => suppliers.filter((s) => !systemSupplierNames.has(s.name.trim().toLowerCase())),
    [suppliers, systemSupplierNames],
  );

  const [open, setOpen] = useState(false);
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = onOpenChange || setOpen;
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(product.imageUrl);
  const [saving, setSaving] = useState(false);
  const [linkSupplierId, setLinkSupplierId] = useState("");
  const [linkLeadTime, setLinkLeadTime] = useState("");
  const [linkMinOrderQty, setLinkMinOrderQty] = useState("");
  const [linkPackSize, setLinkPackSize] = useState("");
  const [linkPrimary, setLinkPrimary] = useState(false);
  const priceStockLocked =
    !isAdmin && Date.now() - new Date(product.createdAt).getTime() > 48 * 60 * 60 * 1000;

  const { data: linksData } = useClientQuery<{
    rows: Array<{
      supplierId: string;
      isPrimary: boolean;
      leadTimeDays?: number | null;
      minOrderQty?: number | null;
      packSize?: number | null;
      supplier: { name: string };
    }>;
  }>({
    queryKey: ["admin", "product-suppliers", product.id],
    queryFn: () => fetch(`/api/admin/products/${product.id}/suppliers`).then((r) => r.json()),
    enabled: actualOpen,
  });
  const supplierLinks = Array.isArray(linksData?.rows) ? linksData.rows : [];

  type ProductEditFormValues = z.input<typeof productEditSchema>;
  const defaultValues = useMemo<ProductEditFormValues>(
    () => ({
      name: product.name,
      description: product.description ?? undefined,
      imageUrl: product.imageUrl ?? undefined,
      category: product.category ?? "",
      brand: product.brand ?? "",
      supplier: product.supplier ?? "",
      supplierId: product.supplierId ?? "",
      minMarginPct: product.minMarginPct ?? undefined,
      marginOverrideReason: undefined,
      price: Number(product.price || 0),
      stock: Number(product.stock || 0),
      requiresLotTracking: Boolean(product.requiresLotTracking),
      requiresExpiryDate: Boolean(product.requiresExpiryDate),
      editReason: "",
    }),
    [
      product.brand,
      product.category,
      product.description,
      product.imageUrl,
      product.minMarginPct,
      product.name,
      product.price,
      product.requiresExpiryDate,
      product.requiresLotTracking,
      product.stock,
      product.supplier,
      product.supplierId,
    ],
  );
  const form = useForm<ProductEditFormValues>({
    resolver: zodResolver(productEditSchema) as unknown as Resolver<ProductEditFormValues>,
    defaultValues,
  });
  const editPrice = Number(form.watch("price") ?? product.price ?? 0);
  const editCost = Number(product.cost ?? 0);
  const editMinMargin = form.watch("minMarginPct");
  const editOverrideReason = form.watch("marginOverrideReason");
  const editMarginPct = editPrice > 0 ? ((editPrice - editCost) / editPrice) * 100 : 0;
  const editMarginError = getMarginGuardError({
    price: editPrice,
    cost: editCost,
    minMarginPct: typeof editMinMargin === "number" ? editMinMargin : undefined,
  });
  const requiresLotTracking = form.watch("requiresLotTracking");
  const requiresExpiryDate = form.watch("requiresExpiryDate");
  const supplierField = form.register("supplier", {
    onChange: (event) => {
      form.setValue("supplierId", undefined);
      return event;
    },
  });

  useEffect(() => {
    if (!actualOpen) return;
    form.reset(defaultValues);
    setPreview(product.imageUrl ?? null);
    setLinkSupplierId("");
    setLinkLeadTime("");
    setLinkMinOrderQty("");
    setLinkPackSize("");
    setLinkPrimary(false);
  }, [actualOpen, defaultValues, form, product.id, product.imageUrl, product.updatedAt]);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const saveSupplierLink = async () => {
    if (!linkSupplierId) {
      toast.error("Select a supplier to link.");
      return;
    }
    try {
      const payload = {
        supplierId: linkSupplierId,
        isPrimary: linkPrimary,
        leadTimeDays: linkLeadTime ? Number(linkLeadTime) : undefined,
        minOrderQty: linkMinOrderQty ? Number(linkMinOrderQty) : undefined,
        packSize: linkPackSize ? Number(linkPackSize) : undefined,
      };
      const res = await fetch(`/api/admin/products/${product.id}/suppliers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save supplier link.");
      toast.success("Supplier link saved.");
      setLinkSupplierId("");
      setLinkLeadTime("");
      setLinkMinOrderQty("");
      setLinkPackSize("");
      setLinkPrimary(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "product-suppliers", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "product-single", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save supplier link.");
    }
  };

  const deleteSupplierLink = async (supplierId: string) => {
    try {
      const res = await fetch(`/api/admin/products/${product.id}/suppliers`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete supplier link.");
      toast.success("Supplier link removed.");
      queryClient.invalidateQueries({ queryKey: ["admin", "product-suppliers", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "product-single", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete supplier link.");
    }
  };

  const onSubmit: SubmitHandler<ProductEditFormValues> = async (values) => {
    const parsed = productEditSchema.parse(values);
    try {
      setSaving(true);
      const payload: Partial<Pick<AdminProduct, "name" | "description" | "imageUrl" | "price" | "stock" | "category" | "brand" | "supplier" | "requiresLotTracking" | "requiresExpiryDate" | "minMarginPct">> & {
        editReason?: string;
        marginOverrideReason?: string;
        supplierId?: string | null;
      } = {};
      if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
        const capitalized = toTitleCase(parsed.name.trim());
        payload.name = capitalized;
      }
      if (typeof parsed.description === "string" && parsed.description.trim() !== "") {
        payload.description = parsed.description.trim();
      }
      if (typeof parsed.imageUrl === "string" && parsed.imageUrl.trim() !== "") {
        payload.imageUrl = parsed.imageUrl.trim();
      }
      if (typeof parsed.category === "string" && parsed.category.trim() !== "") {
        const nextCategory = parsed.category.trim();
        const currentCategory = String(product.category || "");
        if (nextCategory !== currentCategory) {
          payload.category = nextCategory;
        }
      }
      if (typeof parsed.brand === "string" && parsed.brand.trim() !== "") {
        const nextBrand = parsed.brand.trim();
        const currentBrand = String(product.brand || "");
        if (nextBrand !== currentBrand) {
          payload.brand = nextBrand;
        }
      }
      const nextSupplierId = typeof parsed.supplierId === "string" ? parsed.supplierId.trim() : "";
      const nextSupplier = typeof parsed.supplier === "string" ? parsed.supplier.trim() : "";
      const currentSupplierId = String(product.supplierId || "");
      const currentSupplier = String(product.supplier || "");
      if (nextSupplierId) {
        if (nextSupplierId !== currentSupplierId) {
          payload.supplierId = nextSupplierId;
        }
      } else if (nextSupplier) {
        if (nextSupplier !== currentSupplier || currentSupplierId) {
          payload.supplier = nextSupplier;
          if (currentSupplierId) payload.supplierId = null;
        }
      }
      const nextMinMargin =
        typeof parsed.minMarginPct === "number" && Number.isFinite(parsed.minMarginPct)
          ? parsed.minMarginPct
          : undefined;
      const currentMinMargin =
        product.minMarginPct != null ? Number(product.minMarginPct) : undefined;
      if (nextMinMargin !== undefined && nextMinMargin !== currentMinMargin) {
        payload.minMarginPct = nextMinMargin;
      } else if (nextMinMargin === undefined && currentMinMargin !== undefined) {
        payload.minMarginPct = null;
      }
      if (typeof parsed.marginOverrideReason === "string" && parsed.marginOverrideReason.trim() !== "") {
        payload.marginOverrideReason = parsed.marginOverrideReason.trim();
      }
      const nextPrice = Number(parsed.price);
      const nextStock = Number(parsed.stock);
      const oldPrice = Number(product.price);
      const oldStock = Number(product.stock);
      const oldRequiresLotTracking = Boolean(product.requiresLotTracking);
      const oldRequiresExpiryDate = Boolean(product.requiresExpiryDate);
      if (!Number.isNaN(nextPrice) && nextPrice !== oldPrice) {
        if (priceStockLocked) {
          toast.error("Price/stock edits are locked after 48 hours for non-admin roles.");
          setSaving(false);
          return;
        }
        payload.price = nextPrice;
      }
      if (!Number.isNaN(nextStock) && nextStock !== oldStock) {
        if (priceStockLocked) {
          toast.error("Price/stock edits are locked after 48 hours for non-admin roles.");
          setSaving(false);
          return;
        }
        payload.stock = nextStock;
      }
      if (typeof parsed.requiresLotTracking === "boolean" && parsed.requiresLotTracking !== oldRequiresLotTracking) {
        payload.requiresLotTracking = parsed.requiresLotTracking;
      }
      if (typeof parsed.requiresExpiryDate === "boolean" && parsed.requiresExpiryDate !== oldRequiresExpiryDate) {
        payload.requiresExpiryDate = parsed.requiresExpiryDate;
        if (parsed.requiresExpiryDate && !parsed.requiresLotTracking) {
          payload.requiresLotTracking = true;
        }
      }
      if (typeof parsed.editReason === "string" && parsed.editReason.trim() !== "") {
        payload.editReason = parsed.editReason.trim();
      }
      // If nothing to update, bail early
      const { editReason, ...changes } = payload;
      if (Object.keys(changes).length === 0) {
        toast.info("No changes to save");
        setSaving(false);
        return;
      }
      if (!editReason) {
        toast.error("Please add a brief reason for this change.");
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || "Failed to update product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "product-single", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "product-suppliers", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.success(`${payload.name ?? product.name} updated`);
      form.setValue("editReason", "");
      setActualOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error updating product");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || <Button size="sm" variant="secondary">Edit</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-h-[85vh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Edit Product</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit(onSubmit, (errs) => {
            const first = Object.values(errs)[0];
            toast.error(typeof first?.message === "string" ? first.message : "Please fix the highlighted fields");
          })}
          className="space-y-4"
        >
          <fieldset disabled={uploading || saving} className="space-y-4">

            {/* ── Section 1: Basic Info ── */}
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Basic info</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1 sm:col-span-2">
                  <Label>Name</Label>
                  <Input {...form.register("name")} className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`} />
                  {form.formState.errors.name && <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>Description</Label>
                  <Input {...form.register("description")} className={form.formState.errors.description ? "border-red-500" : undefined} />
                  {form.formState.errors.description && <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>}
                </div>
                <div className="space-y-1">
                  <Label>Category</Label>
                  <select {...form.register("category")} className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${form.formState.errors.category ? "border-red-500" : ""}`}>
                    <option value="">Select a category</option>
                    {PRODUCT_CATEGORY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                  {form.formState.errors.category && <p className="text-xs text-red-600">{String(form.formState.errors.category.message)}</p>}
                </div>
                <div className="space-y-1">
                  <Label>Brand</Label>
                  <Input {...form.register("brand")} className={form.formState.errors.brand ? "border-red-500" : undefined} />
                  {form.formState.errors.brand && <p className="text-xs text-red-600">{String(form.formState.errors.brand.message)}</p>}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>Image</Label>
                  <div className="flex gap-2 items-start">
                    <div className="flex-1 space-y-1.5">
                      <Input placeholder="https://… or /images/…" {...form.register("imageUrl")} className={form.formState.errors.imageUrl ? "border-red-500" : undefined} />
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">or upload:</span>
                        <Input type="file" accept="image/*" onChange={handleFileChange} className="text-xs h-8" />
                      </div>
                      {uploading && <p className="text-xs text-muted-foreground">Uploading…</p>}
                      {form.formState.errors.imageUrl && <p className="text-xs text-red-600">{String(form.formState.errors.imageUrl.message)}</p>}
                    </div>
                    {(() => {
                      const url = (form.watch("imageUrl") as string) || preview || "";
                      return url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          <img src={url} alt="Preview" className="w-16 h-16 rounded-md object-cover border flex-shrink-0" />
                        </a>
                      ) : null;
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Section 2: Supplier ── */}
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supplier</p>
              <div className="space-y-1">
                <Label>Primary supplier</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.watch("supplierId") || ""}
                  onChange={(e) => { const nextId = e.target.value || ""; form.setValue("supplierId", nextId || undefined); const match = assignableSuppliers.find((s) => s.id === nextId); if (match) form.setValue("supplier", match.name); }}>
                  <option value="">Select supplier…</option>
                  {assignableSuppliers.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.leadTimeDays}d</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground">Or enter supplier name</Label>
                <Input {...supplierField} placeholder="Supplier name" className={form.formState.errors.supplier ? "border-red-500" : undefined} />
              </div>
              {form.formState.errors.supplier && <p className="text-xs text-red-600">{String(form.formState.errors.supplier.message)}</p>}

              {/* Alternate supplier links */}
              <div className="rounded-md bg-muted/40 p-3 space-y-2">
                <p className="text-xs font-medium">Alternate suppliers</p>
                {supplierLinks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None linked yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {supplierLinks.map((link) => (
                      <div key={link.supplierId} className="flex items-center justify-between gap-2 text-sm rounded border bg-background px-2 py-1.5">
                        <div>
                          <span className="font-medium">{link.supplier.name}</span>
                          {link.isPrimary && <span className="ml-1.5 text-[10px] rounded border px-1 py-0.5 font-medium">Primary</span>}
                          <div className="text-xs text-muted-foreground mt-0.5">LT {link.leadTimeDays ?? "—"} · MOQ {link.minOrderQty ?? "—"} · Pack {link.packSize ?? "—"}</div>
                        </div>
                        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => deleteSupplierLink(link.supplierId)}>Remove</Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2 pt-1">
                  <select className="h-8 col-span-2 w-full rounded-md border border-input bg-background px-2 text-sm" value={linkSupplierId} onChange={(e) => setLinkSupplierId(e.target.value)}>
                    <option value="">Add supplier…</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <Input placeholder="Lead time (days)" value={linkLeadTime} onChange={(e) => setLinkLeadTime(e.target.value)} className="h-8 text-sm" />
                  <Input placeholder="Min order qty" value={linkMinOrderQty} onChange={(e) => setLinkMinOrderQty(e.target.value)} className="h-8 text-sm" />
                  <Input placeholder="Pack size" value={linkPackSize} onChange={(e) => setLinkPackSize(e.target.value)} className="h-8 text-sm" />
                  <label className="flex items-center gap-1.5 text-xs col-span-2 cursor-pointer">
                    <input type="checkbox" checked={linkPrimary} onChange={(e) => setLinkPrimary(e.target.checked)} /> Set as primary
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button type="button" size="sm" variant="outline" onClick={saveSupplierLink}>Add link</Button>
                </div>
              </div>
            </div>{/* end Supplier section */}

            {/* ── Section 3: Pricing ── */}
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pricing</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Selling price {priceStockLocked && <span className="text-xs text-muted-foreground font-normal">(locked)</span>}</Label>
                  <Input type="number" step="0.01" {...form.register("price", { valueAsNumber: true })} disabled={priceStockLocked} className={form.formState.errors.price ? "border-red-500" : undefined} />
                  {form.formState.errors.price && <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>}
                  {priceStockLocked && <p className="text-xs text-muted-foreground">Price edits are locked after 48 hours for non-admin roles.</p>}
                </div>
                <div className="space-y-1">
                  <Label>Weighted avg. cost <span className="text-muted-foreground font-normal text-xs">(read-only)</span></Label>
                  <Input type="number" step="0.01" value={Number(product.cost || 0)} readOnly disabled className="bg-muted" />
                  <p className="text-xs text-muted-foreground">Auto-calculated from purchases. Edit via Purchases.</p>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>Min margin % <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input type="number" step="0.1" placeholder="e.g. 10"
                    {...form.register("minMarginPct", { setValueAs: (v) => (v === "" || v == null ? undefined : Number(v)) })}
                    className={form.formState.errors.minMarginPct ? "border-red-500" : undefined} />
                  <p className="text-xs text-muted-foreground">
                    Current margin: <span className={typeof editMinMargin === "number" && editMarginPct < editMinMargin ? "text-amber-600 font-medium" : ""}>
                      {Number.isFinite(editMarginPct) ? editMarginPct.toFixed(1) : "0.0"}%
                    </span>
                  </p>
                  {form.formState.errors.minMarginPct && <p className="text-xs text-red-600">{String(form.formState.errors.minMarginPct.message)}</p>}
                </div>
                {editMarginError && (
                  <div className="space-y-1 sm:col-span-2">
                    <Label>Override reason <span className="text-amber-600 text-xs">(required — margin violation)</span></Label>
                    <Input placeholder="Explain why this price is permitted (min 5 chars)"
                      {...form.register("marginOverrideReason", { setValueAs: (v) => (v ? String(v).trim() : undefined) })}
                      className={!editOverrideReason || String(editOverrideReason).trim().length < 5 ? "border-amber-500" : undefined} />
                    <p className="text-xs text-amber-600">{editMarginError}</p>
                  </div>
                )}
              </div>
            </div>

            {/* ── Section 4: Inventory ── */}
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Inventory</p>
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <Label>Stock on hand</Label>
                    <p className="text-2xl font-semibold">{Number(product.stock || 0)}</p>
                    <p className="text-xs text-muted-foreground">
                      Inventory changes now go through the dedicated adjustment workflow for clearer audit history.
                    </p>
                  </div>
                  <Button type="button" variant="outline" asChild data-testid="adjust-inventory-link">
                    <Link href={`/admin/stock-adjustments?productId=${encodeURIComponent(product.id)}&q=${encodeURIComponent(product.sku || product.name)}`}>
                      Adjust inventory
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="rounded-md bg-muted/40 p-3 space-y-2">
                <p className="text-xs font-medium">Regulated SKU tracking</p>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input id={`requiresLotTracking-${product.id}`} type="checkbox" checked={requiresLotTracking === true}
                    onChange={(e) => { const n = e.target.checked; form.setValue("requiresLotTracking", n); if (!n && requiresExpiryDate) form.setValue("requiresExpiryDate", false); }} />
                  Require lot / batch tracking
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input id={`requiresExpiryDate-${product.id}`} type="checkbox" checked={requiresExpiryDate === true}
                    onChange={(e) => { const n = e.target.checked; form.setValue("requiresExpiryDate", n); if (n) form.setValue("requiresLotTracking", true); }} />
                  Require expiry date
                </label>
                <p className="text-xs text-muted-foreground">When enabled, purchases and adjustments must include lot codes and/or expiry dates.</p>
              </div>
            </div>

            {/* ── Reason for change (always required) ── */}
            <div className="space-y-1">
              <Label>Reason for this change <span className="text-red-500">*</span></Label>
              <Input placeholder="e.g., correcting description / stock audit / price update"
                {...form.register("editReason")}
                className={form.formState.errors.editReason ? "border-red-500" : undefined} />
              {form.formState.errors.editReason && <p className="text-xs text-red-600">{String(form.formState.errors.editReason.message)}</p>}
            </div>

            <div className="flex justify-end pt-1">
              <Button type="submit" disabled={uploading || saving}>
                {saving ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />Saving…</> : "Save changes"}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete Dialog
export function DeleteProductDialog({ id, name, trigger, open: controlledOpen, onOpenChange }: { id: string; name: string; trigger?: ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = (nextOpen: boolean) => {
    if (!nextOpen) setDeleteReason("");
    (onOpenChange || setOpen)(nextOpen);
  };

  const handleDelete = async () => {
    if (deleteReason.trim().length < 5) {
      toast.error("Please provide a brief delete reason.");
      return;
    }
    try {
      setDeleting(true);
      const res = await fetch(`/api/products/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(j?.error || "Failed to delete product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.warning(`${name} deleted`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const restore = await fetch(`/api/products/${id}`, { method: "POST" });
            if (!restore.ok) {
              const j = await restore.json().catch(async () => ({ error: await restore.text().catch(() => "") }));
              toast.error(j?.error || "Failed to restore product");
              return;
            }
            queryClient.invalidateQueries({ queryKey: ["admin","products"] });
            toast.success(`${name} restored`);
          },
        },
      });
      setActualOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="destructive" className="text-white">Delete</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Delete {name}?</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The product will be soft-deleted. You can restore it from the toast notification that appears immediately after.
          </p>
          <div className="space-y-1">
            <Label htmlFor={`delete-reason-${id}`}>Reason for delete</Label>
            <Input
              id={`delete-reason-${id}`}
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              placeholder="e.g., duplicate catalog entry"
              disabled={deleting}
            />
            <p className="text-xs text-muted-foreground">This reason is recorded in the audit log.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setActualOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting || deleteReason.trim().length < 5}>
            {deleting ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Confirm"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


