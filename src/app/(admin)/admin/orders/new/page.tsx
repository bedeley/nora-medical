"use client";

export const dynamic = "force-dynamic";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

const CUSTOMER_PAGE_SIZE = 50;
const PRODUCT_PAGE_SIZE = 100;
const ORDER_DRAFT_KEY = "admin-order-new-draft.v2";
const DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

type CustomerRow = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone?: string | null;
    role?: string | null;
  };
  lastOrderAt?: string | null;
  storeCredit?: number;
  creditLimit?: number;
};

type CustomersResponse = {
  rows: CustomerRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
};

type ProductRow = {
  id: string;
  sku?: string | null;
  name: string;
  price: number | string;
  stock?: number;
  sellableStock?: number | null;
  archived?: boolean;
};

type ProductsResponse = {
  items: ProductRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
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

type OrderLine = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
};

type ImportContext = {
  tone: "amber" | "slate" | "sky";
  title: string;
  detail: string;
  sourceLabel: string;
};

type ImportReviewLine = {
  id: string;
  raw: string;
  itemRef: string;
  quantity: number;
  productId: string | null;
  sourceLabel: string;
  hint: string;
  status: "pending" | "matched" | "noted" | "dismissed";
};

type StockWarningState = {
  productId: string;
  productName: string;
  requestedQty: number;
  currentQtyInCart: number;
  addableQtyNow: number;
  remainingQty: number;
};

type OrderDraftSnapshot = {
  ts: number;
  userId: string;
  items: OrderLine[];
  partialDeliveredByItem: Record<string, string>;
  initialPayment: string;
  initialPaymentMethod: "" | "cash" | "momo" | "transfer";
  initialPaymentReference: string;
  showUpfrontPayment: boolean;
  taxRate: string;
  discountAmount: string;
  discountReason: string;
  deliveryStatus: "NOT_SET" | "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED";
  orderNote: string;
  importContext: ImportContext | null;
  importReviewLines: ImportReviewLine[];
  pendingImportMatchId: string | null;
};

function mergeUniqueByKey<T>(current: T[], incoming: T[], getKey: (value: T) => string) {
  const map = new Map(current.map((value) => [getKey(value), value]));
  for (const value of incoming) {
    map.set(getKey(value), value);
  }
  return Array.from(map.values());
}

async function fetchJsonOrThrow<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body?.error || "Request failed");
  }
  return body as T;
}

function getCustomerLabel(customer: CustomerRow["user"] | null | undefined) {
  if (!customer) return "No customer selected";
  return customer.name || customer.email || customer.phone || customer.id;
}

function getDeliveryLabel(
  deliveryStatus: "NOT_SET" | "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED",
) {
  if (deliveryStatus === "NOT_SET") return "Not set (defaults to Not Delivered)";
  if (deliveryStatus === "NOT_DELIVERED") return "Not Delivered";
  if (deliveryStatus === "PARTIALLY_DELIVERED") return "Partially Delivered";
  if (deliveryStatus === "DELIVERED") return "Delivered";
  if (deliveryStatus === "RETURNED") return "Returned";
  return deliveryStatus;
}

function isTypingElement(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
}

export default function NewAdminOrderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const isAdmin = String((session?.user as { role?: string } | undefined)?.role || "").toUpperCase() === "ADMIN";

  const backorderOrderId = searchParams.get("backorderOrderId") || "";
  const tenderId = searchParams.get("tenderId") || "";
  const b2bRequestId = searchParams.get("b2bRequestId") || "";
  const hasImportedSource = Boolean(backorderOrderId || tenderId || b2bRequestId);

  const [customerTotal, setCustomerTotal] = useState(0);
  const [knownCustomers, setKnownCustomers] = useState<CustomerRow[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [customerReloadKey, setCustomerReloadKey] = useState(0);

  const [productTotal, setProductTotal] = useState(0);
  const [knownProducts, setKnownProducts] = useState<ProductRow[]>([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState("");
  const [productReloadKey, setProductReloadKey] = useState(0);

  const [userId, setUserId] = useState("");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [items, setItems] = useState<OrderLine[]>([]);
  const [partialDeliveredByItem, setPartialDeliveredByItem] = useState<Record<string, string>>({});
  const [partialDeliveredErrors, setPartialDeliveredErrors] = useState<Record<string, string>>({});
  const [initialPayment, setInitialPayment] = useState("");
  const [initialPaymentMethod, setInitialPaymentMethod] = useState<"" | "cash" | "momo" | "transfer">("");
  const [initialPaymentReference, setInitialPaymentReference] = useState("");
  const [showUpfrontPayment, setShowUpfrontPayment] = useState(false);
  const [taxRate, setTaxRate] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountReason, setDiscountReason] = useState("");
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
  const [stockWarning, setStockWarning] = useState<StockWarningState | null>(null);
  const [restockEtaDays, setRestockEtaDays] = useState("");
  const [loadingImport, setLoadingImport] = useState(false);
  const [importContext, setImportContext] = useState<ImportContext | null>(null);
  const [importReviewLines, setImportReviewLines] = useState<ImportReviewLine[]>([]);
  const [pendingImportMatchId, setPendingImportMatchId] = useState<string | null>(null);
  const [pendingDraft, setPendingDraft] = useState<OrderDraftSnapshot | null>(null);
  const [draftAvailableAt, setDraftAvailableAt] = useState<number | null>(null);

  const customerMap = useMemo(
    () => new Map(knownCustomers.map((row) => [row.user.id, row])),
    [knownCustomers],
  );
  const productMap = useMemo(() => new Map(knownProducts.map((row) => [row.id, row])), [knownProducts]);

  const selectedCustomer = userId ? customerMap.get(userId)?.user || null : null;
  const selectedProduct = productId ? productMap.get(productId) || null : null;

  const getEffectiveAvailable = (product?: ProductRow | null) => {
    if (!product) return 0;
    const rawValue =
      typeof product.sellableStock === "number" ? product.sellableStock : Number(product.stock ?? 0);
    return Math.max(0, Math.floor(Number(rawValue || 0)));
  };

  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );
  const taxRateNum = Number(taxRate || 0);
  const taxAmount =
    Number.isFinite(taxRateNum) && taxRateNum > 0 ? subtotal * (taxRateNum / 100) : 0;
  const grossTotal = subtotal + taxAmount;
  const rawDiscount = Number(discountAmount || 0);
  const discountNum =
    isAdmin && Number.isFinite(rawDiscount) ? Math.max(0, Math.min(rawDiscount, grossTotal)) : 0;
  const total = Math.max(0, grossTotal - discountNum);

  const stockShortages = useMemo(() => {
    return items
      .map((item) => {
        const product = productMap.get(item.productId);
        const available = getEffectiveAvailable(product);
        const shortage = Math.max(0, item.quantity - available);
        return { ...item, available, shortage };
      })
      .filter((item) => item.shortage > 0);
  }, [items, productMap]);
  const hasStockShortage = stockShortages.length > 0;

  const pendingImportLines = useMemo(
    () => importReviewLines.filter((line) => line.status === "pending"),
    [importReviewLines],
  );
  const activeImportMatch = useMemo(
    () =>
      importReviewLines.find((line) => line.id === pendingImportMatchId && line.status === "pending") || null,
    [importReviewLines, pendingImportMatchId],
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
          deliveryStatus !== "NOT_SET" ||
          pendingImportLines.length > 0,
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
      pendingImportLines.length,
    ],
  );

  const currentFlowStep = useMemo(() => {
    if (!userId) return 0;
    if (items.length === 0) return 1;
    if (showUpfrontPayment && (!Number(initialPayment || 0) || !initialPaymentMethod)) return 2;
    return 3;
  }, [initialPayment, initialPaymentMethod, items.length, showUpfrontPayment, userId]);

  const addItemRef = useRef<() => void>(() => undefined);
  const submitRef = useRef<(confirmed?: boolean) => Promise<void>>(async () => undefined);

  function clearPendingImportMatch() {
    setPendingImportMatchId(null);
  }

  function updateImportLineStatus(id: string, status: ImportReviewLine["status"]) {
    setImportReviewLines((prev) => prev.map((line) => (line.id === id ? { ...line, status } : line)));
    if (pendingImportMatchId === id && status !== "pending") {
      setPendingImportMatchId(null);
    }
  }

  function appendImportLineToNote(line: ImportReviewLine) {
    const noteLine = `Imported line pending review: ${line.itemRef} x${line.quantity}.`;
    setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${noteLine}` : noteLine));
    updateImportLineStatus(line.id, "noted");
    toast.success("Imported line added to order note.");
  }

  async function resolveImportedLines(lines: DraftLine[], sourceLabel: string) {
    const requestedIds = Array.from(
      new Set(lines.map((line) => line.productId).filter((value): value is string => Boolean(value))),
    );
    const exactProducts =
      requestedIds.length > 0
        ? await fetchJsonOrThrow<ProductsResponse>(
            `/api/products?ids=${encodeURIComponent(requestedIds.join(","))}&includeArchived=1&includeSellableStock=1`,
          )
        : { items: [] };
    if (exactProducts.items.length) {
      setKnownProducts((prev) => mergeUniqueByKey(prev, exactProducts.items, (row) => row.id));
    }
    const exactProductMap = new Map(exactProducts.items.map((row) => [row.id, row]));
    const matchedMap = new Map<string, OrderLine>();
    const issues: ImportReviewLine[] = [];

    for (const line of lines) {
      const label = line.productName || line.itemRef || line.raw || "Imported line";
      if (line.productId) {
        const product = exactProductMap.get(line.productId);
        if (product && !product.archived) {
          const existing = matchedMap.get(product.id);
          matchedMap.set(product.id, {
            productId: product.id,
            name: product.name,
            price: Number(product.price || 0),
            quantity: Number(existing?.quantity || 0) + Number(line.quantity || 0),
          });
          continue;
        }
      }

      issues.push({
        id: `${sourceLabel}-${line.productId || label}-${line.quantity}-${issues.length}`,
        raw: line.raw || label,
        itemRef: label,
        quantity: line.quantity,
        productId: line.productId,
        sourceLabel,
        hint: line.productId
          ? "The referenced product could not be loaded as an active sellable item."
          : "No product match was carried into the draft.",
        status: "pending",
      });
    }

    return {
      matchedItems: Array.from(matchedMap.values()),
      issues,
    };
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        setCustomerLoading(true);
        setCustomerError("");
        let page = 1;
        let allRows: CustomerRow[] = [];
        while (!cancelled) {
          const params = new URLSearchParams({
            roles: "CUSTOMER",
            page: String(page),
            pageSize: String(CUSTOMER_PAGE_SIZE),
          });
          const data = await fetchJsonOrThrow<CustomersResponse>(
            `/api/admin/customers?${params.toString()}`,
            { signal: controller.signal },
          );
          const rows = data.rows || [];
          allRows = mergeUniqueByKey(allRows, rows, (row) => row.user.id);
          const total = Number(data.total || allRows.length || 0);
          if (!rows.length || allRows.length >= total || rows.length < CUSTOMER_PAGE_SIZE) {
            if (!cancelled) {
              setKnownCustomers(allRows);
              setCustomerTotal(total || allRows.length);
            }
            break;
          }
          page += 1;
        }
      } catch (error) {
        if ((error as Error).name === "AbortError" || cancelled) return;
        setCustomerError((error as Error).message || "Failed to load customers.");
        setKnownCustomers([]);
        setCustomerTotal(0);
      } finally {
        if (!cancelled) setCustomerLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [customerReloadKey]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        setProductLoading(true);
        setProductError("");
        let page = 1;
        let allItems: ProductRow[] = [];
        while (!cancelled) {
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(PRODUCT_PAGE_SIZE),
            includeSellableStock: "1",
          });
          const data = await fetchJsonOrThrow<ProductsResponse>(
            `/api/products?${params.toString()}`,
            { signal: controller.signal },
          );
          const rows = data.items || [];
          allItems = mergeUniqueByKey(allItems, rows, (row) => row.id);
          const total = Number(data.total || allItems.length || 0);
          if (!rows.length || allItems.length >= total || rows.length < PRODUCT_PAGE_SIZE) {
            if (!cancelled) {
              setKnownProducts((prev) => mergeUniqueByKey(prev, allItems, (row) => row.id));
              setProductTotal(total || allItems.length);
            }
            break;
          }
          page += 1;
        }
      } catch (error) {
        if ((error as Error).name === "AbortError" || cancelled) return;
        setProductError((error as Error).message || "Failed to load products.");
        setProductTotal(0);
      } finally {
        if (!cancelled) setProductLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [productReloadKey]);

  useEffect(() => {
    if (!userId || customerMap.has(userId)) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchJsonOrThrow<CustomersResponse>(
          `/api/admin/customers?ids=${encodeURIComponent(userId)}&roles=CUSTOMER`,
        );
        if (cancelled) return;
        if (data.rows?.length) {
          setKnownCustomers((prev) => mergeUniqueByKey(prev, data.rows, (row) => row.user.id));
        }
      } catch {
        // Best-effort hydration only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerMap, userId]);

  useEffect(() => {
    const missingIds = Array.from(
      new Set(items.map((item) => item.productId).filter((id) => !productMap.has(id))),
    );
    if (!missingIds.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchJsonOrThrow<ProductsResponse>(
          `/api/products?ids=${encodeURIComponent(missingIds.join(","))}&includeArchived=1&includeSellableStock=1`,
        );
        if (cancelled) return;
        if (data.items?.length) {
          setKnownProducts((prev) => mergeUniqueByKey(prev, data.items, (row) => row.id));
        }
      } catch {
        // Best-effort hydration only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, productMap]);

  useEffect(() => {
    if (typeof window === "undefined" || hasImportedSource) return;
    try {
      const raw = window.localStorage.getItem(ORDER_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OrderDraftSnapshot;
      const ageMs = Date.now() - Number(parsed?.ts || 0);
      if (!parsed?.ts || ageMs > DRAFT_MAX_AGE_MS) {
        window.localStorage.removeItem(ORDER_DRAFT_KEY);
        return;
      }
      setPendingDraft(parsed);
      setDraftAvailableAt(parsed.ts);
    } catch {
      window.localStorage.removeItem(ORDER_DRAFT_KEY);
    }
  }, [hasImportedSource]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: OrderDraftSnapshot = {
      ts: Date.now(),
      userId,
      items,
      partialDeliveredByItem,
      initialPayment,
      initialPaymentMethod,
      initialPaymentReference,
      showUpfrontPayment,
      taxRate,
      discountAmount,
      discountReason,
      deliveryStatus,
      orderNote,
      importContext,
      importReviewLines,
      pendingImportMatchId,
    };
    const hasContent =
      userId ||
      items.length > 0 ||
      initialPayment.trim() ||
      initialPaymentReference.trim() ||
      taxRate.trim() ||
      discountAmount.trim() ||
      discountReason.trim() ||
      orderNote.trim() ||
      deliveryStatus !== "NOT_SET" ||
      pendingImportLines.length > 0;
    if (!hasContent && pendingDraft) {
      return;
    }
    if (hasContent) {
      window.localStorage.setItem(ORDER_DRAFT_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(ORDER_DRAFT_KEY);
    }
  }, [
    deliveryStatus,
    discountAmount,
    discountReason,
    importContext,
    importReviewLines,
    initialPayment,
    initialPaymentMethod,
    initialPaymentReference,
    items,
    orderNote,
    partialDeliveredByItem,
    pendingDraft,
    pendingImportLines.length,
    pendingImportMatchId,
    showUpfrontPayment,
    taxRate,
    userId,
  ]);

  useEffect(() => {
    if (!backorderOrderId) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoadingImport(true);
        const response = await fetch(`/api/admin/orders/${backorderOrderId}/backorder-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          draft?: BackorderDraft;
        };
        const draft = body.draft;
        if (!response.ok || !draft) {
          throw new Error(body?.error || "Failed to load backorder fulfillment draft");
        }
        const resolved = await resolveImportedLines(draft.lines, "Backorder");
        if (cancelled) return;
        setUserId(draft.customerId);
        setItems(resolved.matchedItems);
        setImportContext({
          tone: "amber",
          title: `Backorder source: Order ${draft.sourceOrderId}`,
          detail: draft.customerName,
          sourceLabel: "Backorder",
        });
        setImportReviewLines(resolved.issues);
        setPendingImportMatchId(resolved.issues[0]?.id || null);
        setOrderNote((prev) =>
          draft.note?.trim()
            ? prev.trim()
              ? `${prev.trim()}\n${draft.note.trim()}`
              : draft.note.trim()
            : prev
        );
        toast.success("Backorder fulfillment draft loaded.");
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message || "Failed to load backorder fulfillment draft");
        }
      } finally {
        if (!cancelled) setLoadingImport(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backorderOrderId]);

  useEffect(() => {
    if (!tenderId) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoadingImport(true);
        const response = await fetch(`/api/admin/b2b/tenders/${tenderId}/draft-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          draft?: TenderOrderDraft;
        };
        const draft = body.draft;
        if (!response.ok || !draft) {
          throw new Error(body?.error || "Failed to load tender order draft");
        }
        const resolved = await resolveImportedLines(draft.lines, "Tender");
        if (cancelled) return;
        setUserId(draft.customerId || "");
        setItems(resolved.matchedItems);
        setImportContext({
          tone: "sky",
          title: `Tender source: ${draft.tenderNumber}`,
          detail: draft.buyerName,
          sourceLabel: "Tender",
        });
        setImportReviewLines(resolved.issues);
        setPendingImportMatchId(resolved.issues[0]?.id || null);
        setOrderNote((prev) =>
          draft.notes?.trim()
            ? prev.trim()
              ? `${prev.trim()}\n${draft.notes.trim()}`
              : draft.notes.trim()
            : prev
        );
        toast.success("Tender draft loaded into order form.");
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message || "Failed to load tender order draft");
        }
      } finally {
        if (!cancelled) setLoadingImport(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenderId]);

  useEffect(() => {
    if (!b2bRequestId) return;
    let cancelled = false;
    void (async () => {
      try {
        setLoadingImport(true);
        const response = await fetch(`/api/admin/b2b/procurement/requests/${b2bRequestId}/draft-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          draft?: B2BDraft;
        };
        const draft = body.draft;
        if (!response.ok || !draft) {
          throw new Error(body?.error || "Failed to load B2B draft");
        }
        const resolved = await resolveImportedLines(draft.lines, "B2B request");
        if (cancelled) return;
        setUserId(draft.customerId);
        setItems(resolved.matchedItems);
        setImportContext({
          tone: "slate",
          title: `B2B source: Request ${draft.requestId}`,
          detail: `${draft.clinicName}, ${draft.contactName}`,
          sourceLabel: "B2B request",
        });
        setImportReviewLines(resolved.issues);
        setPendingImportMatchId(resolved.issues[0]?.id || null);
        toast.success("B2B request draft loaded into order form.");
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message || "Failed to load B2B draft");
        }
      } finally {
        if (!cancelled) setLoadingImport(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [b2bRequestId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges || submitting) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedChanges, submitting]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || isTypingElement(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        addItemRef.current();
      }
      if (key === "s") {
        event.preventDefault();
        void submitRef.current(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function restoreDraft() {
    if (!pendingDraft) return;
    setUserId(pendingDraft.userId || "");
    setItems(pendingDraft.items || []);
    setPartialDeliveredByItem(pendingDraft.partialDeliveredByItem || {});
    setInitialPayment(pendingDraft.initialPayment || "");
    setInitialPaymentMethod(pendingDraft.initialPaymentMethod || "");
    setInitialPaymentReference(pendingDraft.initialPaymentReference || "");
    setShowUpfrontPayment(Boolean(pendingDraft.showUpfrontPayment));
    setTaxRate(pendingDraft.taxRate || "");
    setDiscountAmount(pendingDraft.discountAmount || "");
    setDiscountReason(pendingDraft.discountReason || "");
    setDeliveryStatus(pendingDraft.deliveryStatus || "NOT_SET");
    setOrderNote(pendingDraft.orderNote || "");
    setImportContext(pendingDraft.importContext || null);
    setImportReviewLines(pendingDraft.importReviewLines || []);
    setPendingImportMatchId(pendingDraft.pendingImportMatchId || null);
    setPendingDraft(null);
    toast.success("Saved draft restored.");
  }

  function discardDraft() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(ORDER_DRAFT_KEY);
    }
    setPendingDraft(null);
    setDraftAvailableAt(null);
  }

  function updateItemQuantity(productIdToUpdate: string, rawValue: string) {
    const nextQuantity = Number(rawValue || 0);
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) return;
    const safeQuantity = Math.max(1, Math.floor(nextQuantity));
    setItems((prev) =>
      prev.map((item) => (item.productId === productIdToUpdate ? { ...item, quantity: safeQuantity } : item)),
    );
    setErrors((prev) => ({ ...prev, items: "" }));
    const delivered = Number(partialDeliveredByItem[productIdToUpdate] || 0);
    if (Number.isFinite(delivered) && delivered > safeQuantity) {
      setPartialDeliveredByItem((prev) => ({ ...prev, [productIdToUpdate]: String(safeQuantity) }));
    }
  }

  function removeItem(productIdToRemove: string) {
    setItems((prev) => prev.filter((item) => item.productId !== productIdToRemove));
    setPartialDeliveredByItem((prev) => {
      const next = { ...prev };
      delete next[productIdToRemove];
      return next;
    });
    setPartialDeliveredErrors((prev) => {
      const next = { ...prev };
      delete next[productIdToRemove];
      return next;
    });
  }

  function capAllToAvailable() {
    if (!stockShortages.length) return;
    const pendingNotes: string[] = [];
    const shortageById = new Map(stockShortages.map((row) => [row.productId, row]));
    const nextItems = items
      .map((item) => {
        const shortage = shortageById.get(item.productId);
        if (!shortage) return item;
        if (shortage.available <= 0) {
          pendingNotes.push(
            `Backorder pending: ${shortage.name} requested ${shortage.quantity}, supplying 0 now, remaining ${shortage.quantity}.`,
          );
          return null;
        }
        pendingNotes.push(
          `Backorder pending: ${shortage.name} requested ${shortage.quantity}, supplying ${shortage.available} now, remaining ${shortage.shortage}.`,
        );
        return { ...item, quantity: shortage.available };
      })
      .filter((item): item is OrderLine => Boolean(item));
    setItems(nextItems);
    if (pendingNotes.length) {
      setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${pendingNotes.join("\n")}` : pendingNotes.join("\n")));
    }
    toast.success("Adjusted item quantities to available stock and added pending supply notes.");
  }

  function addAvailableFromWarning(includeBackorderNote: boolean) {
    if (!stockWarning) return;
    if (stockWarning.addableQtyNow <= 0) {
      toast.error("No stock is available to add now.");
      return;
    }
    setItems((prev) => {
      const product = productMap.get(stockWarning.productId);
      const existing = prev.find((item) => item.productId === stockWarning.productId);
      if (existing) {
        return prev.map((item) =>
          item.productId === stockWarning.productId
            ? { ...item, quantity: item.quantity + stockWarning.addableQtyNow }
            : item,
        );
      }
      return [
        ...prev,
        {
          productId: stockWarning.productId,
          name: stockWarning.productName,
          price: Number(product?.price || 0),
          quantity: stockWarning.addableQtyNow,
        },
      ];
    });
    if (includeBackorderNote) {
      const eta = Number(restockEtaDays || 0);
      const etaPart = Number.isFinite(eta) && eta > 0 ? ` ETA ${eta} day(s).` : "";
      const noteLine = `Backorder pending: ${stockWarning.productName} requested additional ${stockWarning.requestedQty}, supplying ${stockWarning.addableQtyNow} now, remaining ${stockWarning.remainingQty}.${etaPart}`;
      setOrderNote((prev) => (prev.trim() ? `${prev.trim()}\n${noteLine}` : noteLine));
    }
    if (activeImportMatch) {
      updateImportLineStatus(activeImportMatch.id, includeBackorderNote ? "noted" : "matched");
    }
    setQuantity(String(stockWarning.remainingQty || 1));
    setRestockEtaDays("");
    setStockWarning(null);
    setErrors((prev) => ({ ...prev, quantity: "" }));
    toast.success(`Added ${stockWarning.addableQtyNow} now for ${stockWarning.productName}.`);
  }

  function addItem() {
    if (!selectedProduct || selectedProduct.archived) {
      setErrors((prev) => ({ ...prev, productId: "Select an active product." }));
      return;
    }
    const requestedQty = activeImportMatch ? activeImportMatch.quantity : Math.max(1, Number(quantity || 1));
    if (Number.isNaN(requestedQty) || requestedQty <= 0) {
      setErrors((prev) => ({ ...prev, quantity: "Quantity must be at least 1." }));
      return;
    }
    const existingQty = items.find((item) => item.productId === selectedProduct.id)?.quantity || 0;
    const safeAvailable = getEffectiveAvailable(selectedProduct);
    const addableQtyNow = Math.max(0, safeAvailable - existingQty);
    if (requestedQty > addableQtyNow) {
      setStockWarning({
        productId: selectedProduct.id,
        productName: selectedProduct.name,
        requestedQty,
        currentQtyInCart: existingQty,
        addableQtyNow,
        remainingQty: Math.max(0, requestedQty - addableQtyNow),
      });
      setErrors((prev) => ({
        ...prev,
        quantity:
          addableQtyNow <= 0
            ? `${selectedProduct.name} has no remaining available stock for this order.`
            : `Only ${addableQtyNow} more can be added now for ${selectedProduct.name}. Use split supply below.`,
      }));
      return;
    }
    setItems((prev) => {
      const existing = prev.find((item) => item.productId === selectedProduct.id);
      if (existing) {
        return prev.map((item) =>
          item.productId === selectedProduct.id
            ? { ...item, quantity: item.quantity + requestedQty }
            : item,
        );
      }
      return [
        ...prev,
        {
          productId: selectedProduct.id,
          name: selectedProduct.name,
          price: Number(selectedProduct.price || 0),
          quantity: requestedQty,
        },
      ];
    });
    if (activeImportMatch) {
      updateImportLineStatus(activeImportMatch.id, "matched");
      setPendingImportMatchId(null);
    }
    setProductId("");
    setQuantity("1");
    setRestockEtaDays("");
    setStockWarning(null);
    setErrors((prev) => ({ ...prev, productId: "", quantity: "", items: "" }));
  }

  addItemRef.current = addItem;

  async function submit(confirmed = false) {
    if (submitting) return;
    setLastValidationAt(new Date());
    const nextErrors: typeof errors = {};
    if (!userId) nextErrors.userId = "Select a customer.";
    if (items.length === 0) nextErrors.items = "Add at least one item.";

    const initPay = Number(initialPayment || 0);
    const hasInitialPaymentInput = initialPayment.trim().length > 0;
    if (showUpfrontPayment && hasInitialPaymentInput && (!Number.isFinite(initPay) || initPay < 0)) {
      nextErrors.initialPayment = "Enter a valid initial payment.";
    } else if (showUpfrontPayment && Number.isFinite(initPay) && initPay > total) {
      nextErrors.initialPayment = "Initial payment cannot exceed the order total.";
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
    if (isAdmin && discountAmount.trim()) {
      const discountValue = Number(discountAmount || 0);
      if (!Number.isFinite(discountValue) || discountValue < 0) {
        nextErrors.discountAmount = "Enter a valid discount amount.";
      } else if (discountValue > grossTotal) {
        nextErrors.discountAmount = "Discount cannot exceed subtotal + tax.";
      } else if (discountValue > 0 && !discountReason.trim()) {
        nextErrors.discountReason = "Discount reason is required.";
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
      for (const item of items) {
        const rawValue = String(partialDeliveredByItem[item.productId] ?? "").trim();
        if (!rawValue) {
          nextPartialErrors[item.productId] = "Enter delivered qty.";
          continue;
        }
        const delivered = Number(rawValue);
        if (!Number.isInteger(delivered) || delivered < 0) {
          nextPartialErrors[item.productId] = "Use a whole number (0 or more).";
          continue;
        }
        if (delivered > item.quantity) {
          nextPartialErrors[item.productId] = `Cannot exceed ordered qty (${item.quantity}).`;
          continue;
        }
        if (delivered > 0) deliveredAny = true;
        if (delivered < item.quantity) notFullyDeliveredAny = true;
      }
      if (!deliveredAny) {
        nextErrors.items = "For partial delivery, at least one line must have delivered qty greater than 0.";
      } else if (!notFullyDeliveredAny) {
        nextErrors.items = "All lines are fully delivered. Use Delivery Status = Delivered.";
      }
    }
    setPartialDeliveredErrors(nextPartialErrors);

    if (pendingImportLines.length > 0) {
      toast.error("Resolve or dismiss the imported unmatched lines before creating the order.");
      return;
    }
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
      customerType: "REGISTERED",
      userId,
      items: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        ...(deliveryStatus === "PARTIALLY_DELIVERED"
          ? {
              deliveredQuantity: Number(String(partialDeliveredByItem[item.productId] ?? "0").trim() || "0"),
            }
          : {}),
      })),
    };

    if (showUpfrontPayment && initPay > 0) {
      payload.initialPayment = initPay;
      payload.initialPaymentMethod = (initialPaymentMethod || "cash") as "cash" | "momo" | "transfer";
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
    if (deliveryStatus !== "NOT_SET") payload.deliveryStatus = deliveryStatus;
    if (tenderId) payload.sourceTenderId = tenderId;

    try {
      setSubmitting(true);
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        orderId?: string;
        details?: {
          fieldErrors?: Record<string, string[]>;
          formErrors?: string[];
        };
      };
      if (!response.ok) {
        const fieldMessage = body.details?.fieldErrors
          ? Object.values(body.details.fieldErrors).flat().find(Boolean)
          : undefined;
        const formMessage = body.details?.formErrors?.find(Boolean);
        toast.error(fieldMessage || formMessage || body.error || "Failed to create order");
        return;
      }
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(ORDER_DRAFT_KEY);
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      setErrors({});
      setPartialDeliveredErrors({});
      setConfirmOpen(false);
      toast.success("Order created");
      router.push(`/admin/orders/${body.orderId}`);
    } catch {
      toast.error("Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  submitRef.current = submit;

  const importBannerClass =
    importContext?.tone === "amber"
      ? "border-amber-300 bg-amber-50 text-amber-950"
      : importContext?.tone === "sky"
      ? "border-sky-300 bg-sky-50 text-sky-950"
      : "border-slate-300 bg-slate-50 text-slate-900";

  return (
    <div className="container mx-auto max-w-6xl space-y-6 py-8">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Create Order</h1>
            <p className="text-sm text-muted-foreground">
              Build a registered-customer order with safer imports, searchable lookups, and inline review.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Shortcuts: <span className="font-medium">Alt+I</span> add selected item,{" "}
            <span className="font-medium">Alt+S</span> validate and submit.
          </p>
          {loadingImport ? <p className="text-xs text-muted-foreground">Loading imported draft...</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/orders/otc">
            <Button variant="outline">Go to OTC Quick Sale</Button>
          </Link>
          <Link href="/admin/orders">
            <Button variant="secondary">Back to Orders</Button>
          </Link>
        </div>
      </div>

      {pendingDraft ? (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="font-medium text-emerald-900">Saved draft available</p>
              <p className="text-emerald-800">
                {draftAvailableAt ? `Last saved at ${new Date(draftAvailableAt).toLocaleTimeString()}.` : "Restore your last incomplete order draft."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={restoreDraft}>
                Restore Draft
              </Button>
              <Button variant="outline" onClick={discardDraft}>
                Dismiss Draft
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {importContext ? (
        <div className={`rounded-lg border p-4 ${importBannerClass}`}>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold">{importContext.title}</p>
            <p className="text-xs opacity-90">{importContext.detail}</p>
            {pendingImportLines.length ? (
              <p className="text-xs opacity-90">
                {pendingImportLines.length} imported line{pendingImportLines.length === 1 ? "" : "s"} still need manual review.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

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
          <CardTitle className="text-sm font-medium">Order Workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-12">
            <div className="space-y-5 lg:col-span-8">
              <section className="rounded-lg border p-4 space-y-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Customer</h3>
                    <p className="text-xs text-muted-foreground">
                      Select from the full registered-customer list. Walk-ins belong in OTC.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {customerLoading ? "Loading customers..." : `${customerTotal} customer${customerTotal === 1 ? "" : "s"} available`}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Customer</label>
                    <Select
                      value={userId}
                      onValueChange={(value) => {
                        setUserId(value);
                        setErrors((prev) => ({ ...prev, userId: "" }));
                      }}
                    >
                      <SelectTrigger className={errors.userId ? "border-red-500" : undefined}>
                        <SelectValue placeholder={customerLoading ? "Loading customers..." : "Select a customer"} />
                      </SelectTrigger>
                      <SelectContent className="max-h-80">
                        {knownCustomers.map((row) => (
                          <SelectItem key={row.user.id} value={row.user.id}>
                            {getCustomerLabel(row.user)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button variant="outline" onClick={() => setCustomerReloadKey((value) => value + 1)}>
                      Reload Customers
                    </Button>
                  </div>
                </div>
                {customerError ? (
                  <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700">
                    {customerError}
                  </div>
                ) : null}
                {selectedCustomer ? (
                  <div className="rounded-md border bg-muted/30 px-3 py-3 text-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-0.5">
                        <p className="font-medium">{getCustomerLabel(selectedCustomer)}</p>
                        {selectedCustomer.email ? <p className="text-xs text-muted-foreground">{selectedCustomer.email}</p> : null}
                        {selectedCustomer.phone ? <p className="text-xs text-muted-foreground">{selectedCustomer.phone}</p> : null}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setUserId("");
                          setErrors((prev) => ({ ...prev, userId: "" }));
                        }}
                      >
                        Clear Customer
                      </Button>
                    </div>
                  </div>
                ) : null}
                {customerLoading && knownCustomers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Loading customers...</p>
                ) : null}
                {!customerLoading && knownCustomers.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No customers are available. Use OTC for walk-ins.
                  </p>
                ) : null}
                {errors.userId ? <p className="text-xs text-red-600">{errors.userId}</p> : null}
              </section>

              {pendingImportLines.length ? (
                <section className="rounded-lg border p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold">Imported Line Review</h3>
                    <p className="text-xs text-muted-foreground">
                      Resolve unmatched imported lines before creating the order.
                    </p>
                  </div>
                  <div className="space-y-3">
                    {pendingImportLines.map((line) => {
                      const isMatching = line.id === pendingImportMatchId;
                      return (
                        <div key={line.id} className="rounded-md border p-3 text-sm">
                          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-1">
                              <p className="font-medium">
                                {line.itemRef} <span className="text-muted-foreground">x{line.quantity}</span>
                              </p>
                              <p className="text-xs text-muted-foreground">{line.hint}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant={isMatching ? "secondary" : "outline"}
                                onClick={() => {
                                  setPendingImportMatchId(line.id);
                                  setProductId("");
                                }}
                              >
                                Match Product
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => appendImportLineToNote(line)}>
                                Add as Note
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => updateImportLineStatus(line.id, "dismissed")}>
                                Skip
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              <section className="rounded-lg border p-4 space-y-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Order Lines</h3>
                    <p className="text-xs text-muted-foreground">
                      Select from the full product list, then add the product into the order grid.
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {productLoading ? "Loading products..." : `${productTotal} product${productTotal === 1 ? "" : "s"} available`}
                  </p>
                </div>

                {activeImportMatch ? (
                  <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-medium text-sky-900">
                          Matching imported line: {activeImportMatch.itemRef} x{activeImportMatch.quantity}
                        </p>
                        <p className="text-xs text-sky-800">
                          Select the replacement product below, then add the imported quantity.
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={clearPendingImportMatch}>
                        Cancel Match
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Product</label>
                    <Select
                      value={productId}
                      onValueChange={(value) => {
                        setProductId(value);
                        setErrors((prev) => ({ ...prev, productId: "" }));
                      }}
                    >
                      <SelectTrigger className={errors.productId ? "border-red-500" : undefined}>
                        <SelectValue placeholder={productLoading ? "Loading products..." : "Select a product"} />
                      </SelectTrigger>
                      <SelectContent className="max-h-80">
                        {knownProducts
                          .filter((product) => !product.archived)
                          .map((product) => (
                            <SelectItem key={product.id} value={product.id}>
                              {product.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button variant="outline" onClick={() => setProductReloadKey((value) => value + 1)}>
                      Reload Products
                    </Button>
                  </div>
                </div>
                {productError ? (
                  <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-700">
                    {productError}
                  </div>
                ) : null}
                {productLoading && knownProducts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Loading products...</p>
                ) : null}
                {!productLoading && knownProducts.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No products are available for ordering.
                  </p>
                ) : null}

                <div className="grid gap-3 md:grid-cols-12 md:items-end">
                  <div className="md:col-span-7">
                    <label className="mb-1 block text-sm font-medium">Selected Product</label>
                    <div className="rounded-md border bg-muted/20 px-3 py-3 text-sm">
                      {selectedProduct ? (
                        <div className="space-y-1">
                          <p className="font-medium">{selectedProduct.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(Number(selectedProduct.price || 0))} - {getEffectiveAvailable(selectedProduct)} available
                            {selectedProduct.sku ? ` - ${selectedProduct.sku}` : ""}
                          </p>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">Choose a product from the dropdown above.</p>
                      )}
                    </div>
                    {errors.productId ? <p className="mt-1 text-xs text-red-600">{errors.productId}</p> : null}
                  </div>
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-sm font-medium">
                      Quantity {activeImportMatch ? "(from import)" : ""}
                    </label>
                    <Input
                      type="number"
                      min="1"
                      value={activeImportMatch ? String(activeImportMatch.quantity) : quantity}
                      disabled={Boolean(activeImportMatch)}
                      onChange={(event) => {
                        setQuantity(event.target.value);
                        setErrors((prev) => ({ ...prev, quantity: "" }));
                      }}
                      className={errors.quantity ? "border-red-500" : undefined}
                    />
                    {errors.quantity ? <p className="mt-1 text-xs text-red-600">{errors.quantity}</p> : null}
                  </div>
                  <div className="md:col-span-3">
                    <Button className="w-full" onClick={addItem}>
                      {activeImportMatch ? `Add Imported Qty (${activeImportMatch.quantity})` : "Add Item"}
                    </Button>
                  </div>
                </div>

                {stockWarning ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
                    <div className="font-medium text-amber-950">
                      Split supply suggested for {stockWarning.productName}
                    </div>
                    <div className="text-xs text-amber-900">
                      Already in order: {stockWarning.currentQtyInCart}. Requested now: {stockWarning.requestedQty}. Can add now:{" "}
                      {stockWarning.addableQtyNow}. Remaining after this add: {stockWarning.remainingQty}.
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <Input
                        type="number"
                        min="1"
                        value={restockEtaDays}
                        onChange={(event) => setRestockEtaDays(event.target.value)}
                        placeholder="ETA days for remaining qty"
                      />
                      <Button variant="outline" onClick={() => addAvailableFromWarning(false)}>
                        Add Available Now
                      </Button>
                      <Button onClick={() => addAvailableFromWarning(true)}>
                        Add Available + Backorder Note
                      </Button>
                    </div>
                  </div>
                ) : null}

                {errors.items ? <p className="text-xs text-red-600">{errors.items}</p> : null}

                {items.length > 0 ? (
                  <div className="space-y-4">
                    {hasStockShortage ? (
                      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm space-y-2">
                        <div className="font-medium text-red-950">Stock shortage must be resolved</div>
                        <p className="text-xs text-red-800">
                          One or more lines exceed available stock. The order stays blocked until quantities are corrected.
                        </p>
                        <div className="space-y-1 text-xs text-red-900">
                          {stockShortages.map((row) => (
                            <div key={`shortage-${row.productId}`}>
                              {row.name}: requested {row.quantity}, available {row.available}, shortage {row.shortage}
                            </div>
                          ))}
                        </div>
                        <Button type="button" size="sm" variant="outline" onClick={capAllToAvailable}>
                          Cap All To Available + Add Notes
                        </Button>
                      </div>
                    ) : null}

                    <div className="space-y-3 lg:hidden">
                      {items.map((item) => {
                        const product = productMap.get(item.productId);
                        const available = getEffectiveAvailable(product);
                        return (
                          <div key={item.productId} className="rounded-md border p-3 text-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-medium">{item.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  {formatCurrency(item.price)} • {available} available
                                </div>
                              </div>
                              <Button variant="outline" size="sm" onClick={() => removeItem(item.productId)}>
                                Remove
                              </Button>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs font-medium">Qty</label>
                                <Input
                                  className="mt-1 h-8"
                                  type="number"
                                  min="1"
                                  value={item.quantity}
                                  onChange={(event) => updateItemQuantity(item.productId, event.target.value)}
                                />
                              </div>
                              <div>
                                <label className="text-xs font-medium">Line Total</label>
                                <div className="mt-1 rounded-md border bg-muted/20 px-3 py-2">
                                  {formatCurrency(item.price * item.quantity)}
                                </div>
                              </div>
                            </div>
                            {deliveryStatus === "PARTIALLY_DELIVERED" ? (
                              <div className="mt-3">
                                <label className="text-xs font-medium">Delivered now (0 to {item.quantity})</label>
                                <Input
                                  className={partialDeliveredErrors[item.productId] ? "mt-1 h-8 border-red-500" : "mt-1 h-8"}
                                  type="number"
                                  min="0"
                                  max={String(item.quantity)}
                                  step="1"
                                  value={partialDeliveredByItem[item.productId] ?? ""}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setPartialDeliveredByItem((prev) => ({ ...prev, [item.productId]: value }));
                                    if (partialDeliveredErrors[item.productId]) {
                                      setPartialDeliveredErrors((prev) => ({ ...prev, [item.productId]: "" }));
                                    }
                                    if (errors.items) setErrors((prev) => ({ ...prev, items: "" }));
                                  }}
                                />
                                {partialDeliveredErrors[item.productId] ? (
                                  <p className="mt-1 text-xs text-red-600">{partialDeliveredErrors[item.productId]}</p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    <div className="hidden lg:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="py-2 text-left">Item</th>
                            <th className="py-2 text-right">Available</th>
                            <th className="py-2 text-right">Qty</th>
                            <th className="py-2 text-right">Price</th>
                            <th className="py-2 text-right">Total</th>
                            {deliveryStatus === "PARTIALLY_DELIVERED" ? <th className="py-2 text-right">Delivered Now</th> : null}
                            <th className="py-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item) => {
                            const product = productMap.get(item.productId);
                            const available = getEffectiveAvailable(product);
                            return (
                              <tr key={item.productId} className="border-b last:border-0">
                                <td className="py-2">
                                  <div className="font-medium">{item.name}</div>
                                  <div className="text-xs text-muted-foreground">{product?.sku || item.productId}</div>
                                </td>
                                <td className="py-2 text-right">{available}</td>
                                <td className="py-2 text-right">
                                  <div className="ml-auto w-24">
                                    <Input
                                      className="h-8 text-right"
                                      type="number"
                                      min="1"
                                      value={item.quantity}
                                      onChange={(event) => updateItemQuantity(item.productId, event.target.value)}
                                    />
                                  </div>
                                </td>
                                <td className="py-2 text-right">{formatCurrency(item.price)}</td>
                                <td className="py-2 text-right">{formatCurrency(item.price * item.quantity)}</td>
                                {deliveryStatus === "PARTIALLY_DELIVERED" ? (
                                  <td className="py-2 text-right">
                                    <div className="ml-auto w-28">
                                      <Input
                                        className={
                                          partialDeliveredErrors[item.productId]
                                            ? "h-8 border-red-500 text-right"
                                            : "h-8 text-right"
                                        }
                                        type="number"
                                        min="0"
                                        max={String(item.quantity)}
                                        step="1"
                                        value={partialDeliveredByItem[item.productId] ?? ""}
                                        onChange={(event) => {
                                          const value = event.target.value;
                                          setPartialDeliveredByItem((prev) => ({ ...prev, [item.productId]: value }));
                                          if (partialDeliveredErrors[item.productId]) {
                                            setPartialDeliveredErrors((prev) => ({ ...prev, [item.productId]: "" }));
                                          }
                                          if (errors.items) setErrors((prev) => ({ ...prev, items: "" }));
                                        }}
                                      />
                                      {partialDeliveredErrors[item.productId] ? (
                                        <p className="mt-1 text-[11px] text-red-600">
                                          {partialDeliveredErrors[item.productId]}
                                        </p>
                                      ) : null}
                                    </div>
                                  </td>
                                ) : null}
                                <td className="py-2 text-right">
                                  <Button variant="outline" size="sm" onClick={() => removeItem(item.productId)}>
                                    Remove
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </section>
              
              <section className="rounded-lg border p-4 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold">Payment & Pricing</h3>
                  <p className="text-xs text-muted-foreground">
                    Keep payment optional at creation. Discounts remain admin-only and require a reason.
                  </p>
                </div>
                <div className={`grid grid-cols-1 gap-3 ${isAdmin ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2"}`}>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Upfront Payment</label>
                    <Button
                      type="button"
                      variant={showUpfrontPayment ? "secondary" : "outline"}
                      className="w-full"
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
                  <div>
                    <label className="mb-1 block text-sm font-medium">Tax % (optional)</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={taxRate}
                      onChange={(event) => {
                        setTaxRate(event.target.value);
                        setErrors((prev) => ({ ...prev, taxRate: "" }));
                      }}
                      placeholder="0"
                      className={errors.taxRate ? "border-red-500" : undefined}
                    />
                    {errors.taxRate ? <p className="mt-1 text-xs text-red-600">{errors.taxRate}</p> : null}
                  </div>
                  {isAdmin ? (
                    <>
                      <div>
                        <label className="mb-1 block text-sm font-medium">Discount Amount</label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={discountAmount}
                          onChange={(event) => {
                            setDiscountAmount(event.target.value);
                            setErrors((prev) => ({ ...prev, discountAmount: "", discountReason: "" }));
                          }}
                          placeholder="0.00"
                          className={errors.discountAmount ? "border-red-500" : undefined}
                        />
                        {errors.discountAmount ? <p className="mt-1 text-xs text-red-600">{errors.discountAmount}</p> : null}
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium">
                          Discount Reason {Number(discountAmount || 0) > 0 ? "*" : "(optional)"}
                        </label>
                        <Input
                          value={discountReason}
                          onChange={(event) => {
                            setDiscountReason(event.target.value);
                            setErrors((prev) => ({ ...prev, discountReason: "" }));
                          }}
                          placeholder="Required when discount is entered"
                          className={errors.discountReason ? "border-red-500" : undefined}
                        />
                        {errors.discountReason ? <p className="mt-1 text-xs text-red-600">{errors.discountReason}</p> : null}
                      </div>
                    </>
                  ) : null}
                </div>

                {showUpfrontPayment ? (
                  <div className="rounded-md border border-dashed bg-muted/30 p-4 space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Payment Details</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-sm font-medium">Amount (GHS)</label>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={initialPayment}
                            onChange={(event) => {
                              setInitialPayment(event.target.value);
                              setErrors((prev) => ({
                                ...prev,
                                initialPayment: "",
                                initialPaymentMethod: "",
                                initialPaymentReference: "",
                              }));
                            }}
                            className={errors.initialPayment ? "border-red-500" : undefined}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0 whitespace-nowrap text-xs"
                            onClick={() => setInitialPayment(total > 0 ? total.toFixed(2) : "")}
                          >
                            {total > 0 ? `Set Full (${formatCurrency(total)})` : "Set Full"}
                          </Button>
                        </div>
                        {errors.initialPayment ? <p className="mt-1 text-xs text-red-600">{errors.initialPayment}</p> : null}
                      </div>
                      <div>
                        <label className="mb-1 block text-sm font-medium">Payment Method</label>
                        <Select
                          value={initialPaymentMethod}
                          onValueChange={(value) => {
                            const next = value as "" | "cash" | "momo" | "transfer";
                            setInitialPaymentMethod(next);
                            setErrors((prev) => ({ ...prev, initialPaymentMethod: "" }));
                            if (next !== "momo" && next !== "transfer") {
                              setInitialPaymentReference("");
                              setErrors((prev) => ({ ...prev, initialPaymentReference: "" }));
                            }
                          }}
                        >
                          <SelectTrigger className={errors.initialPaymentMethod ? "border-red-500" : undefined}>
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
                    </div>
                    {initialPaymentMethod === "momo" || initialPaymentMethod === "transfer" ? (
                      <div>
                        <label className="mb-1 block text-sm font-medium">Payment Reference</label>
                        <Input
                          value={initialPaymentReference}
                          onChange={(event) => {
                            setInitialPaymentReference(event.target.value);
                            setErrors((prev) => ({ ...prev, initialPaymentReference: "" }));
                          }}
                          placeholder={
                            initialPaymentMethod === "transfer"
                              ? "e.g., bank transfer reference"
                              : "e.g., MoMo transaction ID"
                          }
                          className={errors.initialPaymentReference ? "border-red-500" : undefined}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">Required when initial payment is entered.</p>
                        {errors.initialPaymentReference ? (
                          <p className="mt-1 text-xs text-red-600">{errors.initialPaymentReference}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="space-y-4 lg:col-span-4">
              <section className="space-y-4 rounded-lg border p-4 lg:sticky lg:top-24">
                <div>
                  <h3 className="text-sm font-semibold">Finalize Order</h3>
                  <p className="text-xs text-muted-foreground">
                    Review financials, choose delivery state, and confirm the create action.
                  </p>
                </div>
                <div className="rounded-md bg-muted/40 p-3 text-sm space-y-1">
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
                  <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                    <span>Total</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                  {showUpfrontPayment && Number(initialPayment || 0) > 0 ? (
                    <>
                      <div className="mt-1 flex justify-between text-xs text-green-700">
                        <span>Initial payment</span>
                        <span>-{formatCurrency(Math.min(Number(initialPayment || 0), total))}</span>
                      </div>
                      <div className="mt-1 flex justify-between border-t pt-1 text-sm font-medium">
                        <span>Balance due</span>
                        <span className={Math.max(0, total - Number(initialPayment || 0)) > 0 ? "text-amber-700" : "text-green-700"}>
                          {formatCurrency(Math.max(0, total - Number(initialPayment || 0)))}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium">Delivery Status</label>
                  <Select
                    value={deliveryStatus}
                    onValueChange={(
                      value:
                        | "NOT_SET"
                        | "NOT_DELIVERED"
                        | "PARTIALLY_DELIVERED"
                        | "DELIVERED"
                        | "RETURNED",
                    ) => {
                      setDeliveryStatus(value);
                      if (value !== "PARTIALLY_DELIVERED") {
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
                    Partially delivered orders require a delivered quantity on every line.
                  </p>
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-sm font-medium">Order / Supply Note (optional)</label>
                    <span className={`text-xs ${orderNote.length > 1900 ? "text-amber-600" : "text-muted-foreground"}`}>
                      {orderNote.length}/2000
                    </span>
                  </div>
                  <Textarea
                    value={orderNote}
                    onChange={(event) => setOrderNote(event.target.value)}
                    placeholder="e.g., IV cannula: 80 supplied now, 120 pending, ETA 7 days"
                    rows={4}
                    maxLength={2000}
                    className="resize-y text-sm"
                  />
                </div>

                <Button
                  className="w-full"
                  disabled={hasStockShortage || submitting}
                  onClick={() => {
                    void submit(false);
                  }}
                >
                  {submitting ? "Creating..." : "Create Order"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {lastValidationAt
                    ? `Last validation check: ${lastValidationAt.toLocaleTimeString()}`
                    : "Validation check will appear after the first submit attempt."}
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
            <div className="space-y-1 rounded border bg-muted/30 p-3">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Customer</span>
                <span className="font-medium">{getCustomerLabel(selectedCustomer)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Items</span>
                <span className="font-medium">
                  {items.length} line{items.length === 1 ? "" : "s"} / {items.reduce((sum, item) => sum + item.quantity, 0)} qty
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Delivery</span>
                <span className="font-medium">{getDeliveryLabel(deliveryStatus)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Upfront payment</span>
                <span className="font-medium">
                  {showUpfrontPayment && Number(initialPayment || 0) > 0
                    ? `${initialPaymentMethod === "momo" ? "MoMo" : initialPaymentMethod === "transfer" ? "Transfer" : "Cash"} - ${formatCurrency(Number(initialPayment || 0))}`
                    : "None"}
                </span>
              </div>
              {showUpfrontPayment && Number(initialPayment || 0) > 0 ? (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Balance after payment</span>
                  <span className="font-medium">{formatCurrency(Math.max(0, total - Number(initialPayment || 0)))}</span>
                </div>
              ) : null}
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
            {orderNote.trim() ? (
              <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Note</p>
                <p className="whitespace-pre-wrap">{orderNote.trim()}</p>
              </div>
            ) : null}
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
