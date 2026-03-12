"use client";

export const dynamic = "force-dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency } from "@/lib/currency";

type CustomerRow = { user: { id: string; name: string | null; email: string | null; phone?: string | null; role?: string | null } };
type ProductRow = {
  id: string;
  name: string;
  price: number | string;
  stock?: number;
  sellableStock?: number | null;
  archived?: boolean;
};
type DraftLine = {
  raw: string;
  itemRef: string;
  quantity: number;
  productId: string | null;
  productName: string | null;
  matchedBy: "sku" | "name" | "fuzzy" | "tender" | null;
};
type B2BDraft = {
  requestId: string;
  customerId: string;
  clinicName: string;
  contactName: string;
  lines: DraftLine[];
  matchedCount: number;
  unmatchedCount: number;
  canPrefill: boolean;
};
type OrderLine = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
};
type BackorderDraft = {
  sourceOrderId: string;
  sourceStatus: string;
  customerId: string;
  customerName: string;
  lines: DraftLine[];
  matchedCount: number;
  unmatchedCount: number;
  note: string;
};
type TenderOrderDraft = {
  tenderId: string;
  tenderNumber: string;
  customerId: string | null;
  buyerName: string;
  buyerContact: string | null;
  buyerEmail: string | null;
  notes: string | null;
  lines: DraftLine[];
  matchedCount: number;
  unmatchedCount: number;
  canPrefill: boolean;
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function NewAdminOrderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isAdmin = String((session?.user as { role?: string } | undefined)?.role || "").toUpperCase() === "ADMIN";
  const { data: customersData } = useClientQuery({ queryKey: ["admin","customers"], queryFn: () => fetcher("/api/admin/customers") });
  const { data: productsData } = useClientQuery({
    queryKey: ["products", { pageSize: 200, includeArchived: 1 }],
    queryFn: () => fetcher("/api/products?pageSize=200&includeArchived=1&includeSellableStock=1"),
  });

  const customers: CustomerRow[] = useMemo(() => customersData?.rows || [], [customersData?.rows]);
  const customerAccounts = useMemo(
    () =>
      customers.filter(
        (row) =>
          String(row.user?.role || "").toUpperCase() === "CUSTOMER" &&
          Boolean(String(row.user?.email || "").trim()),
      ),
    [customers],
  );
  const products: ProductRow[] = useMemo(
    () => (productsData?.items || []) as ProductRow[],
    [productsData],
  );

  const [userId, setUserId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("1");
  const [items, setItems] = useState<OrderLine[]>([]);
  const [partialDeliveredByItem, setPartialDeliveredByItem] = useState<Record<string, string>>({});
  const [partialDeliveredErrors, setPartialDeliveredErrors] = useState<Record<string, string>>({});
  const [initialPayment, setInitialPayment] = useState<string>("");
  const [initialPaymentMethod, setInitialPaymentMethod] = useState<"" | "cash" | "momo" | "transfer">("");
  const [initialPaymentReference, setInitialPaymentReference] = useState("");
  const [showUpfrontPayment, setShowUpfrontPayment] = useState(false);
  const [taxRate, setTaxRate] = useState<string>("");
  const [discountAmount, setDiscountAmount] = useState<string>("");
  const [discountReason, setDiscountReason] = useState<string>("");
  const [errors, setErrors] = useState<{
    userId?: string;
    productId?: string;
    quantity?: string;
    items?: string;
    initialPayment?: string;
    initialPaymentMethod?: string;
    initialPaymentReference?: string;
    taxRate?: string;
    discountAmount?: string;
    discountReason?: string;
  }>({});
  const [deliveryStatus, setDeliveryStatus] = useState<
    "NOT_SET" | "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED"
  >("NOT_SET");
  const [orderNote, setOrderNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lastValidationAt, setLastValidationAt] = useState<Date | null>(null);
  const [stockWarning, setStockWarning] = useState<{
    productId: string;
    productName: string;
    requestedQty: number;
    availableQty: number;
    remainingQty: number;
  } | null>(null);
  const [restockEtaDays, setRestockEtaDays] = useState("");
  const [loadingB2BDraft, setLoadingB2BDraft] = useState(false);
  const [b2bDraftMeta, setB2BDraftMeta] = useState<{
    requestId: string;
    clinicName: string;
    contactName: string;
    unmatched: string[];
  } | null>(null);
  const [backorderDraftMeta, setBackorderDraftMeta] = useState<{
    sourceOrderId: string;
    customerName: string;
    unmatched: string[];
  } | null>(null);
  const [tenderDraftMeta, setTenderDraftMeta] = useState<{
    tenderId: string;
    tenderNumber: string;
    buyerName: string;
    unmatched: string[];
  } | null>(null);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [products, productId]
  );
  const getEffectiveAvailable = (product?: ProductRow | null) => {
    if (!product) return 0;
    const value =
      typeof product.sellableStock === "number"
        ? product.sellableStock
        : Number(product.stock ?? 0);
    return Math.max(0, Math.floor(Number(value || 0)));
  };

  const subtotal = items.reduce((s, it) => s + it.price * it.quantity, 0);
  const taxRateNum = Number(taxRate || 0);
  const taxAmount =
    Number.isFinite(taxRateNum) && taxRateNum > 0 ? subtotal * (taxRateNum / 100) : 0;
  const grossTotal = subtotal + taxAmount;
  const rawDiscount = Number(discountAmount || 0);
  const discountNum =
    isAdmin && Number.isFinite(rawDiscount) ? Math.max(0, Math.min(rawDiscount, grossTotal)) : 0;
  const total = Math.max(0, grossTotal - discountNum);
  const stockShortages = useMemo(() => {
    const productById = new Map(products.map((p) => [p.id, p]));
    return items
      .map((it) => {
        const product = productById.get(it.productId);
        const available = getEffectiveAvailable(product);
        const shortage = Math.max(0, it.quantity - available);
        return {
          ...it,
          available,
          shortage,
        };
      })
      .filter((it) => it.shortage > 0);
  }, [items, products]);
  const hasStockShortage = stockShortages.length > 0;

  useEffect(() => {
    const backorderOrderId = searchParams.get("backorderOrderId") || "";
    if (!backorderOrderId) return;
    let cancelled = false;
    async function loadBackorderDraft() {
      try {
        setLoadingB2BDraft(true);
        const res = await fetch(`/api/admin/orders/${backorderOrderId}/backorder-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          draft?: BackorderDraft;
        };
        if (!res.ok || !body?.draft) {
          toast.error(body?.error || "Failed to load backorder fulfillment draft");
          return;
        }
        if (cancelled) return;
        const draft = body.draft;
        setUserId(draft.customerId);
        const matchedItems = draft.lines
          .filter((line) => !!line.productId)
          .map((line) => ({
            productId: line.productId as string,
            name: line.productName || line.itemRef,
            price: Number(products.find((p) => p.id === line.productId)?.price || 0),
            quantity: line.quantity,
          }));
        setItems(matchedItems);
        setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${draft.note}` : draft.note));
        setBackorderDraftMeta({
          sourceOrderId: draft.sourceOrderId,
          customerName: draft.customerName,
          unmatched: draft.lines.filter((line) => !line.productId).map((line) => line.raw),
        });
        toast.success("Backorder fulfillment draft loaded.");
      } finally {
        if (!cancelled) setLoadingB2BDraft(false);
      }
    }
    loadBackorderDraft();
    return () => {
      cancelled = true;
    };
  }, [products, searchParams]);

  useEffect(() => {
    const tenderId = searchParams.get("tenderId") || "";
    if (!tenderId) return;
    let cancelled = false;
    async function loadTenderDraft() {
      try {
        setLoadingB2BDraft(true);
        const res = await fetch(`/api/admin/b2b/tenders/${tenderId}/draft-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; draft?: TenderOrderDraft };
        if (!res.ok || !body?.draft) {
          toast.error(body?.error || "Failed to load tender order draft");
          return;
        }
        if (cancelled) return;
        const draft = body.draft;
        setB2BDraftMeta(null);
        setBackorderDraftMeta(null);
        const fallbackCustomerId =
          draft.customerId || (customerAccounts.length === 1 ? customerAccounts[0].user.id : null);
        if (fallbackCustomerId) {
          setUserId(fallbackCustomerId);
          if (!draft.customerId && customerAccounts.length === 1) {
            toast.info("No linked customer found on tender. Auto-selected the only customer account.");
          }
        }
        const matchedItems = draft.lines
          .filter((line) => !!line.productId)
          .map((line) => ({
            productId: line.productId as string,
            name: line.productName || line.itemRef,
            price: Number(products.find((p) => p.id === line.productId)?.price || 0),
            quantity: line.quantity,
          }));
        setItems(matchedItems);
        if (draft.notes?.trim()) {
          setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${draft.notes}` : draft.notes || ""));
        }
        setTenderDraftMeta({
          tenderId: draft.tenderId,
          tenderNumber: draft.tenderNumber,
          buyerName: draft.buyerName,
          unmatched: draft.lines.filter((line) => !line.productId).map((line) => line.raw),
        });
        toast.success("Tender draft loaded into order form.");
      } finally {
        if (!cancelled) setLoadingB2BDraft(false);
      }
    }
    loadTenderDraft();
    return () => {
      cancelled = true;
    };
  }, [products, customerAccounts, searchParams]);

  useEffect(() => {
    const requestId = searchParams.get("b2bRequestId") || "";
    if (!requestId) return;
    let cancelled = false;
    async function loadDraft() {
      try {
        setLoadingB2BDraft(true);
        const res = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/draft-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; draft?: B2BDraft };
        if (!res.ok || !body?.draft) {
          toast.error(body?.error || "Failed to load B2B draft");
          return;
        }
        if (cancelled) return;
        const draft = body.draft;
        setBackorderDraftMeta(null);
        setTenderDraftMeta(null);
        setUserId(draft.customerId);
        const matchedItems = draft.lines
          .filter((line) => !!line.productId)
          .map((line) => ({
            productId: line.productId as string,
            name: line.productName || line.itemRef,
            price: Number(products.find((p) => p.id === line.productId)?.price || 0),
            quantity: line.quantity,
          }));
        setItems(matchedItems);
        setB2BDraftMeta({
          requestId: draft.requestId,
          clinicName: draft.clinicName,
          contactName: draft.contactName,
          unmatched: draft.lines.filter((line) => !line.productId).map((line) => line.raw),
        });
        toast.success("B2B request draft loaded into order form.");
      } finally {
        if (!cancelled) setLoadingB2BDraft(false);
      }
    }
    loadDraft();
    return () => {
      cancelled = true;
    };
  }, [products, searchParams]);

  function addItem() {
    if (!selectedProduct) {
      setErrors((prev) => ({ ...prev, productId: "Select a product." }));
      return;
    }
    const qty = Math.max(1, Number(quantity || 1));
    if (Number.isNaN(qty) || qty <= 0) {
      setErrors((prev) => ({ ...prev, quantity: "Quantity must be at least 1." }));
      return;
    }
    const safeAvailable = getEffectiveAvailable(selectedProduct);
    if (qty > safeAvailable) {
      setStockWarning({
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        requestedQty: qty,
        availableQty: safeAvailable,
        remainingQty: Math.max(0, qty - safeAvailable),
      });
      if (safeAvailable <= 0) {
        setErrors((prev) => ({
          ...prev,
          quantity: `${selectedProduct.name} is out of stock.`,
        }));
      } else {
        setErrors((prev) => ({
          ...prev,
          quantity: `Only ${safeAvailable} in stock for ${selectedProduct.name}. Use split supply option below.`,
        }));
      }
      return;
    }
    setItems((prev) => {
      const existing = prev.find((it) => it.productId === selectedProduct.id);
      if (existing) {
        return prev.map((it) => (it.productId === selectedProduct.id ? { ...it, quantity: it.quantity + qty } : it));
      }
      return [
        ...prev,
        {
          productId: selectedProduct.id,
          name: selectedProduct.name,
          price: Number(selectedProduct.price),
          quantity: qty,
        },
      ];
    });
    setQuantity("1");
    setProductId("");
    setStockWarning(null);
    setRestockEtaDays("");
    setErrors((prev) => ({ ...prev, productId: "", quantity: "", items: "" }));
  }

  function addAvailableFromWarning(includeBackorderNote: boolean) {
    if (!stockWarning) return;
    if (stockWarning.availableQty <= 0) {
      toast.error("No stock available to add now.");
      return;
    }
    setItems((prev) => {
      const existing = prev.find((it) => it.productId === stockWarning.productId);
      if (existing) {
        return prev.map((it) =>
          it.productId === stockWarning.productId
            ? { ...it, quantity: it.quantity + stockWarning.availableQty }
            : it,
        );
      }
      const p = products.find((row) => row.id === stockWarning.productId);
      return [
        ...prev,
        {
          productId: stockWarning.productId,
          name: stockWarning.productName,
          price: Number(p?.price || 0),
          quantity: stockWarning.availableQty,
        },
      ];
    });

    if (includeBackorderNote) {
      const eta = Number(restockEtaDays || 0);
      const etaPart = Number.isFinite(eta) && eta > 0 ? ` ETA ${eta} day(s).` : "";
      const line = `Backorder pending: ${stockWarning.productName} requested ${stockWarning.requestedQty}, supplying ${stockWarning.availableQty} now, remaining ${stockWarning.remainingQty}.${etaPart}`;
      setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${line}` : line));
    }

    toast.success(`Added ${stockWarning.availableQty} now for ${stockWarning.productName}.`);
    setQuantity(String(stockWarning.remainingQty || 1));
    setStockWarning(null);
    setRestockEtaDays("");
    setErrors((prev) => ({ ...prev, quantity: "" }));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.productId !== id));
    setPartialDeliveredByItem((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPartialDeliveredErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function capAllToAvailable() {
    const shortageById = new Map(stockShortages.map((row) => [row.productId, row]));
    if (!shortageById.size) return;
    const pendingNotes: string[] = [];
    const nextItems = items
      .map((it) => {
        const shortage = shortageById.get(it.productId);
        if (!shortage) return it;
        if (shortage.available <= 0) {
          pendingNotes.push(
            `Backorder pending: ${shortage.name} requested ${shortage.quantity}, supplying 0 now, remaining ${shortage.quantity}.`,
          );
          return null;
        }
        pendingNotes.push(
          `Backorder pending: ${shortage.name} requested ${shortage.quantity}, supplying ${shortage.available} now, remaining ${shortage.shortage}.`,
        );
        return {
          ...it,
          quantity: shortage.available,
        };
      })
      .filter((row): row is OrderLine => Boolean(row));
    setItems(nextItems);
    if (pendingNotes.length > 0) {
      setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${pendingNotes.join("\n")}` : pendingNotes.join("\n")));
    }
    toast.success("Adjusted item quantities to available stock and added pending supply notes.");
  }

  const selectedCustomer = useMemo(
    () => customerAccounts.find((row) => row.user.id === userId)?.user || null,
    [customerAccounts, userId],
  );
  const hasUnsavedChanges = useMemo(
    () =>
      Boolean(
        userId ||
          productId ||
          quantity !== "1" ||
          items.length > 0 ||
          Object.keys(partialDeliveredByItem).length > 0 ||
          initialPayment.trim() ||
          initialPaymentMethod ||
          initialPaymentReference.trim() ||
          showUpfrontPayment ||
          taxRate.trim() ||
          discountAmount.trim() ||
          discountReason.trim() ||
          orderNote.trim() ||
          deliveryStatus !== "NOT_SET",
      ),
    [
      userId,
      productId,
      quantity,
      items.length,
      partialDeliveredByItem,
      initialPayment,
      initialPaymentMethod,
      initialPaymentReference,
      showUpfrontPayment,
      taxRate,
      discountAmount,
      discountReason,
      orderNote,
      deliveryStatus,
    ],
  );
  const currentFlowStep = useMemo(() => {
    const hasPaymentGap =
      showUpfrontPayment && Number(initialPayment || 0) > 0 && !initialPaymentMethod;
    if (!userId) return 0;
    if (items.length === 0) return 1;
    if (hasPaymentGap) return 2;
    return 3;
  }, [userId, items.length, showUpfrontPayment, initialPayment, initialPaymentMethod]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges || submitting) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges, submitting]);

  async function submit(confirmed = false) {
    if (submitting) return;
    setLastValidationAt(new Date());
    const nextErrors: typeof errors = {};
    if (items.length === 0) {
      nextErrors.items = "Add at least one item.";
    }
    if (!userId) {
      nextErrors.userId = "Select a customer.";
    }
    const initPay = Number(initialPayment || 0);
    const hasInitialPaymentInput = initialPayment.trim().length > 0;
    if (showUpfrontPayment && hasInitialPaymentInput && (!Number.isFinite(initPay) || initPay < 0)) {
      nextErrors.initialPayment = "Enter a valid initial payment.";
    } else if (showUpfrontPayment && Number.isFinite(initPay) && initPay > total) {
      nextErrors.initialPayment = "Initial payment cannot exceed the order total.";
    }
    if (isAdmin && discountAmount.trim()) {
      const d = Number(discountAmount || 0);
      if (!Number.isFinite(d) || d < 0) {
        nextErrors.discountAmount = "Enter a valid discount amount.";
      } else if (d > grossTotal) {
        nextErrors.discountAmount = "Discount cannot exceed subtotal + tax.";
      } else if (d > 0 && !discountReason.trim()) {
        nextErrors.discountReason = "Discount reason is required.";
      }
    }
    if (showUpfrontPayment && initialPaymentMethod) {
      if (!(Number.isFinite(initPay) && initPay > 0)) {
        nextErrors.initialPayment = "Enter initial payment amount.";
      }
      if (
        (initialPaymentMethod === "momo" || initialPaymentMethod === "transfer") &&
        Number.isFinite(initPay) &&
        initPay > 0 &&
        !initialPaymentReference.trim()
      ) {
        nextErrors.initialPaymentReference = "Reference is required for MoMo and transfer.";
      }
    } else if (showUpfrontPayment && Number.isFinite(initPay) && initPay > 0 && !initialPaymentMethod) {
      nextErrors.initialPaymentMethod = "Select payment method.";
    }
    if (taxRate.trim()) {
      const rate = Number(taxRate || 0);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        nextErrors.taxRate = "Enter a tax rate between 0 and 100.";
      }
    }
    if (orderNote.trim().length > 2000) {
      toast.error("Order note is too long (max 2000 characters).");
      return;
    }
    const nextPartialErrors: Record<string, string> = {};
    if (deliveryStatus === "PARTIALLY_DELIVERED") {
      let deliveredAny = false;
      let notFullyDeliveredAny = false;
      for (const it of items) {
        const raw = String(partialDeliveredByItem[it.productId] ?? "").trim();
        if (!raw) {
          nextPartialErrors[it.productId] = "Enter delivered qty.";
          continue;
        }
        const delivered = Number(raw);
        if (!Number.isInteger(delivered) || delivered < 0) {
          nextPartialErrors[it.productId] = "Use a whole number (0 or more).";
          continue;
        }
        if (delivered > it.quantity) {
          nextPartialErrors[it.productId] = `Cannot exceed ordered qty (${it.quantity}).`;
          continue;
        }
        if (delivered > 0) deliveredAny = true;
        if (delivered < it.quantity) notFullyDeliveredAny = true;
      }
      if (!deliveredAny) {
        nextErrors.items = "For partial delivery, at least one line must have delivered qty greater than 0.";
      } else if (!notFullyDeliveredAny) {
        nextErrors.items = "All lines are fully delivered. Use Delivery Status = Delivered.";
      }
    }
    setPartialDeliveredErrors(nextPartialErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    if (Object.keys(nextPartialErrors).length > 0) {
      return;
    }
    if (hasStockShortage) {
      toast.error("Cannot create order: one or more items exceed available stock. Resolve shortages first.");
      return;
    }
    if (!confirmed) {
      setConfirmOpen(true);
      return;
    }
    const payload: {
      items: { productId: string; quantity: number; deliveredQuantity?: number }[];
      initialPayment?: number;
      initialPaymentMethod?: "cash" | "momo" | "transfer";
      initialPaymentReference?: string;
      taxRate?: number;
      note?: string;
      deliveryStatus?: typeof deliveryStatus;
      userId?: string;
      customerType?: "REGISTERED";
      sourceTenderId?: string;
      discountAmount?: number;
      discountReason?: string;
    } = {
      items: items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
        ...(deliveryStatus === "PARTIALLY_DELIVERED"
          ? {
              deliveredQuantity: Number(
                String(partialDeliveredByItem[it.productId] ?? "0").trim() || "0",
              ),
            }
          : {}),
      })),
    };
    if (showUpfrontPayment && initPay > 0) {
      payload.initialPayment = initPay;
      payload.initialPaymentMethod = initialPaymentMethod as "cash" | "momo" | "transfer";
      if ((initialPaymentMethod === "momo" || initialPaymentMethod === "transfer") && initialPaymentReference.trim()) {
        payload.initialPaymentReference = initialPaymentReference.trim();
      }
    }
    if (Number.isFinite(taxRateNum) && taxRateNum > 0) payload.taxRate = taxRateNum;
    if (isAdmin && discountNum > 0) {
      payload.discountAmount = discountNum;
      payload.discountReason = discountReason.trim();
    }
    if (orderNote.trim()) payload.note = orderNote.trim();
    if (deliveryStatus && deliveryStatus !== "NOT_SET") payload.deliveryStatus = deliveryStatus;
    const sourceTenderId = tenderDraftMeta?.tenderId || searchParams.get("tenderId") || "";
    if (sourceTenderId) payload.sourceTenderId = sourceTenderId;
    try {
    setSubmitting(true);
    const url = "/api/admin/orders";
    payload.customerType = "REGISTERED";
    payload.userId = userId;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = (j?.details || {}) as {
          fieldErrors?: Record<string, string[]>;
          formErrors?: string[];
        };
        const fieldMsg =
          details?.fieldErrors
            ? Object.values(details.fieldErrors).flat().find(Boolean)
            : undefined;
        const formMsg = details?.formErrors?.find(Boolean);
        toast.error(fieldMsg || formMsg || j?.error || "Failed to create order");
        return;
      }
      toast.success("Order created");
      queryClient.invalidateQueries({ queryKey: ["admin","orders"] });
      setErrors({});
      setPartialDeliveredErrors({});
      setConfirmOpen(false);
      router.push(`/admin/orders/${j.orderId}`);
    } catch {
      toast.error("Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container mx-auto py-8 max-w-5xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Create Order</h1>
          <p className="text-sm text-muted-foreground">
            Build a new order for registered customers and record optional upfront payment.
          </p>
          {loadingB2BDraft ? (
            <p className="text-xs text-muted-foreground mt-1">Loading B2B draft...</p>
          ) : null}
          {backorderDraftMeta ? (
            <div className="mt-2 rounded-md border bg-amber-50 px-3 py-2 text-xs">
              <div>
                Backorder source: Order {backorderDraftMeta.sourceOrderId} ({backorderDraftMeta.customerName})
              </div>
              {backorderDraftMeta.unmatched.length ? (
                <div className="mt-1 text-amber-700">
                  Unmatched lines: {backorderDraftMeta.unmatched.join(" | ")}
                </div>
              ) : null}
            </div>
          ) : null}
          {b2bDraftMeta ? (
            <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div>
                B2B source: Request {b2bDraftMeta.requestId} ({b2bDraftMeta.clinicName}, {b2bDraftMeta.contactName})
              </div>
              {b2bDraftMeta.unmatched.length ? (
                <div className="mt-1 text-amber-700">
                  Unmatched lines: {b2bDraftMeta.unmatched.join(" | ")}
                </div>
              ) : null}
            </div>
          ) : null}
          {tenderDraftMeta ? (
            <div className="rounded border border-sky-300 bg-sky-50 p-2 text-xs text-sky-900">
              <div className="font-medium">
                Tender source: {tenderDraftMeta.tenderNumber} ({tenderDraftMeta.buyerName})
              </div>
              {tenderDraftMeta.unmatched.length ? (
                <div className="mt-1">
                  Unmatched lines: {tenderDraftMeta.unmatched.join(" | ")}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/orders/otc"><Button variant="outline">Go to OTC Quick Sale</Button></Link>
          <Link href="/admin/orders"><Button variant="secondary">Back</Button></Link>
        </div>
      </div>
      <div
        className="sticky z-20 rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ top: "var(--admin-nav-height, 4rem)" }}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {["Customer", "Order Lines", "Payment", "Finalize"].map((step, index) => {
            const done = currentFlowStep > index;
            const active = currentFlowStep === index;
            return (
              <span
                key={step}
                className={`rounded-full border px-2 py-1 ${
                  done
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : active
                      ? "border-sky-500 bg-sky-50 text-sky-700"
                      : "border-muted-foreground/30 text-muted-foreground"
                }`}
              >
                {index + 1}. {step}
              </span>
            );
          })}
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Order Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="space-y-4 lg:col-span-8">
              <section className="rounded-md border p-3 space-y-3">
                <h3 className="text-sm font-semibold">Customer</h3>
                <p className="text-xs text-muted-foreground">
                  Registered customers only. Use OTC for walk-ins.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 lg:gap-4 items-end">
                  <div className="min-w-0">
                    <label className="block text-sm font-medium mb-1">Customer</label>
                    <Select
                      value={userId}
                      onValueChange={(value) => {
                        setUserId(value);
                        if (errors.userId) setErrors((prev) => ({ ...prev, userId: "" }));
                      }}
                    >
                      <SelectTrigger className={errors.userId ? "w-full min-w-0 border-red-500" : "w-full min-w-0"}>
                        <SelectValue placeholder="Select a customer" />
                      </SelectTrigger>
                      <SelectContent>
                        {customerAccounts.map((row) => (
                          <SelectItem key={row.user.id} value={row.user.id}>
                            {row.user.name || row.user.email || row.user.id} {row.user.phone ? `- ${row.user.phone}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.userId && <p className="mt-1 text-xs text-red-600">{errors.userId}</p>}
                  </div>
                </div>
              </section>
              <section className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Order Lines</h3>
                  <span className="text-xs text-muted-foreground">
                    {items.length} item{items.length === 1 ? "" : "s"}
                  </span>
                </div>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="min-w-0 md:col-span-6">
              <label className="block text-sm font-medium mb-1">Product</label>
              <Select
                value={productId}
                onValueChange={(value) => {
                  setProductId(value);
                  if (errors.productId) setErrors((prev) => ({ ...prev, productId: "" }));
                }}
              >
                <SelectTrigger className={errors.productId ? "w-full min-w-0 border-red-500" : "w-full min-w-0"}>
                  <SelectValue placeholder="Select a product" className="truncate" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} - {formatCurrency(Number(p.price))} - Available {getEffectiveAvailable(p)} {p.archived ? "(archived)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.productId && <p className="mt-1 text-xs text-red-600">{errors.productId}</p>}
            </div>
            <div className="min-w-0 md:col-span-3">
              <label className="block text-sm font-medium mb-1">Quantity</label>
              <Input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  if (errors.quantity) setErrors((prev) => ({ ...prev, quantity: "" }));
                }}
                aria-invalid={!!errors.quantity}
                className={errors.quantity ? "border-red-500" : undefined}
              />
              {errors.quantity && <p className="mt-1 text-xs text-red-600">{errors.quantity}</p>}
            </div>
            <div className="md:col-span-3">
              <Button className="w-full" onClick={addItem}>Add Item</Button>
            </div>
          </div>
          {errors.items && <p className="text-xs text-red-600">{errors.items}</p>}
          {stockWarning ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
              <div className="font-medium text-amber-900">
                Split supply suggested for {stockWarning.productName}
              </div>
              <div className="text-xs text-amber-900">
                Requested {stockWarning.requestedQty}, available now {stockWarning.availableQty}, remaining {stockWarning.remainingQty}.
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <Input
                  type="number"
                  min="1"
                  value={restockEtaDays}
                  onChange={(e) => setRestockEtaDays(e.target.value)}
                  placeholder="ETA days for remaining qty"
                />
                <Button className="w-full sm:w-auto" variant="outline" onClick={() => addAvailableFromWarning(false)}>
                  Add Available Now
                </Button>
                <Button className="w-full sm:w-auto" onClick={() => addAvailableFromWarning(true)}>
                  Add Available + Backorder Note
                </Button>
              </div>
            </div>
          ) : null}

          {items.length > 0 && (
            <div className="mt-4">
              {hasStockShortage ? (
                <div className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm space-y-2">
                  <div className="font-medium text-red-900">Stock Shortage Must Be Resolved</div>
                  <div className="text-xs text-red-900">
                    Some order lines exceed available stock. Create Order is blocked until quantities are corrected.
                  </div>
                  <div className="space-y-1 text-xs text-red-900">
                    {stockShortages.map((row) => (
                      <div key={`shortage-${row.productId}`}>
                        {row.name}: requested {row.quantity}, available {row.available}, shortage {row.shortage}
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button className="w-full sm:w-auto" type="button" size="sm" variant="outline" onClick={capAllToAvailable}>
                      Cap All To Available + Add Notes
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="space-y-3 lg:hidden">
                {items.map((it) => (
                  <div key={it.productId} className="rounded-md border p-3 text-sm">
                    <div className="font-medium">{it.name}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <div>
                        <div>Qty</div>
                        <div className="text-foreground">{it.quantity}</div>
                      </div>
                      <div>
                        <div>Price</div>
                        <div className="text-foreground">{formatCurrency(it.price)}</div>
                      </div>
                      <div>
                        <div>Total</div>
                        <div className="text-foreground">{formatCurrency(it.price * it.quantity)}</div>
                      </div>
                    </div>
                    {deliveryStatus === "PARTIALLY_DELIVERED" ? (
                      <div className="mt-3">
                        <label className="text-xs font-medium">
                          Delivered now (0 to {it.quantity})
                        </label>
                        <Input
                          type="number"
                          min="0"
                          max={String(it.quantity)}
                          step="1"
                          value={partialDeliveredByItem[it.productId] ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setPartialDeliveredByItem((prev) => ({ ...prev, [it.productId]: value }));
                            if (partialDeliveredErrors[it.productId]) {
                              setPartialDeliveredErrors((prev) => ({ ...prev, [it.productId]: "" }));
                            }
                            if (errors.items) {
                              setErrors((prev) => ({ ...prev, items: "" }));
                            }
                          }}
                          placeholder={`0 to ${it.quantity}`}
                          aria-invalid={Boolean(partialDeliveredErrors[it.productId])}
                          className={partialDeliveredErrors[it.productId] ? "border-red-500 mt-1 h-8" : "mt-1 h-8"}
                        />
                        {partialDeliveredErrors[it.productId] ? (
                          <p className="text-xs text-red-600 mt-1">{partialDeliveredErrors[it.productId]}</p>
                        ) : null}
                      </div>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() => removeItem(it.productId)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>

              <div className="hidden lg:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2">Item</th>
                      <th className="text-right py-2">Qty</th>
                      <th className="text-right py-2">Price</th>
                      <th className="text-right py-2">Total</th>
                      {deliveryStatus === "PARTIALLY_DELIVERED" ? (
                        <th className="text-right py-2">Delivered Now</th>
                      ) : null}
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.productId} className="border-b last:border-0">
                        <td className="py-2">{it.name}</td>
                        <td className="text-right py-2">{it.quantity}</td>
                        <td className="text-right py-2">{formatCurrency(it.price)}</td>
                        <td className="text-right py-2">{formatCurrency(it.price * it.quantity)}</td>
                        {deliveryStatus === "PARTIALLY_DELIVERED" ? (
                          <td className="py-2 text-right">
                            <div className="ml-auto w-28">
                              <Input
                                type="number"
                                min="0"
                                max={String(it.quantity)}
                                step="1"
                                value={partialDeliveredByItem[it.productId] ?? ""}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  setPartialDeliveredByItem((prev) => ({ ...prev, [it.productId]: value }));
                                  if (partialDeliveredErrors[it.productId]) {
                                    setPartialDeliveredErrors((prev) => ({ ...prev, [it.productId]: "" }));
                                  }
                                  if (errors.items) {
                                    setErrors((prev) => ({ ...prev, items: "" }));
                                  }
                                }}
                                placeholder={`0-${it.quantity}`}
                                aria-invalid={Boolean(partialDeliveredErrors[it.productId])}
                                className={partialDeliveredErrors[it.productId] ? "border-red-500 h-8 text-right" : "h-8 text-right"}
                              />
                              {partialDeliveredErrors[it.productId] ? (
                                <p className="text-[11px] text-red-600 mt-1 text-right">
                                  {partialDeliveredErrors[it.productId]}
                                </p>
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                        <td className="py-2 text-right">
                          <Button variant="outline" size="sm" onClick={() => removeItem(it.productId)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

            </div>
          )}
              </section>
              <section className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Payment & Pricing</h3>
                  <span className="text-xs text-muted-foreground">
                    Configure optional upfront payment after adding products.
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 items-end">
                  <div className="min-w-0">
                    <label className="block text-sm font-medium mb-1">Upfront Payment</label>
                    <Button
                      type="button"
                      variant={showUpfrontPayment ? "secondary" : "outline"}
                      className="w-full px-4 py-2.5"
                      onClick={() => {
                        const next = !showUpfrontPayment;
                        setShowUpfrontPayment(next);
                        if (!next) {
                          setInitialPayment("");
                          setInitialPaymentMethod("");
                          setInitialPaymentReference("");
                          setErrors((prev) => ({
                            ...prev,
                            initialPayment: "",
                            initialPaymentMethod: "",
                            initialPaymentReference: "",
                          }));
                        }
                      }}
                    >
                      {showUpfrontPayment ? "Payment Enabled" : "Enable Payment"}
                    </Button>
                  </div>
                  {showUpfrontPayment ? (
                    <>
                      <div className="min-w-0">
                        <label className="block text-sm font-medium mb-1">Initial Payment</label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={initialPayment}
                          onChange={(e) => {
                            setInitialPayment(e.target.value);
                            if (errors.initialPayment || errors.initialPaymentMethod || errors.initialPaymentReference) {
                              setErrors((prev) => ({
                                ...prev,
                                initialPayment: "",
                                initialPaymentMethod: "",
                                initialPaymentReference: "",
                              }));
                            }
                          }}
                          aria-invalid={!!errors.initialPayment}
                          className={errors.initialPayment ? "border-red-500" : undefined}
                        />
                        {errors.initialPayment && <p className="mt-1 text-xs text-red-600">{errors.initialPayment}</p>}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => {
                            setInitialPayment(total > 0 ? total.toFixed(2) : "");
                            if (errors.initialPayment) {
                              setErrors((prev) => ({ ...prev, initialPayment: "" }));
                            }
                          }}
                        >
                          Set Full Payment
                        </Button>
                      </div>
                      <div className="min-w-0">
                        <label className="block text-sm font-medium mb-1">Payment Method</label>
                        <Select
                          value={initialPaymentMethod}
                          onValueChange={(value) => {
                            const next = value as "" | "cash" | "momo" | "transfer";
                            setInitialPaymentMethod(next);
                            if (errors.initialPaymentMethod) {
                              setErrors((prev) => ({ ...prev, initialPaymentMethod: "" }));
                            }
                            if (next !== "momo" && next !== "transfer") {
                              setInitialPaymentReference("");
                              if (errors.initialPaymentReference) {
                                setErrors((prev) => ({ ...prev, initialPaymentReference: "" }));
                              }
                            }
                          }}
                        >
                          <SelectTrigger
                            className={
                              errors.initialPaymentMethod
                                ? "w-full min-w-0 border-red-500"
                                : "w-full min-w-0"
                            }
                          >
                            <SelectValue placeholder="Select method" />
                          </SelectTrigger>
                          <SelectContent className="z-[100]">
                            <SelectItem value="cash">Cash</SelectItem>
                            <SelectItem value="momo">MoMo</SelectItem>
                            <SelectItem value="transfer">Transfer</SelectItem>
                          </SelectContent>
                        </Select>
                        {errors.initialPaymentMethod ? (
                          <p className="mt-1 text-xs text-red-600">{errors.initialPaymentMethod}</p>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                  <div className="min-w-0">
                    <label className="block text-sm font-medium mb-1">Tax % (optional)</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={taxRate}
                      onChange={(e) => {
                        setTaxRate(e.target.value);
                        if (errors.taxRate) setErrors((prev) => ({ ...prev, taxRate: "" }));
                      }}
                      placeholder="0"
                      aria-invalid={!!errors.taxRate}
                      className={errors.taxRate ? "border-red-500" : undefined}
                    />
                    {errors.taxRate && <p className="mt-1 text-xs text-red-600">{errors.taxRate}</p>}
                  </div>
                  {showUpfrontPayment && (initialPaymentMethod === "momo" || initialPaymentMethod === "transfer") ? (
                    <div className="md:col-span-2 lg:col-span-4">
                      <label className="block text-sm font-medium mb-1">Payment Reference</label>
                      <Input
                        value={initialPaymentReference}
                        onChange={(e) => {
                          setInitialPaymentReference(e.target.value);
                          if (errors.initialPaymentReference) {
                            setErrors((prev) => ({ ...prev, initialPaymentReference: "" }));
                          }
                        }}
                        placeholder={initialPaymentMethod === "transfer" ? "e.g., bank transfer reference" : "e.g., MoMo transaction ID"}
                        aria-invalid={!!errors.initialPaymentReference}
                        className={errors.initialPaymentReference ? "border-red-500" : undefined}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Required when initial payment is entered.
                      </p>
                      {errors.initialPaymentReference ? (
                        <p className="mt-1 text-xs text-red-600">{errors.initialPaymentReference}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {isAdmin ? (
                    <>
                      <div className="min-w-0">
                        <label className="block text-sm font-medium mb-1">Discount Amount (admin)</label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={discountAmount}
                          onChange={(e) => {
                            setDiscountAmount(e.target.value);
                            if (errors.discountAmount || errors.discountReason) {
                              setErrors((prev) => ({ ...prev, discountAmount: "", discountReason: "" }));
                            }
                          }}
                          placeholder="0.00"
                          aria-invalid={!!errors.discountAmount}
                          className={errors.discountAmount ? "border-red-500" : undefined}
                        />
                        {errors.discountAmount ? (
                          <p className="mt-1 text-xs text-red-600">{errors.discountAmount}</p>
                        ) : null}
                      </div>
                      <div className="min-w-0 lg:col-span-2">
                        <label className="block text-sm font-medium mb-1">
                          Discount Reason {Number(discountAmount || 0) > 0 ? "*" : "(optional)"}
                        </label>
                        <Input
                          value={discountReason}
                          onChange={(e) => {
                            setDiscountReason(e.target.value);
                            if (errors.discountReason) {
                              setErrors((prev) => ({ ...prev, discountReason: "" }));
                            }
                          }}
                          placeholder="Required when discount is entered"
                          aria-invalid={!!errors.discountReason}
                          className={errors.discountReason ? "border-red-500" : undefined}
                        />
                        {errors.discountReason ? (
                          <p className="mt-1 text-xs text-red-600">{errors.discountReason}</p>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
              </section>
            </div>

            <aside className="space-y-4 lg:col-span-4">
              <section className="rounded-md border p-3 space-y-3 lg:sticky lg:top-24">
                <h3 className="text-sm font-semibold">Finalize Order</h3>
                <div className="rounded bg-muted/40 p-3 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span>Subtotal</span>
                    <span>{formatCurrency(subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tax</span>
                    <span>{formatCurrency(taxAmount)}</span>
                  </div>
                  {discountNum > 0 ? (
                    <div className="flex justify-between text-amber-700">
                      <span>Discount</span>
                      <span>-{formatCurrency(discountNum)}</span>
                    </div>
                  ) : null}
                  <div className="flex justify-between border-t pt-1 mt-1 font-semibold">
                    <span>Total</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Delivery Status</label>
                    <Select
                      value={deliveryStatus}
                      onValueChange={(
                        v:
                          | "NOT_SET"
                          | "NOT_DELIVERED"
                          | "PARTIALLY_DELIVERED"
                          | "DELIVERED"
                          | "RETURNED",
                      ) => {
                        setDeliveryStatus(v);
                        if (v !== "PARTIALLY_DELIVERED") {
                          setPartialDeliveredErrors({});
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Default: Not Delivered" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NOT_SET">Not set</SelectItem>
                        <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
                        <SelectItem value="PARTIALLY_DELIVERED">Partially Delivered</SelectItem>
                        <SelectItem value="DELIVERED">Delivered</SelectItem>
                        <SelectItem value="RETURNED">Returned</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Keep adding items on the left. Order is created only when you click Create Order.
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Order / Supply Note (optional)</label>
                  <Input
                    value={orderNote}
                    onChange={(e) => setOrderNote(e.target.value)}
                    placeholder="e.g., IV cannula: 80 supplied now, 120 pending, ETA 7 days"
                  />
                </div>

                <Button
                  className="w-full"
                  onClick={() => {
                    void submit(false);
                  }}
                  disabled={hasStockShortage || submitting}
                >
                  {submitting ? "Creating..." : "Create Order"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {lastValidationAt
                    ? `Last validation check: ${lastValidationAt.toLocaleTimeString()}`
                    : "Validation check will appear after first submit attempt."}
                </p>
              </section>
            </aside>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle>Confirm Order Creation</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded border bg-muted/30 p-3 space-y-1">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Customer</span>
                <span className="font-medium">
                  {selectedCustomer?.name || selectedCustomer?.email || "—"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Items</span>
                <span className="font-medium">
                  {items.length} line{items.length === 1 ? "" : "s"} /{" "}
                  {items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)} qty
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Delivery</span>
                <span className="font-medium">{deliveryStatus === "NOT_SET" ? "Not set" : deliveryStatus}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Payment</span>
                <span className="font-medium">
                  {showUpfrontPayment && Number(initialPayment || 0) > 0
                    ? `${initialPaymentMethod || "—"} / ${formatCurrency(Number(initialPayment || 0))}`
                    : "No upfront payment"}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Tax</span>
                <span>{formatCurrency(taxAmount)}</span>
              </div>
              {discountNum > 0 ? (
                <div className="flex justify-between gap-2 text-amber-700">
                  <span>Discount</span>
                  <span>-{formatCurrency(discountNum)}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-2 border-t pt-1 font-semibold">
                <span>Total</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  void submit(true);
                }}
                disabled={submitting}
              >
                {submitting ? "Creating..." : "Confirm & Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
