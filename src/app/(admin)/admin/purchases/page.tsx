"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { useClientQuery } from "@/hooks/use-client-query";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Info } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { hasPermission } from "@/lib/permissions";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { toast } from "sonner";

// Title-case helper: capitalizes first letter of each word
function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function formatCategoryLabel(category?: string | null) {
  if (!category) return "";
  return toTitleCase(category.replace(/-/g, " "));
}

function formatStatusLabel(status?: string | null) {
  const base = status || "RECEIVED";
  return toTitleCase(base.replace(/_/g, " "));
}

function getProductOptionLabel(product?: Pick<Product, "name" | "sku"> | null) {
  if (!product) return "";
  return `${toTitleCase(product.name || "")}${product.sku ? ` - ${product.sku}` : ""}`;
}

function describeTrackingRequirements(requiresLotTracking?: boolean, requiresExpiryDate?: boolean) {
  if (requiresLotTracking && requiresExpiryDate) return "lot/batch codes and expiry dates.";
  if (requiresLotTracking) return "lot/batch codes.";
  if (requiresExpiryDate) return "expiry dates.";
  return "tracking details.";
}

function isCancelablePurchase(row: PurchaseRow) {
  const status = String(row.status || "").toUpperCase();
  const received = Number(row.receivedQuantity ?? 0);
  return received <= 0 && ["PENDING_APPROVAL", "APPROVED", "ORDERED"].includes(status);
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  brand?: string | null;
  supplier?: string | null;
  supplierId?: string | null;
  approvalThresholdQty?: number | null;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
};

type SupplierOption = {
  id: string;
  name: string;
};

type PurchaseRow = {
  id: string;
  productId: string;
  productName: string;
  productSku?: string | null;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
  quantity: number;
  orderedQuantity?: number;
  receivedQuantity?: number;
  status?: string;
  expectedAt?: string | Date | null;
  supplierId?: string | null;
  unitCost: number;
  total: number;
  supplier?: string | null;
  reason?: string | null;
  note?: string | null;
  createdAt: string | Date;
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function isAwaitingReceive(row: PurchaseRow) {
  const status = String(row.status || "").toUpperCase();
  const openStatus = ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(status);
  const ordered = Number(row.orderedQuantity ?? row.quantity);
  const received = Number(row.receivedQuantity ?? 0);
  return openStatus && received < ordered;
}

function getExpectedUrgency(row: PurchaseRow): { label: string; tone: "danger" | "warning" | "neutral" } | null {
  if (!row.expectedAt || !isAwaitingReceive(row)) return null;
  const expected = new Date(row.expectedAt);
  if (Number.isNaN(expected.getTime())) return null;
  const today = startOfDay(new Date());
  const target = startOfDay(expected);
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((target.getTime() - today.getTime()) / dayMs);
  if (diffDays < 0) {
    return { label: `Overdue ${Math.abs(diffDays)}d`, tone: "danger" };
  }
  if (diffDays === 0) {
    return { label: "Due today", tone: "warning" };
  }
  if (diffDays <= 3) {
    return { label: `Due in ${diffDays}d`, tone: "warning" };
  }
  return { label: `Expected ${expected.toLocaleDateString()}`, tone: "neutral" };
}

type PurchaseQuickView = "all" | "pending_approval" | "awaiting_receive" | "due_today" | "overdue";
type PurchaseExpectedWindow = "all" | "missing" | "this_week" | "next_7";
type ExpectedSort = "none" | "expected_oldest" | "expected_newest" | "missing_first";
type BulkSummary = { open: boolean; title: string; success: number; failed: number; details: string[] };

type PurchasesSavedFilter = {
  id: string;
  name: string;
  state: {
    start: string;
    end: string;
    supplier: string;
    q: string;
    product: string;
    status: string;
    purchaseId: string;
    paymentId: string;
    quickView: PurchaseQuickView;
    expectedWindow: PurchaseExpectedWindow;
    expectedSort: ExpectedSort;
    openOnly: boolean;
    pageSize: 25 | 50 | 100;
    showSupplierCol: boolean;
    showReasonCol: boolean;
    showNoteCol: boolean;
  };
};

type PurchasesListMeta = {
  total: number;
  baseTotal: number;
  quickCounts: {
    pendingApproval: number;
    awaitingReceive: number;
    dueToday: number;
    overdue: number;
  };
  expectedCounts: {
    missing: number;
    thisWeek: number;
    next7: number;
  };
  statusCounts: Array<{ status: string; count: number }>;
  viewTotals: {
    qty: number;
    value: number;
  };
  topSuppliers: string[];
  supplierOpenSummary: Array<{
    supplier: string;
    openQty: number;
    openValue: number;
    oldestExpected: string | null;
    overdueCount: number;
  }>;
  staleOpenSummary: {
    missingExpected: number;
    overdue7Plus: number;
    total: number;
  };
  hasScopedViewMismatch: boolean;
};

const PURCHASES_DRAFT_KEY = "admin-purchases-draft-v1";
const PURCHASES_DRAFT_TTL_MS = 3 * 60 * 1000;
const EMPTY_PURCHASE_FORM = {
  productSearch: "",
  productId: "",
  quantity: "",
  unitCost: "",
  supplier: "",
  supplierId: "",
  reason: "",
  note: "",
  expectedAt: "",
  lotCode: "",
  expiryDate: "",
  receiveNow: false,
  paidOnReceipt: false,
  paymentMethod: "",
};

type PurchasesDraft = {
  ts: number;
  form: typeof EMPTY_PURCHASE_FORM;
};

function AdminPurchasesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", supplier: "", q: "", product: "", status: "", purchaseId: "", paymentId: "" });
  const [filtersReady, setFiltersReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [purchaseIntentProductId, setPurchaseIntentProductId] = useState("");
  const [purchaseIntentQty, setPurchaseIntentQty] = useState("");
  const [listMeta, setListMeta] = useState<PurchasesListMeta>({
    total: 0,
    baseTotal: 0,
    quickCounts: { pendingApproval: 0, awaitingReceive: 0, dueToday: 0, overdue: 0 },
    expectedCounts: { missing: 0, thisWeek: 0, next7: 0 },
    statusCounts: [],
    viewTotals: { qty: 0, value: 0 },
    topSuppliers: [],
    supplierOpenSummary: [],
    staleOpenSummary: { missingExpected: 0, overdue7Plus: 0, total: 0 },
    hasScopedViewMismatch: false,
  });
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveRow, setReceiveRow] = useState<PurchaseRow | null>(null);
  const [receiveQty, setReceiveQty] = useState("");
  const [receiveLotCode, setReceiveLotCode] = useState("");
  const [receiveExpiry, setReceiveExpiry] = useState("");
  const [receiveLotNotes, setReceiveLotNotes] = useState("");
  const [receiveErrors, setReceiveErrors] = useState<{ lotCode?: string; expiryDate?: string }>({});
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnRow, setReturnRow] = useState<PurchaseRow | null>(null);
  const [returnQty, setReturnQty] = useState("");
  const [returnLotCode, setReturnLotCode] = useState("");
  const [returnNotes, setReturnNotes] = useState("");
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [products, setProducts] = useState<Product[]>([]);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const { data: purchaseConfigData } = useClientQuery<{
    purchaseApprovalQtyThreshold?: number;
    supplierPaymentApprovalThreshold?: number;
  }>({
    queryKey: ["admin", "purchases", "config"],
    queryFn: () => fetch("/api/admin/purchases/config").then((r) => r.json()),
  });
  const { data: suppliersData } = useClientQuery<{ rows: SupplierOption[] }>({
    queryKey: ["admin", "suppliers"],
    queryFn: () => fetch("/api/admin/suppliers").then((r) => r.json()),
  });
  const suppliers = Array.isArray(suppliersData?.rows) ? suppliersData.rows : [];
  const systemSupplierNames = new Set(["unknown", "initial stock", "initial order"]);
  const assignableSuppliers = suppliers.filter(
    (s) => !systemSupplierNames.has(s.name.trim().toLowerCase()),
  );
  const [form, setForm] = useState({ ...EMPTY_PURCHASE_FORM });
  const [purchaseFormOpen, setPurchaseFormOpen] = useState(false);
  const [draftAvailableAt, setDraftAvailableAt] = useState<number | null>(null);
  const [pendingDraft, setPendingDraft] = useState<PurchasesDraft | null>(null);
  const [currentCost, setCurrentCost] = useState<number | null>(null);
  const [currentStock, setCurrentStock] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selected, setSelected] = useState<PurchaseRow | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<PurchaseRow | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<PurchaseRow | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<{
    productId?: string;
    quantity?: string;
    unitCost?: string;
    supplier?: string;
    lotCode?: string;
    expiryDate?: string;
    paymentMethod?: string;
  }>({});
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const [quickView, setQuickView] = useState<PurchaseQuickView>("all");
  const [expectedWindow, setExpectedWindow] = useState<PurchaseExpectedWindow>("all");
  const [expectedDraftById, setExpectedDraftById] = useState<Record<string, string>>({});
  const [updatingExpectedId, setUpdatingExpectedId] = useState<string | null>(null);
  const [bulkExpectedDate, setBulkExpectedDate] = useState("");
  const [bulkExpectedUpdating, setBulkExpectedUpdating] = useState(false);
  const [expectedSort, setExpectedSort] = useState<ExpectedSort>("none");
  const [openOnly, setOpenOnly] = useState(false);
  const [bulkReceiveOpen, setBulkReceiveOpen] = useState(false);
  const [bulkReceiveRule, setBulkReceiveRule] = useState<"full" | "remaining_only">("full");
  const [bulkReceiveSubmitting, setBulkReceiveSubmitting] = useState(false);
  const [bulkReturnOpen, setBulkReturnOpen] = useState(false);
  const [bulkReturnReason, setBulkReturnReason] = useState("");
  const [bulkReturnSubmitting, setBulkReturnSubmitting] = useState(false);
  const [bulkSupplierId, setBulkSupplierId] = useState("");
  const [bulkSupplierSubmitting, setBulkSupplierSubmitting] = useState(false);
  const [lastBulkSupplierUndoRows, setLastBulkSupplierUndoRows] = useState<Array<{ id: string; supplierId: string | null; supplier: string | null }>>([]);
  const [bulkSummary, setBulkSummary] = useState<BulkSummary>({ open: false, title: "", success: 0, failed: 0, details: [] });
  const [purchaseConfirmOpen, setPurchaseConfirmOpen] = useState(false);
  const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
  const [pendingPurchasePayload, setPendingPurchasePayload] = useState<null | {
    productId: string;
    quantity: number;
    unitCost: number;
    supplier?: string;
    supplierId?: string;
    reason?: string;
    note?: string;
    expectedAt?: string;
    lotCode?: string;
    expiryDate?: string;
    receiveNow: boolean;
    paidOnReceipt: boolean;
    paymentMethod?: string;
    highValueCreditOnly?: boolean;
  }>(null);
  const lastFormProductId = useRef<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSupplierCol, setShowSupplierCol] = useState(true);
  const [showReasonCol, setShowReasonCol] = useState(true);
  const [showNoteCol, setShowNoteCol] = useState(true);
  const { data: session, status: sessionStatus } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const canManagePurchases = hasPermission(role, "purchases.manage");
  const [savedFilters, setSavedFilters] = useState<PurchasesSavedFilter[]>([]);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    select: 44,
    date: 170,
    product: 240,
    qty: 90,
    unitCost: 120,
    status: 180,
    received: 120,
    total: 120,
    supplier: 160,
    reason: 200,
    note: 220,
    actions: 160,
  });

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    const incomingProductId = sp.get("product") || "";
    const incomingQty = sp.get("qty") || "";
    const wantsNewPurchase = sp.get("new") === "1";
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      supplier: sp.get("supplier") || "",
      q: sp.get("q") || "",
      product: incomingProductId,
      status: sp.get("status") || "",
      purchaseId: sp.get("purchaseId") || "",
      paymentId: sp.get("paymentId") || "",
    });
    if (wantsNewPurchase && incomingProductId) {
      setPurchaseIntentProductId(incomingProductId);
      setPurchaseIntentQty(incomingQty);
      setPurchaseFormOpen(true);
    }
    initialized.current = true;
    setFiltersReady(true);
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (filters.start) params.set("start", filters.start); else params.delete("start");
    if (filters.end) params.set("end", filters.end); else params.delete("end");
    if (filters.supplier) params.set("supplier", filters.supplier); else params.delete("supplier");
    if (filters.q) params.set("q", filters.q); else params.delete("q");
    if (filters.product) params.set("product", filters.product); else params.delete("product");
    if (filters.status) params.set("status", filters.status); else params.delete("status");
    if (filters.purchaseId) params.set("purchaseId", filters.purchaseId); else params.delete("purchaseId");
    if (filters.paymentId) params.set("paymentId", filters.paymentId); else params.delete("paymentId");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-purchases-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as PurchasesSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-purchases-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters]);

  useEffect(() => {
    if (!draftAvailableAt) return;
    setPurchaseFormOpen(true);
  }, [draftAvailableAt]);

  const focusPurchaseForm = useCallback((targetId = "product") => {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const formEl = document.getElementById("purchase-form");
      formEl?.scrollIntoView({ behavior: "smooth", block: "center" });
      const target = document.getElementById(targetId) as HTMLInputElement | null;
      target?.focus();
    });
  }, []);

  useEffect(() => {
    if (!form.productId) return;
    const match = products.find((product) => product.id === form.productId);
    if (!match) return;
    const nextLabel = getProductOptionLabel(match);
    setForm((prev) => (
      prev.productId !== match.id
        ? prev
        : prev.productSearch === nextLabel &&
            (prev.supplier || "") === (match.supplier || "") &&
            (prev.supplierId || "") === (match.supplierId || "")
          ? prev
          : {
              ...prev,
              productSearch: nextLabel,
              supplier:
                prev.supplier.trim() ||
                prev.supplierId ||
                !match.supplier
                  ? prev.supplier
                  : match.supplier,
              supplierId:
                prev.supplierId ||
                !match.supplierId
                  ? prev.supplierId
                  : match.supplierId,
            }
    ));
  }, [form.productId, form.productSearch, products]);

  useEffect(() => {
    if (!purchaseIntentProductId || !products.length) return;
    const product =
      products.find((entry) => entry.id === purchaseIntentProductId) ?? null;
    setForm({
      ...EMPTY_PURCHASE_FORM,
      productSearch: product ? getProductOptionLabel(product) : "",
      productId: purchaseIntentProductId,
      quantity: purchaseIntentQty,
      supplier: product?.supplier ?? "",
      supplierId: product?.supplierId ?? "",
    });
    setFormErrors({});
    setProductPickerOpen(false);
    setPurchaseFormOpen(true);
    focusPurchaseForm(product ? "qty" : "product");
    setPurchaseIntentProductId("");
    setPurchaseIntentQty("");
  }, [focusPurchaseForm, products, purchaseIntentProductId, purchaseIntentQty]);

  const syncSupplierSelection = useCallback((rawValue: string) => {
    const trimmed = rawValue.trim();
    const match = assignableSuppliers.find(
      (supplier) => supplier.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    setForm((prev) => ({
      ...prev,
      supplier: match?.name ?? rawValue,
      supplierId: match?.id ?? "",
    }));
    if (formErrors.supplier) {
      setFormErrors((prev) => ({ ...prev, supplier: "" }));
    }
  }, [assignableSuppliers, formErrors.supplier]);

  const selectProductOption = useCallback((product: Product | null) => {
    setForm((prev) => ({
      ...prev,
      productSearch: product ? getProductOptionLabel(product) : "",
      productId: product?.id ?? "",
      supplier: product ? product.supplier || prev.supplier : prev.supplier,
      supplierId: product ? product.supplierId ?? "" : prev.supplierId,
    }));
    if (formErrors.productId) {
      setFormErrors((prev) => ({ ...prev, productId: "" }));
    }
    setProductPickerOpen(false);
  }, [formErrors.productId]);

  const productPickerOptions = useMemo(() => {
    const query = form.productSearch.trim().toLowerCase();
    const ranked = products.filter((product) => {
      if (!query) return true;
      return (
        String(product.name || "").toLowerCase().includes(query) ||
        String(product.sku || "").toLowerCase().includes(query) ||
        String(product.brand || "").toLowerCase().includes(query) ||
        String(product.category || "").toLowerCase().includes(query)
      );
    });
    return ranked.slice(0, 12);
  }, [form.productSearch, products]);

  const openPurchaseFormPanel = useCallback(() => {
    setPurchaseFormOpen(true);
    focusPurchaseForm(form.productId ? "qty" : "product");
  }, [focusPurchaseForm, form.productId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-purchases-column-widths");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setColumnWidths((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-purchases-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(90, startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [key]: next }));
    };
    const handleUp = () => {
      if (!resizing.current) return;
      resizing.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === form.productId) ?? null,
    [products, form.productId],
  );
  const approvalThreshold = Number(
    purchaseConfigData?.purchaseApprovalQtyThreshold ??
      process.env.NEXT_PUBLIC_PURCHASE_APPROVAL_QTY_THRESHOLD ??
      0,
  );
  const productApprovalThreshold = Number(selectedProduct?.approvalThresholdQty ?? 0);
  const effectiveApprovalThreshold =
    Number.isFinite(approvalThreshold) && approvalThreshold > 0 &&
    Number.isFinite(productApprovalThreshold) && productApprovalThreshold > 0
      ? Math.min(approvalThreshold, productApprovalThreshold)
      : Number.isFinite(approvalThreshold) && approvalThreshold > 0
      ? approvalThreshold
      : Number.isFinite(productApprovalThreshold) && productApprovalThreshold > 0
      ? productApprovalThreshold
      : 0;
  const approvalRequiredForForm =
    Boolean(form.quantity.trim()) &&
    Number.isFinite(effectiveApprovalThreshold) &&
    effectiveApprovalThreshold > 0 &&
    Number(form.quantity) >= effectiveApprovalThreshold;
  const paymentApprovalThreshold = Number(
    purchaseConfigData?.supplierPaymentApprovalThreshold ??
      process.env.NEXT_PUBLIC_SUPPLIER_PAYMENT_APPROVAL_THRESHOLD ??
      0,
  );
  const highValueCreditOnlyForForm =
    Boolean(form.quantity.trim()) &&
    Boolean(form.unitCost.trim()) &&
    Number.isFinite(paymentApprovalThreshold) &&
    paymentApprovalThreshold > 0 &&
    Number(form.quantity) * Number(form.unitCost) >= paymentApprovalThreshold;

  useEffect(() => {
    if (!approvalRequiredForForm) return;
    setForm((prev) => ({
      ...prev,
      receiveNow: false,
      paidOnReceipt: false,
      paymentMethod: "",
    }));
  }, [approvalRequiredForForm]);
  useEffect(() => {
    if (!highValueCreditOnlyForForm) return;
    setForm((prev) => ({
      ...prev,
      paidOnReceipt: false,
      paymentMethod: "",
    }));
  }, [highValueCreditOnlyForForm]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(PURCHASES_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PurchasesDraft;
      const ts = Number(parsed?.ts || 0);
      if (!ts || !parsed?.form) return;
      const ageMs = Date.now() - ts;
      if (ageMs <= PURCHASES_DRAFT_TTL_MS) {
        setDraftAvailableAt(ts);
        setPendingDraft(parsed);
      } else {
        window.localStorage.removeItem(PURCHASES_DRAFT_KEY);
      }
    } catch {
      // ignore malformed local data
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasContent =
      Boolean(form.productId) ||
      Boolean(form.quantity.trim()) ||
      Boolean(form.unitCost.trim()) ||
      Boolean(form.supplier.trim()) ||
      Boolean(form.supplierId) ||
      Boolean(form.reason.trim()) ||
      Boolean(form.note.trim()) ||
      Boolean(form.expectedAt) ||
      Boolean(form.lotCode.trim()) ||
      Boolean(form.expiryDate) ||
      Boolean(form.receiveNow) ||
      Boolean(form.paidOnReceipt) ||
      Boolean(form.paymentMethod);
    if (!hasContent && pendingDraft) {
      return;
    }
    if (hasContent) {
      const payload: PurchasesDraft = {
        ts: Date.now(),
        form: { ...form },
      };
      window.localStorage.setItem(PURCHASES_DRAFT_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(PURCHASES_DRAFT_KEY);
    }
  }, [form, pendingDraft]);

  const restoreDraft = () => {
    if (typeof window === "undefined" || !pendingDraft?.form) return;
    try {
      setForm({ ...EMPTY_PURCHASE_FORM, ...pendingDraft.form });
      setPurchaseFormOpen(true);
      setDraftAvailableAt(null);
      setPendingDraft(null);
      toast.success("Recovered recent purchase draft.");
    } catch {
      toast.error("Failed to restore purchase draft.");
    }
  };

  const clearDraft = () => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(PURCHASES_DRAFT_KEY);
    setDraftAvailableAt(null);
    setPendingDraft(null);
    toast.success("Purchase draft cleared.");
  };

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 120,
    };
    document.body.style.cursor = "col-resize";
  };

  const fetchProducts = useCallback(async () => {
    try {
      const pageSize = 100;
      const list: Product[] = [];
      let pageNumber = 1;
      let total = Number.POSITIVE_INFINITY;
      while (list.length < total) {
        const res = await fetch(`/api/products?page=${pageNumber}&pageSize=${pageSize}&includeArchived=1`);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        items.forEach((p: { id: string; name: string; sku?: string | null; category?: string | null; brand?: string | null; supplier?: string | null; supplierId?: string | null; approvalThresholdQty?: number | null; requiresLotTracking?: boolean | null; requiresExpiryDate?: boolean | null }) => {
          list.push({
            id: p.id,
            name: p.name,
            sku: p.sku ?? null,
            category: p.category ?? null,
            brand: p.brand ?? null,
            supplier: p.supplier ?? null,
            supplierId: p.supplierId ?? null,
            approvalThresholdQty:
              p.approvalThresholdQty === null || p.approvalThresholdQty === undefined
                ? null
                : Number(p.approvalThresholdQty),
            requiresLotTracking: Boolean(p.requiresLotTracking),
            requiresExpiryDate: Boolean(p.requiresExpiryDate),
          });
        });
        total = Number(data.total || items.length);
        if (items.length === 0 || items.length < pageSize) break;
        pageNumber += 1;
      }
      setProducts(list);
    } catch {}
  }, []);

  const fetchPurchases = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.supplier) params.append("supplier", filters.supplier);
      if (filters.q) params.append("q", filters.q);
      if (filters.product) params.append("product", filters.product);
      if (filters.status) params.append("status", filters.status);
      if (filters.purchaseId) params.append("purchaseId", filters.purchaseId);
      if (filters.paymentId) params.append("paymentId", filters.paymentId);
      params.append("page", String(page));
      params.append("pageSize", String(pageSize));
      params.append("quickView", quickView);
      params.append("expectedWindow", expectedWindow);
      params.append("expectedSort", expectedSort);
      if (openOnly) params.append("openOnly", "1");
      const res = await fetch(`/api/admin/purchases?${params.toString()}`);
      let data: { items?: PurchaseRow[]; rows?: PurchaseRow[]; error?: string; meta?: PurchasesListMeta } = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        console.error("Failed to load purchases:", data?.error || res.statusText);
        setRows([]);
        setListMeta((prev) => ({ ...prev, total: 0, baseTotal: 0 }));
        if (res.status === 401) {
          setError("Your session does not have access to Purchases. Please sign in as an admin.");
        } else {
          setError(typeof data?.error === "string" ? data.error : "Failed to load purchases");
        }
        return;
      }
      const incomingRows = Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.rows)
        ? data.rows
        : [];
      // Recovery: if URL/status filter is stale (for example PENDING_APPROVAL with no rows),
      // transparently retry once without status and clear it if data exists.
      if (incomingRows.length === 0 && filters.status) {
        const retryParams = new URLSearchParams(params.toString());
        retryParams.delete("status");
        const retryRes = await fetch(`/api/admin/purchases?${retryParams.toString()}`);
        if (retryRes.ok) {
          const retryData = (await retryRes.json().catch(() => ({}))) as { items?: PurchaseRow[]; rows?: PurchaseRow[]; meta?: PurchasesListMeta };
          const retryRows = Array.isArray(retryData.items)
            ? retryData.items
            : Array.isArray(retryData.rows)
            ? retryData.rows
            : [];
          if (retryRows.length > 0) {
            setFilters((prev) => ({ ...prev, status: "" }));
            setRows(retryRows);
            if (retryData.meta) setListMeta(retryData.meta);
            setError(null);
            toast.info("Status filter was stale and has been cleared.");
            return;
          }
        }
      }
      setRows(incomingRows);
      if (data.meta) setListMeta(data.meta);
      setError(null);
    } catch (err) {
      console.error(err);
      setRows([]);
      setListMeta((prev) => ({ ...prev, total: 0, baseTotal: 0 }));
      setError(err instanceof Error ? err.message : "Failed to load purchases");
    } finally {
      setLoading(false);
    }
  }, [filters.start, filters.end, filters.supplier, filters.q, filters.product, filters.status, filters.purchaseId, filters.paymentId, page, pageSize, quickView, expectedWindow, expectedSort, openOnly]);

  useEffect(() => {
    if (!filtersReady) return;
    if (sessionStatus === "loading") return;
    if (!canManagePurchases) {
      setRows([]);
      setError("You do not have access to Purchases.");
      return;
    }
    fetchPurchases();
  }, [fetchPurchases, filtersReady, canManagePurchases, sessionStatus]);

  useEffect(() => {
    if (!filtersReady) return;
    if (sessionStatus === "loading") return;
    if (!canManagePurchases) return;
    fetchProducts();
  }, [fetchProducts, filtersReady, canManagePurchases, sessionStatus]);

  useEffect(() => {
    setUpdatedAtText(new Date().toLocaleString());
  }, [rows]);
  useEffect(() => {
    if (!rows.length) return;
    setExpectedDraftById((prev) => {
      const next = { ...prev };
      for (const row of rows) {
        if (next[row.id] !== undefined) continue;
        next[row.id] = row.expectedAt ? new Date(row.expectedAt).toISOString().slice(0, 10) : "";
      }
      return next;
    });
  }, [rows]);
  useEffect(() => {
    setSelectedIds((prev) => new Set(Array.from(prev).filter((id) => rows.some((row) => row.id === id))));
  }, [rows]);

  // Keep the purchases filter in sync with the selected product,
  // but only when the filter is empty or was previously synced.
  useEffect(() => {
    const next = form.productId;
    if (!initialized.current) return;
    if (!next) {
      if (filters.product && filters.product === lastFormProductId.current) {
        setFilters((prev) => ({ ...prev, product: "" }));
      }
      lastFormProductId.current = "";
      return;
    }
    if (!filters.product || filters.product === lastFormProductId.current) {
      setFilters((prev) => ({ ...prev, product: next }));
    }
    lastFormProductId.current = next;
  }, [form.productId, filters.product]);

  // If the filter is cleared to "All products", clear the form product
  // when it was previously synced to avoid stale selections.
  useEffect(() => {
    if (!initialized.current) return;
    if (!filters.product && form.productId && form.productId === lastFormProductId.current) {
      setForm((prev) => ({ ...prev, productId: "", productSearch: "" }));
      lastFormProductId.current = "";
    }
  }, [filters.product, form.productId]);

  // Load current average cost when product changes
  useEffect(() => {
    (async () => {
      if (!form.productId) {
        setCurrentCost(null);
        setCurrentStock(null);
        return;
      }
      try {
        const inv = await fetch(
          `/api/admin/inventory?productId=${encodeURIComponent(form.productId)}`,
        );
        const data = await inv.json();
        const row = (data.rows || []).find(
          (r: {
            id: string;
            cost?: number | string | null;
            stock?: number | string | null;
          }) => r.id === form.productId,
        );
        setCurrentCost(row ? Number(row.cost || 0) : null);
        setCurrentStock(row ? Number(row.stock || 0) : null);
      } catch {
        setCurrentCost(null);
        setCurrentStock(null);
      }
    })();
  }, [form.productId]);

  const variance = useMemo(() => {
    const uc = Number(form.unitCost);
    if (!currentCost && currentCost !== 0) return null;
    if (!isFinite(uc)) return null;
    const diff = uc - Number(currentCost);
    const pct = Number(currentCost) > 0 ? (diff / Number(currentCost)) * 100 : null;
    return { diff, pct } as { diff: number; pct: number | null };
  }, [form.unitCost, currentCost]);

  const quickCounts = listMeta.quickCounts;
  const expectedCounts = listMeta.expectedCounts;
  const viewTotals = listMeta.viewTotals;
  const hasScopedViewMismatch = listMeta.hasScopedViewMismatch;
  const filtersAreClear =
    !filters.start &&
    !filters.end &&
    !filters.supplier &&
    !filters.q &&
    !filters.product &&
    !filters.status &&
    !filters.purchaseId &&
    !filters.paymentId;
  const avgUnitCostView = viewTotals.qty > 0 ? viewTotals.value / viewTotals.qty : 0;
  const projectedAverageCost = useMemo(() => {
    const qty = Number(form.quantity);
    const unitCost = Number(form.unitCost);
    const onHand = Number(currentStock);
    if (currentCost === null || currentStock === null) return null;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost <= 0) return null;
    if (!Number.isFinite(onHand) || onHand < 0) return null;
    const totalQty = onHand + qty;
    if (totalQty <= 0) return null;
    return ((Number(currentCost) * onHand) + (unitCost * qty)) / totalQty;
  }, [currentCost, currentStock, form.quantity, form.unitCost]);
  const topSuppliers = listMeta.topSuppliers;
  const supplierOpenSummary = useMemo(
    () => listMeta.supplierOpenSummary.map((entry) => ({
      ...entry,
      oldestExpected: entry.oldestExpected ? new Date(entry.oldestExpected) : null,
    })),
    [listMeta.supplierOpenSummary],
  );
  const staleOpenSummary = listMeta.staleOpenSummary;
  const tableColSpan = 9
    + (showSupplierCol ? 1 : 0)
    + (showReasonCol ? 1 : 0)
    + (showNoteCol ? 1 : 0);
  const hasActiveScope =
    quickView !== "all" ||
    expectedWindow !== "all" ||
    expectedSort !== "none" ||
    openOnly ||
    Boolean(
      filters.status ||
      filters.supplier ||
      filters.product ||
      filters.q ||
      filters.start ||
      filters.end ||
      filters.purchaseId ||
      filters.paymentId,
    );
  const showReceivingRuleBanner =
    quickCounts.pendingApproval > 0 ||
    listMeta.supplierOpenSummary.length > 0;

  const totalPages = Math.max(1, Math.ceil((listMeta.total || 0) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visiblePages = useMemo(() => {
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, start + 4);
    const pages: number[] = [];
    for (let p = start; p <= end; p += 1) pages.push(p);
    return pages;
  }, [currentPage, totalPages]);
  const paginatedRows = rows;

  const visibleIds = paginatedRows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());
  const selectByCondition = async (mode: "pending" | "open" | "overdue") => {
    // When paginating, rows only contains the current page. Fetch all matching
    // IDs from the server so the selection spans every page.
    if (totalPages > 1) {
      try {
        const params = new URLSearchParams();
        if (filters.start) params.append("start", filters.start);
        if (filters.end) params.append("end", filters.end);
        if (filters.supplier) params.append("supplier", filters.supplier);
        if (filters.q) params.append("q", filters.q);
        if (filters.product) params.append("product", filters.product);
        if (filters.status) params.append("status", filters.status);
        if (filters.purchaseId) params.append("purchaseId", filters.purchaseId);
        if (filters.paymentId) params.append("paymentId", filters.paymentId);
        if (quickView !== "all") params.append("quickView", quickView);
        if (expectedWindow !== "all") params.append("expectedWindow", expectedWindow);
        if (expectedSort !== "none") params.append("expectedSort", expectedSort);
        if (openOnly) params.append("openOnly", "1");
        params.append("format", "ids");
        params.append("condition", mode);
        const res = await fetch(`/api/admin/purchases?${params.toString()}`);
        if (res.ok) {
          const data = await res.json().catch(() => ({})) as { ids?: string[] };
          if (Array.isArray(data.ids)) {
            setSelectedIds(new Set(data.ids));
            return;
          }
        }
      } catch {
        // fall through to local filter
      }
    }
    // Single page — filter directly from current rows.
    const ids = rows
      .filter((row) => {
        if (mode === "pending") return String(row.status || "").toUpperCase() === "PENDING_APPROVAL";
        if (mode === "open") return isAwaitingReceive(row);
        return getExpectedUrgency(row)?.tone === "danger";
      })
      .map((row) => row.id);
    setSelectedIds(new Set(ids));
  };
  const selectedRowsForBulk = useMemo(
    () => rows.filter((r) => selectedIds.has(r.id)),
    [rows, selectedIds],
  );
  const selectedPendingCount = selectedRowsForBulk.filter(
    (row) => String(row.status || "").toUpperCase() === "PENDING_APPROVAL",
  ).length;
  const selectedOpenCount = selectedRowsForBulk.filter((row) => isAwaitingReceive(row)).length;
  const selectedReturnableCount = selectedRowsForBulk.filter((row) => Number(row.receivedQuantity ?? 0) > 0).length;
  const selectedMissingSupplierCount = selectedRowsForBulk.filter(
    (row) => !String(row.supplierId || "").trim() && !String(row.supplier || "").trim(),
  ).length;

  const exportSelected = () => {
    const selectedRows = rows.filter((r) => selectedIds.has(r.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one purchase to export.");
      return;
    }
    const header = ["Date", "Product", "SKU", "Qty", "Received", "Status", "Unit Cost", "Total", "Supplier", "Reason", "Note"];
    const lines = [header.join(",")];
    for (const r of selectedRows) {
      lines.push([
        JSON.stringify(new Date(r.createdAt).toISOString()),
        JSON.stringify(r.productName || ""),
        JSON.stringify(r.productSku || ""),
        String(r.quantity),
        JSON.stringify(`${Number(r.receivedQuantity ?? r.quantity)} / ${Number(r.orderedQuantity ?? r.quantity)}`),
        JSON.stringify(r.status || "RECEIVED"),
        Number(r.unitCost || 0).toFixed(2),
        Number(r.total || 0).toFixed(2),
        JSON.stringify(r.supplier || ""),
        JSON.stringify(r.reason || ""),
        JSON.stringify(r.note || ""),
      ].join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `purchases_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "purchases",
      format: "CSV",
      fileName: filename,
      sourcePage: "admin/purchases",
      rowCount: selectedRows.length,
      columnCount: header.length,
      byteSize: blob.size,
      resultSummary: `Purchases CSV export downloaded (${selectedRows.length} selected rows).`,
      scopeSnapshot: "Selected purchases export",
    });
  };

  const openSaveFilterDialog = () => {
    setSaveFilterName("");
    setSaveFilterOpen(true);
  };

  const saveCurrentFilter = () => {
    const name = saveFilterName.trim();
    if (!name) return;
    const entry: PurchasesSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        start: filters.start,
        end: filters.end,
        supplier: filters.supplier,
        q: filters.q,
        product: filters.product,
        status: filters.status,
        purchaseId: filters.purchaseId,
        paymentId: filters.paymentId,
        quickView,
        expectedWindow,
        expectedSort,
        openOnly,
        pageSize,
        showSupplierCol,
        showReasonCol,
        showNoteCol,
      },
    };
    setSavedFilters((prev) => [entry, ...prev]);
    setSaveFilterOpen(false);
    setSaveFilterName("");
    toast.success("Saved filter");
  };

  const applySavedFilter = (entry: PurchasesSavedFilter) => {
    const s = entry.state;
    setFilters({
      start: s.start,
      end: s.end,
      supplier: s.supplier,
      q: s.q,
      product: s.product,
      status: s.status,
      purchaseId: s.purchaseId || "",
      paymentId: s.paymentId || "",
    });
    setQuickView(s.quickView || "all");
    setExpectedWindow(s.expectedWindow || "all");
    setExpectedSort(s.expectedSort || "none");
    setOpenOnly(Boolean(s.openOnly));
    setPageSize(s.pageSize);
    setShowSupplierCol(s.showSupplierCol);
    setShowReasonCol(s.showReasonCol);
    setShowNoteCol(s.showNoteCol);
    setPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const resetPurchasesScope = () => {
    setFilters({ start: "", end: "", supplier: "", q: "", product: "", status: "", purchaseId: "", paymentId: "" });
    setQuickView("all");
    setExpectedWindow("all");
    setExpectedSort("none");
    setOpenOnly(false);
    setPage(1);
    setForm((prev) => ({ ...prev, productId: "", productSearch: "" }));
    lastFormProductId.current = "";
  };

  const approvePurchase = async (purchaseId: string) => {
    try {
      const res = await fetch(`/api/admin/purchases/${purchaseId}/approve`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to approve purchase.");
      toast.success("Purchase approved.");
      setFilters((prev) => {
        if (prev.status === "PENDING_APPROVAL" || prev.purchaseId === purchaseId) {
          return { ...prev, status: "", purchaseId: "" };
        }
        return prev;
      });
      fetchPurchases();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to approve purchase.");
    }
  };
  const bulkApproveSelected = async () => {
    if (!isAdmin) {
      toast.error("Only admins can approve purchases.");
      return;
    }
    if (!selectedIds.size) {
      toast.error("Select at least one pending approval purchase.");
      return;
    }
    let success = 0;
    let failed = 0;
    const details: string[] = [];
    for (const id of Array.from(selectedIds)) {
      try {
        const res = await fetch(`/api/admin/purchases/${id}/approve`, { method: "POST" });
        // Server returns 400 for non-pending — count as skipped, not failed
        if (res.status === 400) continue;
        if (!res.ok) throw new Error(`${id}: approve failed`);
        success += 1;
      } catch (err) {
        failed += 1;
        details.push(err instanceof Error ? err.message : `${id}: approve failed`);
      }
    }
    if (success === 0 && failed === 0) {
      toast.info("No pending approval purchases in selection.");
      return;
    }
    if (success > 0) toast.success(`Approved ${success} purchase${success === 1 ? "" : "s"}.`);
    if (failed > 0) toast.error(`Failed to approve ${failed} purchase${failed === 1 ? "" : "s"}.`);
    setBulkSummary({ open: true, title: "Bulk approve result", success, failed, details });
    clearSelection();
    fetchPurchases();
  };
  const updateExpectedDate = async (row: PurchaseRow) => {
    const value = expectedDraftById[row.id] ?? "";
    setUpdatingExpectedId(row.id);
    try {
      const res = await fetch(`/api/admin/purchases/${row.id}/expected-date`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedAt: value || null }),
      });
      const data = await res.json().catch(() => ({} as { error?: string; expectedAt?: string | null }));
      if (!res.ok) throw new Error(data.error || "Failed to update expected date.");
      setRows((prev) =>
        prev.map((item) => (item.id === row.id ? { ...item, expectedAt: data.expectedAt || null } : item)),
      );
      toast.success("Expected date updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update expected date.");
    } finally {
      setUpdatingExpectedId(null);
    }
  };
  const applyBulkExpectedDate = async () => {
    if (!canManagePurchases) {
      toast.error("Only admins can update expected dates.");
      return;
    }
    if (!bulkExpectedDate) {
      toast.error("Select a date first.");
      return;
    }
    if (!selectedIds.size) {
      toast.error("Select at least one open purchase row.");
      return;
    }
    setBulkExpectedUpdating(true);
    let success = 0;
    let failed = 0;
    const details: string[] = [];
    for (const id of Array.from(selectedIds)) {
      try {
        const res = await fetch(`/api/admin/purchases/${id}/expected-date`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedAt: bulkExpectedDate }),
        });
        if (!res.ok && res.status === 400) continue;
        if (!res.ok) throw new Error(`${id}: expected date update failed`);
        success += 1;
      } catch (err) {
        failed += 1;
        details.push(err instanceof Error ? err.message : `${id}: expected date update failed`);
      }
    }
    if (success === 0 && failed === 0) {
      toast.info("No open purchases in selection to update.");
      setBulkExpectedUpdating(false);
      return;
    }
    if (success > 0) toast.success(`Updated expected date for ${success} purchase${success === 1 ? "" : "s"}.`);
    if (failed > 0) toast.error(`Failed to update ${failed} purchase${failed === 1 ? "" : "s"}.`);
    setBulkSummary({ open: true, title: "Bulk expected-date update result", success, failed, details });
    setBulkExpectedUpdating(false);
    fetchPurchases();
  };
  const confirmBulkReceive = async () => {
    const targets = selectedRowsForBulk.filter((row) => isAwaitingReceive(row));
    const scopedTargets =
      bulkReceiveRule === "remaining_only"
        ? targets.filter((row) => Number(row.receivedQuantity ?? 0) > 0)
        : targets;
    if (!scopedTargets.length) {
      toast.error("No eligible open purchases selected.");
      return;
    }
    setBulkReceiveSubmitting(true);
    let success = 0;
    let failed = 0;
    const details: string[] = [];
    for (const row of scopedTargets) {
      const ordered = Number(row.orderedQuantity ?? row.quantity);
      const received = Number(row.receivedQuantity ?? 0);
      const remaining = Math.max(0, ordered - received);
      if (remaining <= 0) continue;
      try {
        const res = await fetch(`/api/admin/purchases/${row.id}/receive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: remaining }),
        });
        if (!res.ok) throw new Error(`${row.id}: receive failed`);
        success += 1;
      } catch (err) {
        failed += 1;
        details.push(err instanceof Error ? err.message : `${row.id}: receive failed`);
      }
    }
    if (success > 0) toast.success(`Bulk receive completed for ${success} purchase${success === 1 ? "" : "s"}.`);
    if (failed > 0) toast.error(`${failed} purchase${failed === 1 ? "" : "s"} failed (likely lot/expiry required).`);
    setBulkSummary({ open: true, title: "Bulk receive result", success, failed, details });
    setBulkReceiveSubmitting(false);
    setBulkReceiveOpen(false);
    clearSelection();
    fetchPurchases();
  };
  const confirmBulkReturn = async () => {
    const reason = bulkReturnReason.trim();
    if (!reason) {
      toast.error("Return reason is required.");
      return;
    }
    const targets = selectedRowsForBulk.filter((row) => Number(row.receivedQuantity ?? 0) > 0);
    if (!targets.length) {
      toast.error("No returnable purchases selected.");
      return;
    }
    setBulkReturnSubmitting(true);
    let success = 0;
    let failed = 0;
    const details: string[] = [];
    for (const row of targets) {
      const qty = Number(row.receivedQuantity ?? 0);
      if (qty <= 0) continue;
      try {
        const res = await fetch(`/api/admin/purchases/${row.id}/return`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: qty, note: reason }),
        });
        if (!res.ok) throw new Error(`${row.id}: return failed`);
        success += 1;
      } catch (err) {
        failed += 1;
        details.push(err instanceof Error ? err.message : `${row.id}: return failed`);
      }
    }
    if (success > 0) toast.success(`Bulk return completed for ${success} purchase${success === 1 ? "" : "s"}.`);
    if (failed > 0) toast.error(`${failed} purchase${failed === 1 ? "" : "s"} failed to return.`);
    setBulkSummary({ open: true, title: "Bulk return result", success, failed, details });
    setBulkReturnSubmitting(false);
    setBulkReturnOpen(false);
    setBulkReturnReason("");
    clearSelection();
    fetchPurchases();
  };
  const applyBulkSupplier = async () => {
    if (!bulkSupplierId) {
      toast.error("Select supplier first.");
      return;
    }
    const targets = selectedRowsForBulk
      .filter((row) => !String(row.supplierId || "").trim() && !String(row.supplier || "").trim())
      .map((row) => row.id);
    if (!targets.length) {
      toast.error("No selected rows with missing supplier.");
      return;
    }
    setBulkSupplierSubmitting(true);
    try {
      const undoRows = selectedRowsForBulk
        .filter((row) => targets.includes(row.id))
        .map((row) => ({ id: row.id, supplierId: row.supplierId ?? null, supplier: row.supplier ?? null }));
      const res = await fetch(`/api/admin/purchases/bulk-supplier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseIds: targets, supplierId: bulkSupplierId }),
      });
      const data = await res.json().catch(() => ({} as { error?: string; updatedCount?: number }));
      if (!res.ok) throw new Error(data.error || "Failed to update supplier.");
      toast.success(`Assigned supplier for ${Number(data.updatedCount || 0)} purchase(s).`);
      setBulkSummary({
        open: true,
        title: "Bulk supplier assignment result",
        success: Number(data.updatedCount || 0),
        failed: Math.max(0, targets.length - Number(data.updatedCount || 0)),
        details: [],
      });
      setLastBulkSupplierUndoRows(undoRows);
      clearSelection();
      fetchPurchases();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update supplier.");
    } finally {
      setBulkSupplierSubmitting(false);
    }
  };
  const undoLastBulkSupplierAssign = async () => {
    if (!lastBulkSupplierUndoRows.length) {
      toast.error("No bulk supplier assignment to undo.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/purchases/bulk-supplier/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: lastBulkSupplierUndoRows }),
      });
      const data = await res.json().catch(() => ({} as { error?: string; restoredCount?: number }));
      if (!res.ok) throw new Error(data.error || "Failed to undo supplier assignment.");
      toast.success(`Undo completed for ${Number(data.restoredCount || 0)} purchase(s).`);
      setLastBulkSupplierUndoRows([]);
      fetchPurchases();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to undo supplier assignment.");
    }
  };

  const openApproveDialog = (row: PurchaseRow) => {
    setApproveTarget(row);
    setApproveOpen(true);
  };

  const confirmApprove = async () => {
    if (!approveTarget) return;
    await approvePurchase(approveTarget.id);
    setApproveOpen(false);
    setApproveTarget(null);
  };

  const openReceiveDialog = (row: PurchaseRow) => {
    if (!canManagePurchases) {
      toast.error("Only admins can receive purchases.");
      return;
    }
    const ordered = Number(row.orderedQuantity ?? row.quantity);
    const received = Number(row.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    setReceiveRow(row);
    setReceiveQty(String(remaining));
    setReceiveLotCode("");
    setReceiveExpiry("");
    setReceiveLotNotes("");
    setReceiveErrors({});
    setReceiveOpen(true);
  };

  const confirmReceive = async () => {
    if (!receiveRow) return;
    const qty = Number(receiveQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Enter a valid quantity.");
      return;
    }
    const nextReceiveErrors: { lotCode?: string; expiryDate?: string } = {};
    const regulated = Boolean(receiveRow.requiresLotTracking || receiveRow.requiresExpiryDate);
    if (regulated && !receiveLotCode.trim()) {
      nextReceiveErrors.lotCode = "Lot/Batch code is required for this product.";
    }
    if (regulated && !receiveExpiry) {
      nextReceiveErrors.expiryDate = "Expiry date is required for this product.";
    }
    if (nextReceiveErrors.lotCode || nextReceiveErrors.expiryDate) {
      setReceiveErrors(nextReceiveErrors);
      return;
    }
    setReceiveErrors({});
    try {
      const res = await fetch(`/api/admin/purchases/${receiveRow.id}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: qty,
          lotCode: receiveLotCode.trim() || undefined,
          expiryDate: receiveExpiry || undefined,
          lotNotes: receiveLotNotes.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to receive purchase.");
      toast.success("Purchase received.");
      setReceiveOpen(false);
      setReceiveRow(null);
      setReceiveQty("");
      fetchPurchases();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to receive purchase.");
    }
  };

  const openReturnDialog = (row: PurchaseRow) => {
    if (!canManagePurchases) {
      toast.error("Only admins can return purchases to suppliers.");
      return;
    }
    const received = Number(row.receivedQuantity ?? 0);
    if (received <= 0) {
      toast.error("No received quantity available to return.");
      return;
    }
    setReturnRow(row);
    setReturnQty(String(received));
    setReturnLotCode("");
    setReturnNotes("");
    setReturnOpen(true);
  };

  const openCancelDialog = (row: PurchaseRow) => {
    if (!canManagePurchases) {
      toast.error("Only admins can cancel purchases.");
      return;
    }
    if (!isCancelablePurchase(row)) {
      toast.error("Only open purchases without received stock can be cancelled.");
      return;
    }
    setCancelTarget(row);
    setCancelOpen(true);
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setCancelSubmitting(true);
    try {
      const res = await fetch(`/api/admin/purchases/${cancelTarget.id}/cancel`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(payload.error || "Failed to cancel purchase.");
      toast.success("Purchase cancelled.");
      setCancelOpen(false);
      setCancelTarget(null);
      fetchPurchases();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to cancel purchase.");
    } finally {
      setCancelSubmitting(false);
    }
  };

  const confirmReturn = async () => {
    if (!returnRow) return;
    const qty = Number(returnQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Enter a valid return quantity.");
      return;
    }
    const received = Number(returnRow.receivedQuantity ?? 0);
    if (qty > received) {
      toast.error("Return quantity cannot exceed received quantity.");
      return;
    }
    setReturnSubmitting(true);
    try {
      const res = await fetch(`/api/admin/purchases/${returnRow.id}/return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: qty,
          lotCode: returnLotCode.trim() || undefined,
          note: returnNotes.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to return purchase.");
      toast.success("Returned to supplier.");
      setReturnOpen(false);
      setReturnRow(null);
      setReturnQty("");
      fetchPurchases();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to return purchase.");
    } finally {
      setReturnSubmitting(false);
    }
  };

  const handleExport = async () => {
    const params = new URLSearchParams();
    if (filters.start) params.append("start", filters.start);
    if (filters.end) params.append("end", filters.end);
    if (filters.supplier) params.append("supplier", filters.supplier);
    if (filters.q) params.append("q", filters.q);
    if (filters.product) params.append("product", filters.product);
    if (filters.status) params.append("status", filters.status);
    if (filters.purchaseId) params.append("purchaseId", filters.purchaseId);
    if (filters.paymentId) params.append("paymentId", filters.paymentId);
    if (quickView !== "all") params.append("quickView", quickView);
    if (expectedWindow !== "all") params.append("expectedWindow", expectedWindow);
    if (expectedSort !== "none") params.append("expectedSort", expectedSort);
    if (openOnly) params.append("openOnly", "1");
    params.append("format", "csv");
    const res = await fetch(`/api/admin/purchases?${params.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    const filename = `purchases_${Date.now()}.csv`;
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    void logAdminExportDownload({
      area: "purchases",
      format: "CSV",
      fileName: filename,
      sourcePage: "admin/purchases",
      byteSize: blob.size,
      resultSummary: "Purchases CSV export downloaded.",
      scopeSnapshot: `Status: ${filters.status || "all"} | Supplier: ${filters.supplier || "all"} | Product query: ${filters.product || "-"}`,
    });
  };

  const handleExportSummaryCsv = () => {
    const lines = [
      ["Metric", "Value"].join(","),
      ["Scope", JSON.stringify(`Quick view: ${quickView.replace(/_/g, " ")} | Expected: ${expectedWindow.replace(/_/g, " ")} | Open only: ${openOnly ? "yes" : "no"} | Sort: ${expectedSort}`)].join(","),
      ["Records", String(listMeta.total)].join(","),
      ["Total qty", String(viewTotals.qty)].join(","),
      ["Total value", Number(viewTotals.value || 0).toFixed(2)].join(","),
      ["Average unit cost", viewTotals.qty > 0 ? Number(avgUnitCostView).toFixed(2) : "0.00"].join(","),
      ["Pending approvals", String(quickCounts.pendingApproval)].join(","),
      ["Awaiting receive", String(quickCounts.awaitingReceive)].join(","),
      ["Due today", String(quickCounts.dueToday)].join(","),
      ["Overdue", String(quickCounts.overdue)].join(","),
      "",
      ["Status", "Count"].join(","),
      ...listMeta.statusCounts.map(({ status, count }) => [JSON.stringify(toTitleCase(formatStatusLabel(status))), String(count)].join(",")),
    ];
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `purchases_summary_${quickView}_${expectedWindow}_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "purchases-summary",
      format: "CSV",
      fileName: filename,
      sourcePage: "admin/purchases",
      rowCount: lines.length - 1,
      columnCount: 2,
      byteSize: blob.size,
      resultSummary: "Purchases summary CSV export downloaded.",
      scopeSnapshot: `Quick view: ${quickView} | Expected: ${expectedWindow} | Open only: ${openOnly ? "yes" : "no"}`,
    });
  };

  const handleExportSummaryPdf = async () => {
    try {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const pageRef = pdf.addPage([595, 842]); // A4 portrait
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const margin = 40;
      let y = 800;
      const line = 18;
      const formatMoney = (value: number) =>
        `GHS ${Number(value || 0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
      const rowsData: Array<[string, string]> = [
        ["Scope", `Quick view: ${quickView.replace(/_/g, " ")} | Expected: ${expectedWindow.replace(/_/g, " ")} | Open only: ${openOnly ? "yes" : "no"} | Sort: ${expectedSort}`],
        ["Generated", new Date().toLocaleString()],
        ["Records", String(listMeta.total)],
        ["Total qty", String(viewTotals.qty)],
        ["Total value", formatMoney(viewTotals.value)],
        ["Average unit cost", viewTotals.qty > 0 ? formatMoney(avgUnitCostView) : "GHS 0.00"],
        ["Pending approvals", String(quickCounts.pendingApproval)],
        ["Awaiting receive", String(quickCounts.awaitingReceive)],
        ["Due today", String(quickCounts.dueToday)],
        ["Overdue", String(quickCounts.overdue)],
      ];
      pageRef.drawText("Purchases - Summary Snapshot", { x: margin, y, size: 16, font: bold });
      y -= 26;
      for (const [label, value] of rowsData) {
        if (y < 90) break;
        pageRef.drawText(label, { x: margin, y, size: 10, font: bold });
        pageRef.drawText(value, { x: 250, y, size: 10, font });
        y -= line;
      }
      y -= 8;
      pageRef.drawText("Status breakdown", { x: margin, y, size: 11, font: bold });
      y -= line;
      if (listMeta.statusCounts.length === 0) {
        pageRef.drawText("No rows in current view.", { x: margin, y, size: 10, font });
      } else {
        for (const { status: statusNameRaw, count } of listMeta.statusCounts) {
          if (y < 60) break;
          const statusName = toTitleCase(formatStatusLabel(statusNameRaw));
          pageRef.drawText(statusName, { x: margin, y, size: 10, font });
          pageRef.drawText(String(count), { x: 250, y, size: 10, font });
          y -= line;
        }
      }

      const bytes = await pdf.save();
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const filename = `purchases_summary_${quickView}_${expectedWindow}_${Date.now()}.pdf`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await logAdminExportDownload({
        area: "purchases-summary",
        format: "PDF",
        fileName: filename,
        sourcePage: "admin/purchases",
        rowCount: rowsData.length + listMeta.statusCounts.length,
        columnCount: 2,
        byteSize: blob.size,
        resultSummary: "Purchases summary PDF export downloaded.",
        scopeSnapshot: `Quick view: ${quickView} | Expected: ${expectedWindow} | Open only: ${openOnly ? "yes" : "no"}`,
      });
      toast.success("Summary PDF downloaded.");
    } catch (error) {
      console.error("Purchases summary PDF export failed", error);
      toast.error("Failed to generate summary PDF.");
    }
  };

  async function submitPurchase(e: React.FormEvent) {
    e.preventDefault();
    if (!canManagePurchases) {
      setError("Only admins can create purchases.");
      return;
    }
    const nextErrors: {
      productId?: string;
      quantity?: string;
      unitCost?: string;
      supplier?: string;
      lotCode?: string;
      expiryDate?: string;
      paymentMethod?: string;
    } = {};
    const qty = Number(form.quantity);
    const unitCost = Number(form.unitCost);
    if (!form.productId) nextErrors.productId = "Select a product.";
    if (!form.quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
      nextErrors.quantity = "Enter a valid quantity.";
    }
    if (!form.unitCost.trim() || !Number.isFinite(unitCost) || unitCost <= 0) {
      nextErrors.unitCost = "Enter a valid unit cost.";
    }
    const supplierName = form.supplier.trim();
    if (!form.supplierId && !supplierName) {
      nextErrors.supplier = "Select or enter a supplier.";
    } else if (!form.supplierId && supplierName.toLowerCase() === "unknown") {
      nextErrors.supplier = "Please enter a real supplier.";
    }
    if (form.receiveNow && selectedProduct) {
      const regulated = Boolean(selectedProduct.requiresLotTracking || selectedProduct.requiresExpiryDate);
      if (regulated && !form.lotCode.trim()) {
        nextErrors.lotCode = "Lot/Batch code is required for this product.";
      }
      if (regulated && !form.expiryDate) {
        nextErrors.expiryDate = "Expiry date is required for this product.";
      }
    }
    if (form.receiveNow && form.paidOnReceipt && !form.paymentMethod) {
      nextErrors.paymentMethod = "Select payment mode when Pay now is checked.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setFormErrors(nextErrors);
      setError(null);
      return;
    }
    setError(null);
    const basePayload = {
      productId: form.productId,
      quantity: Number(form.quantity),
      unitCost: Number(form.unitCost),
      supplier: supplierName || undefined,
      supplierId: form.supplierId || undefined,
      reason: form.reason.trim() || undefined,
      note: form.note.trim() || undefined,
      expectedAt: form.expectedAt || undefined,
      lotCode: form.lotCode.trim() || undefined,
      expiryDate: form.expiryDate || undefined,
      receiveNow: approvalRequiredForForm ? false : form.receiveNow,
      paidOnReceipt: approvalRequiredForForm ? false : form.paidOnReceipt,
      paymentMethod: form.paymentMethod || undefined,
      highValueCreditOnly: highValueCreditOnlyForForm,
    };
    if (highValueCreditOnlyForForm) {
      basePayload.paidOnReceipt = false;
      basePayload.paymentMethod = undefined;
    }
    setPendingPurchasePayload(basePayload);
    setPurchaseConfirmOpen(true);
  }

  const confirmCreatePurchase = async () => {
    if (!pendingPurchasePayload) {
      toast.error("No pending purchase to confirm.");
      return;
    }
    setPurchaseSubmitting(true);
    try {
      let res = await fetch(`/api/admin/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingPurchasePayload),
      });
      if (!res.ok) {
        let payload: { error?: string } = {};
        try { payload = await res.json(); } catch {}
        const msg = typeof payload?.error === "string" ? payload.error : "Failed to save purchase";
        if (msg.toLowerCase().includes("approval required before receiving")) {
          res = await fetch(`/api/admin/purchases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...pendingPurchasePayload,
              receiveNow: false,
              paidOnReceipt: false,
            }),
          });
          if (!res.ok) {
            let retryPayload: { error?: string } = {};
            try { retryPayload = await res.json(); } catch {}
            const retryMsg =
              typeof retryPayload?.error === "string"
                ? retryPayload.error
                : "Failed to save purchase";
            setError(retryMsg);
            return;
          }
        } else {
          const lower = msg.toLowerCase();
          if (lower.includes("lot/batch code")) {
            setFormErrors((prev) => ({ ...prev, lotCode: msg }));
          } else if (lower.includes("expiry date")) {
            setFormErrors((prev) => ({ ...prev, expiryDate: msg }));
          } else if (lower.includes("payment mode")) {
            setFormErrors((prev) => ({ ...prev, paymentMethod: msg }));
          } else if (lower.includes("supplier")) {
            setFormErrors((prev) => ({ ...prev, supplier: msg }));
          }
          setError(msg);
          return;
        }
      }
      const payload = await res.json().catch(
        () => ({} as { newCost?: number; status?: string; purchaseId?: string; highValueCreditOnly?: boolean }),
      );
      if (payload && typeof payload.newCost === "number") {
        setCurrentCost(payload.newCost);
      }
      if (payload?.status === "PENDING_APPROVAL") {
        toast.info("Purchase created and submitted for approval.");
        setFilters((prev) => ({
          ...prev,
          status: "PENDING_APPROVAL",
          purchaseId: payload.purchaseId || "",
        }));
        setPage(1);
      } else if (pendingPurchasePayload.receiveNow === false) {
        toast.success("Purchase order created. Receive items when they arrive.");
      } else if (payload?.highValueCreditOnly || pendingPurchasePayload.highValueCreditOnly) {
        toast.info("High-value purchase received on credit. Record payment after approval.");
      }
      setForm({ ...EMPTY_PURCHASE_FORM });
      setPurchaseFormOpen(false);
      setFormErrors({});
      setPurchaseConfirmOpen(false);
      setPendingPurchasePayload(null);
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(PURCHASES_DRAFT_KEY);
      }
      setDraftAvailableAt(null);
      setPendingDraft(null);
      fetchPurchases();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save purchase");
    } finally {
      setPurchaseSubmitting(false);
    }
  };

  useEffect(() => {
    setPage(1);
  }, [quickView, expectedWindow, expectedSort, openOnly]);
  useEffect(() => {
    setPage(1);
  }, [filters.start, filters.end, filters.supplier, filters.q, filters.product, filters.status, filters.purchaseId, filters.paymentId, pageSize]);
  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);
  useEffect(() => {
    if (!filtersAreClear) return;
    if (!hasScopedViewMismatch) return;
    if (quickView === "all" && expectedWindow === "all") return;
    setQuickView("all");
    setExpectedWindow("all");
    setExpectedSort("none");
    setOpenOnly(false);
  }, [filtersAreClear, hasScopedViewMismatch, quickView, expectedWindow]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle className="text-base font-semibold">Purchases</CardTitle>
          <p className="text-sm text-muted-foreground">Record restocks and update weighted-average cost</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button className="w-full sm:w-auto" onClick={openPurchaseFormPanel}>
            {purchaseFormOpen ? "Add purchase" : "Open add purchase"}
          </Button>
          {isAdmin ? (
            <Button asChild className="w-full sm:w-auto" variant="outline">
              <Link href="/admin/audit?sourcePage=admin%2Fpurchases">
                View Audit Log
              </Link>
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="w-full sm:w-auto" variant="outline">Export</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExport}>Export CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportSummaryCsv}>Export summary CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportSummaryPdf}>Export summary PDF</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
          {error && (
            <div className="mb-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
        {hasActiveScope ? (
          <div
            className="sticky z-40 flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-background p-2 text-xs shadow-md"
            style={{ top: "var(--admin-nav-height, 4rem)" }}
          >
            <span className="font-medium text-foreground">Active scope</span>
            {quickView !== "all" ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setQuickView("all")}>
                Quick view: {quickView.replace(/_/g, " ")} x
              </Button>
            ) : null}
            {expectedWindow !== "all" ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setExpectedWindow("all")}>
                Expected: {expectedWindow.replace(/_/g, " ")} x
              </Button>
            ) : null}
            {expectedSort !== "none" ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setExpectedSort("none")}>
                Sort: {expectedSort.replace(/_/g, " ")} x
              </Button>
            ) : null}
            {openOnly ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setOpenOnly(false)}>
                Open only x
              </Button>
            ) : null}
            {filters.status ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, status: "" }))}>
                Status: {formatStatusLabel(filters.status)} x
              </Button>
            ) : null}
            {filters.supplier ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, supplier: "" }))}>
                Supplier: {filters.supplier} x
              </Button>
            ) : null}
            {filters.product ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, product: "" }))}>
                Product filter x
              </Button>
            ) : null}
            {filters.q ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, q: "" }))}>
                Search: {filters.q} x
              </Button>
            ) : null}
            {filters.start || filters.end ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, start: "", end: "" }))}>
                Date range x
              </Button>
            ) : null}
            {filters.purchaseId ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, purchaseId: "" }))}>
                Purchase: {filters.purchaseId} x
              </Button>
            ) : null}
            {filters.paymentId ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setFilters((prev) => ({ ...prev, paymentId: "" }))}>
                Payment: {filters.paymentId} x
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={resetPurchasesScope}
            >
              Reset all
            </Button>
          </div>
        ) : null}
        {filters.purchaseId || filters.paymentId ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">Exact source filter active:</span>{" "}
            {filters.purchaseId ? filters.purchaseId : `payment ${filters.paymentId}`}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-2 text-[11px]"
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  purchaseId: "",
                  paymentId: "",
                }))
              }
            >
              Clear
            </Button>
          </div>
        ) : null}
        <div className="rounded-md border bg-background p-3" id="purchase-form-panel">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Add purchase</p>
              <p className="text-xs text-muted-foreground">Keep this collapsed until you need to create a new purchase.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPurchaseFormOpen((prev) => !prev)}
            >
              {purchaseFormOpen ? "Hide form" : "Show form"}
            </Button>
          </div>
          {purchaseFormOpen ? (
          <form id="purchase-form" onSubmit={submitPurchase} className="mt-4 grid sm:grid-cols-2 lg:grid-cols-8 gap-2 items-end">
            <fieldset className="contents" disabled={!canManagePurchases}>
            <div className="sm:col-span-2 lg:col-span-2">
              <Label htmlFor="product">Product</Label>
              <div className="relative">
                <Input
                  id="product"
                  className={formErrors.productId ? "border-red-500" : ""}
                  value={form.productSearch}
                  onFocus={() => setProductPickerOpen(true)}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setForm((prev) => ({
                      ...prev,
                      productSearch: nextValue,
                      productId: prev.productId && nextValue !== getProductOptionLabel(selectedProduct) ? "" : prev.productId,
                    }));
                    setProductPickerOpen(true);
                    if (formErrors.productId) {
                      setFormErrors((prev) => ({ ...prev, productId: "" }));
                    }
                  }}
                  onBlur={() => {
                    window.setTimeout(() => setProductPickerOpen(false), 100);
                  }}
                  placeholder="Search products by name, SKU, brand, or category"
                  required
                  aria-invalid={!!formErrors.productId}
                  aria-expanded={productPickerOpen}
                  autoComplete="off"
                />
                {productPickerOpen ? (
                  <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-background shadow-lg">
                    {productPickerOptions.length > 0 ? (
                      productPickerOptions.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            selectProductOption(product);
                          }}
                        >
                          <span className="font-medium">{toTitleCase(product.name || "")}</span>
                          <span className="text-xs text-muted-foreground">
                            {product.sku || "No SKU"}
                            {product.brand ? ` | ${product.brand}` : ""}
                            {product.category ? ` | ${formatCategoryLabel(product.category)}` : ""}
                          </span>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No matching products</div>
                    )}
                  </div>
                ) : null}
              </div>
              {formErrors.productId && <p className="mt-1 text-xs text-red-600">{formErrors.productId}</p>}
            </div>
            <div className="sm:col-span-1 lg:col-span-1">
              <Label htmlFor="qty">Quantity</Label>
              <Input
                id="qty"
                type="number"
                min="1"
                value={form.quantity}
                onChange={(e) => {
                  setForm({ ...form, quantity: e.target.value });
                  if (formErrors.quantity) {
                    setFormErrors((prev) => ({ ...prev, quantity: "" }));
                  }
                }}
                required
                aria-invalid={!!formErrors.quantity}
                className={formErrors.quantity ? "border-red-500" : ""}
              />
              {formErrors.quantity && <p className="mt-1 text-xs text-red-600">{formErrors.quantity}</p>}
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <Label
                htmlFor="uc"
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>Unit Cost</span>
                {currentCost != null && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <span>
                      Current avg:{" "}
                      <span className="font-medium">
                        {Number(currentCost).toFixed(2)}
                      </span>
                    </span>
                    {variance &&
                      variance.pct !== null &&
                      Math.abs(variance.pct) >= 20 && (
                        <Tooltip
                          content={`Entered cost deviates ${variance.pct!.toFixed(
                            1,
                          )}% from current average`}
                        >
                          <span
                            className={`ml-1 font-medium ${
                              variance.pct! > 0
                                ? "text-red-600"
                                : "text-amber-600"
                            }`}
                          >
                            {variance.pct! > 0 ? "↑" : "↓"}{" "}
                            {Math.abs(variance.pct!).toFixed(1)}%
                          </span>
                        </Tooltip>
                      )}
                  </span>
                )}
              </Label>
              <Input
                id="uc"
                type="number"
                step="0.01"
                min="0"
                value={form.unitCost}
                onChange={(e) => {
                  setForm({ ...form, unitCost: e.target.value });
                  if (formErrors.unitCost) {
                    setFormErrors((prev) => ({ ...prev, unitCost: "" }));
                  }
                }}
                required
                aria-invalid={!!formErrors.unitCost}
                className={formErrors.unitCost ? "border-red-500" : ""}
              />
              {formErrors.unitCost && <p className="mt-1 text-xs text-red-600">{formErrors.unitCost}</p>}
            </div>
            <div className="sm:col-span-2 lg:col-span-2 space-y-1">
              <Label htmlFor="supplier">Supplier</Label>
              <Input
                id="supplier"
                list="purchase-supplier-options"
                className={formErrors.supplier ? "border-red-500" : ""}
                value={form.supplier}
                onChange={(e) => syncSupplierSelection(e.target.value)}
                onBlur={(e) => syncSupplierSelection(e.target.value)}
                placeholder="Select an existing supplier or type a new one"
              />
              <datalist id="purchase-supplier-options">
                {assignableSuppliers.map((s) => (
                  <option key={s.id} value={s.name} />
                ))}
              </datalist>
              {formErrors.supplier ? (
                <p className="mt-1 text-xs text-red-600">{formErrors.supplier}</p>
              ) : null}
            </div>
            <div className="sm:col-span-1 lg:col-span-1">
              <Label htmlFor="reason">Reason</Label>
              <Input
                id="reason"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Optional"
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <Label htmlFor="note">Note</Label>
              <Input id="note" value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <Label htmlFor="expectedAt">Expected arrival</Label>
              <Input
                id="expectedAt"
                type="date"
                value={form.expectedAt}
                onChange={(e) => setForm({ ...form, expectedAt: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-2 flex items-center gap-2 text-sm">
              <input
                id="receiveNow"
                type="checkbox"
                checked={form.receiveNow}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    receiveNow: e.target.checked,
                    paidOnReceipt: e.target.checked ? prev.paidOnReceipt : false,
                    paymentMethod: e.target.checked ? prev.paymentMethod : "",
                  }))
                }
                disabled={approvalRequiredForForm}
              />
              <Label htmlFor="receiveNow" className="cursor-pointer">Receive now</Label>
              {approvalRequiredForForm ? (
                <span className="text-xs text-amber-700">
                  Approval required before receiving. Purchase will be created as{" "}
                  <span className="font-medium">Pending approval</span>.{" "}
                  <Link href="/admin/purchases?status=PENDING_APPROVAL" className="underline">
                    Open pending approvals
                  </Link>
                </span>
              ) : null}
            </div>
            <div className="sm:col-span-2 lg:col-span-6 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex items-center gap-2">
                <input
                  id="paidOnReceipt"
                  type="checkbox"
                  checked={form.paidOnReceipt}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      paidOnReceipt: e.target.checked,
                      paymentMethod: e.target.checked ? prev.paymentMethod : "",
                    }))
                  }
                  disabled={!form.receiveNow || highValueCreditOnlyForForm}
                />
                <Label htmlFor="paidOnReceipt" className="cursor-pointer">Pay now</Label>
              </div>
              {!form.receiveNow ? (
                <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                  Enable Receive now to allow immediate payment.
                </p>
              ) : null}
              {highValueCreditOnlyForForm ? (
                <p className="text-xs text-amber-700 sm:col-span-2 lg:col-span-3">
                  High-value purchases are credit-only at receipt. Record payment after approval.
                </p>
              ) : null}
              {form.receiveNow || selectedProduct?.requiresLotTracking || selectedProduct?.requiresExpiryDate ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2 lg:col-span-2">
                    <div className="space-y-1">
                      <Label htmlFor="lotCode">Lot / Batch code</Label>
                      <Input
                        id="lotCode"
                        value={form.lotCode}
                        onChange={(e) => {
                          setForm({ ...form, lotCode: e.target.value });
                          if (formErrors.lotCode) {
                            setFormErrors((prev) => ({ ...prev, lotCode: "" }));
                          }
                        }}
                        placeholder={selectedProduct?.requiresLotTracking ? "Required for regulated SKU" : "Optional"}
                        className={formErrors.lotCode ? "border-red-500" : ""}
                      />
                      {formErrors.lotCode ? (
                        <p className="mt-1 text-xs text-red-600">{formErrors.lotCode}</p>
                      ) : null}
                      <p className="text-[11px] text-muted-foreground">
                        Supplier lot/batch label for traceability and expiry audits.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="expiryDate">Expiry date</Label>
                      <Input
                        id="expiryDate"
                        type="date"
                        value={form.expiryDate}
                        onChange={(e) => {
                          setForm({ ...form, expiryDate: e.target.value });
                          if (formErrors.expiryDate) {
                            setFormErrors((prev) => ({ ...prev, expiryDate: "" }));
                          }
                        }}
                        className={formErrors.expiryDate ? "border-red-500" : ""}
                      />
                      {formErrors.expiryDate ? (
                        <p className="mt-1 text-xs text-red-600">{formErrors.expiryDate}</p>
                      ) : null}
                    </div>
                  </div>
                  {selectedProduct?.requiresLotTracking || selectedProduct?.requiresExpiryDate ? (
                    <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
                      This SKU requires {describeTrackingRequirements(
                        selectedProduct.requiresLotTracking,
                        selectedProduct.requiresExpiryDate,
                      )}
                    </p>
                  ) : null}
                </>
              ) : null}
              {form.receiveNow && form.paidOnReceipt ? (
                <div className="space-y-1 sm:col-span-2 lg:col-span-1">
                  <Label htmlFor="paymentMethod">Payment mode</Label>
                  <select
                    id="paymentMethod"
                    className={`border rounded-md h-9 w-full bg-background ${formErrors.paymentMethod ? "border-red-500" : ""}`}
                    value={form.paymentMethod}
                    onChange={(e) => {
                      const next = e.target.value;
                      setForm((prev) => ({ ...prev, paymentMethod: next }));
                      if (formErrors.paymentMethod) {
                        setFormErrors((prev) => ({ ...prev, paymentMethod: "" }));
                      }
                    }}
                    disabled={highValueCreditOnlyForForm}
                    required
                  >
                    <option value="" disabled>
                      Select payment mode
                    </option>
                    <option value="cash">Cash</option>
                    <option value="transfer">Transfer</option>
                    <option value="bank">Bank</option>
                  </select>
                  {formErrors.paymentMethod ? (
                    <p className="mt-1 text-xs text-red-600">{formErrors.paymentMethod}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <Button className="w-full sm:w-auto" type="submit">Add Purchase</Button>
            </div>
            {selectedProduct ? (
              <div className="sm:col-span-2 lg:col-span-6 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {selectedProduct.category ? (
                  <span className="rounded-full border px-2 py-0.5">
                    Category: {formatCategoryLabel(selectedProduct.category)}
                  </span>
                ) : null}
                {selectedProduct.brand ? (
                  <span className="rounded-full border px-2 py-0.5">
                    Brand: {selectedProduct.brand}
                  </span>
                ) : null}
              </div>
            ) : null}
            </fieldset>
            {!canManagePurchases ? (
              <p className="sm:col-span-2 lg:col-span-6 text-xs text-muted-foreground">
                Admin only: purchase creation and receiving are restricted.
              </p>
            ) : null}
          </form>
          ) : (
            <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Use <span className="font-medium text-foreground">Show form</span> when you need to record a new purchase order or immediate receipt.
            </div>
          )}
        </div>
        {draftAvailableAt ? (
          <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>
                Unsaved purchase draft found from {new Date(draftAvailableAt).toLocaleTimeString()}.
              </span>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={restoreDraft}>
                  Restore Draft
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={clearDraft}>
                  Clear Draft
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input id="start" type="date" value={filters.start} onChange={(e) => setFilters({ ...filters, start: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input id="end" type="date" value={filters.end} onChange={(e) => setFilters({ ...filters, end: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="supplierFilter">Supplier</Label>
            <Input id="supplierFilter" value={filters.supplier} onChange={(e) => setFilters({ ...filters, supplier: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="productFilter">Product</Label>
            <select
              id="productFilter"
              className="border rounded-md h-9 w-full bg-background capitalize"
              value={filters.product}
              onChange={(e) => {
                const next = e.target.value;
                setFilters({ ...filters, product: next });
                if (!next) {
                  setForm((prev) => ({ ...prev, productId: "" }));
                  lastFormProductId.current = "";
                }
              }}
            >
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {toTitleCase(p.name || "")}{p.sku ? ` - ${p.sku}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="statusFilter">Status</Label>
            <select
              id="statusFilter"
              className="border rounded-md h-9 w-full bg-background"
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            >
              <option value="">All</option>
              <option value="PENDING_APPROVAL">Pending approval</option>
              <option value="APPROVED">Approved</option>
              <option value="ORDERED">Ordered</option>
              <option value="PARTIALLY_RECEIVED">Partially received</option>
              <option value="RECEIVED">Received</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div>
            <Label htmlFor="q">Search note/reason</Label>
            <Input id="q" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-2">
            <div className="text-xs text-muted-foreground">Top suppliers</div>
            {topSuppliers.length === 0 ? (
              <span className="text-xs text-muted-foreground">None</span>
            ) : (
              topSuppliers.map((supplier) => (
                <Button
                  key={supplier}
                  type="button"
                  size="sm"
                  variant={filters.supplier === supplier ? "default" : "outline"}
                  onClick={() => setFilters((prev) => ({ ...prev, supplier }))}
                >
                  {supplier}
                </Button>
              ))
            )}
            {filters.supplier ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setFilters((prev) => ({ ...prev, supplier: "" }))}
              >
                Clear
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={resetPurchasesScope}
            >
              Clear filters
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Filters persist on refresh. Use <span className="font-medium">Clear filters</span> to reset scope.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Purchases</div>
            <div className="text-lg font-semibold">{listMeta.total}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total qty</div>
            <div className="text-lg font-semibold">{viewTotals.qty}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total value</div>
            <div className="text-lg font-semibold">{formatCurrency(viewTotals.value)}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Avg unit cost</div>
            <div className="text-lg font-semibold">{viewTotals.qty ? formatCurrency(avgUnitCostView) : "-"}</div>
          </div>
        </div>

        <div className="rounded-md border p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Next actions</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={quickView === "all" ? "default" : "outline"} onClick={() => setQuickView("all")}>
              All ({listMeta.baseTotal})
            </Button>
            <Button type="button" size="sm" variant={quickView === "pending_approval" ? "default" : "outline"} onClick={() => setQuickView("pending_approval")}>
              Pending approval ({quickCounts.pendingApproval})
            </Button>
            <Button type="button" size="sm" variant={quickView === "awaiting_receive" ? "default" : "outline"} onClick={() => setQuickView("awaiting_receive")}>
              Awaiting receive ({quickCounts.awaitingReceive})
            </Button>
            <Button type="button" size="sm" variant={quickView === "due_today" ? "default" : "outline"} onClick={() => setQuickView("due_today")}>
              Due today ({quickCounts.dueToday})
            </Button>
            <Button type="button" size="sm" variant={quickView === "overdue" ? "default" : "outline"} onClick={() => setQuickView("overdue")}>
              Overdue ({quickCounts.overdue})
            </Button>
          </div>
          <div className="mt-3 mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Expected date window</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={expectedWindow === "all" ? "default" : "outline"} onClick={() => setExpectedWindow("all")}>
              All
            </Button>
            <Button type="button" size="sm" variant={expectedWindow === "missing" ? "default" : "outline"} onClick={() => setExpectedWindow("missing")}>
              No expected date ({expectedCounts.missing})
            </Button>
            <Button type="button" size="sm" variant={expectedWindow === "this_week" ? "default" : "outline"} onClick={() => setExpectedWindow("this_week")}>
              Expected this week ({expectedCounts.thisWeek})
            </Button>
            <Button type="button" size="sm" variant={expectedWindow === "next_7" ? "default" : "outline"} onClick={() => setExpectedWindow("next_7")}>
              Expected next 7 days ({expectedCounts.next7})
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Label htmlFor="expectedSort" className="text-xs text-muted-foreground">Sort expected</Label>
            <select
              id="expectedSort"
              className="h-8 rounded border bg-background px-2 text-xs"
              value={expectedSort}
              onChange={(e) => setExpectedSort(e.target.value as ExpectedSort)}
            >
              <option value="none">None</option>
              <option value="expected_oldest">Oldest first</option>
              <option value="expected_newest">Newest first</option>
              <option value="missing_first">Missing first</option>
            </select>
            <label className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
              />
              Open only
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>Urgency:</span>
            <span className="inline-flex rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-red-700">Overdue</span>
            <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-700">Due soon</span>
            <span className="inline-flex rounded-full border border-gray-300 bg-muted px-2 py-0.5">Expected</span>
          </div>
        </div>

        {supplierOpenSummary.length > 0 ? (
          <div className="rounded-md border p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open supplier summary</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {supplierOpenSummary.map((entry) => (
                <div key={entry.supplier} className="rounded-md border p-2 text-sm">
                  <div className="font-medium truncate">{entry.supplier}</div>
                  <div className="text-xs text-muted-foreground">Open qty: {entry.openQty}</div>
                  <div className="text-xs text-muted-foreground">Open value: {formatCurrency(entry.openValue)}</div>
                  <div className="text-xs text-muted-foreground">
                    Oldest expected: {entry.oldestExpected ? entry.oldestExpected.toLocaleDateString() : "-"}
                  </div>
                  <div className="text-xs text-muted-foreground">Overdue lines: {entry.overdueCount}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {staleOpenSummary.total > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900">
            <span className="font-medium">Stale open purchases:</span>{" "}
            {staleOpenSummary.missingExpected > 0 ? `${staleOpenSummary.missingExpected} missing expected date` : null}
            {staleOpenSummary.missingExpected > 0 && staleOpenSummary.overdue7Plus > 0 ? " | " : null}
            {staleOpenSummary.overdue7Plus > 0 ? `${staleOpenSummary.overdue7Plus} overdue by 7+ days` : null}
          </div>
        ) : null}

        {showReceivingRuleBanner ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-900">
            <span className="font-medium">Receiving rule:</span> purchases that require approval cannot be received until an admin approves them.
            {" "}
            <Link href="/admin/purchases?status=PENDING_APPROVAL" className="underline font-medium">
              Go to Pending Approvals
            </Link>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{loading ? "Loading..." : `${listMeta.total} record(s)`}</span>
            <span className="hidden sm:inline">•</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => fetchPurchases()}
            >
              Reload
            </Button>
            <span className="hidden sm:inline">•</span>
            <label className="flex items-center gap-1">
              <span className="text-xs">Rows per page:</span>
              <select
                className="h-7 rounded border bg-background px-1 text-xs"
                value={pageSize}
                onChange={(e) => {
                  const next = Number(e.target.value) as 25 | 50 | 100;
                  setPageSize(next);
                  setPage(1);
                }}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            {updatedAtText ? (
              <>
                <span className="hidden sm:inline">•</span>
                <span>Last updated {updatedAtText}</span>
              </>
            ) : null}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="w-full sm:w-auto">Columns</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showSupplierCol}
                  onCheckedChange={(value) => setShowSupplierCol(Boolean(value))}
                >
                  Supplier
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showReasonCol}
                  onCheckedChange={(value) => setShowReasonCol(Boolean(value))}
                >
                  Reason
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showNoteCol}
                  onCheckedChange={(value) => setShowNoteCol(Boolean(value))}
                >
                  Note
              </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="w-full sm:w-auto">Saved filters</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={openSaveFilterDialog}>
                  Save current filter
                </DropdownMenuItem>
                {savedFilters.length === 0 ? (
                  <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                ) : (
                  savedFilters.map((entry) => (
                    <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-4">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => applySavedFilter(entry)}
                      >
                        {entry.name}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeSavedFilter(entry.id);
                        }}
                      >
                        Remove
                      </Button>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {listMeta.total > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
            <span className="text-muted-foreground">Quick select:</span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void selectByCondition("pending")}>
              Select all pending approval
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void selectByCondition("open")}>
              Select all open
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => void selectByCondition("overdue")}>
              Select all overdue
            </Button>
            {lastBulkSupplierUndoRows.length > 0 ? (
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={undoLastBulkSupplierAssign}>
                Undo last supplier assign
              </Button>
            ) : null}
            {totalPages > 1 ? (
              <span className="text-muted-foreground">
                — Approve and set expected date apply across all pages. Receive, return, and supplier actions apply to the current page only.
              </span>
            ) : null}
          </div>
        ) : null}
        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{selectedCount} selected</span>
              <span className="text-xs text-muted-foreground">
                Pending: {selectedPendingCount} | Open: {selectedOpenCount} | Returnable: {selectedReturnableCount} | Missing supplier: {selectedMissingSupplierCount}
              </span>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto" onClick={clearSelection}>
                Clear
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedOpenCount > 0 ? (
                <div className="flex items-center gap-2 rounded border bg-background px-2 py-1">
                  <span className="text-xs text-muted-foreground">Expected</span>
                  <Input
                    type="date"
                    className="h-7 w-[160px]"
                    value={bulkExpectedDate}
                    onChange={(e) => setBulkExpectedDate(e.target.value)}
                    disabled={bulkExpectedUpdating || !canManagePurchases}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={applyBulkExpectedDate}
                    disabled={bulkExpectedUpdating || !canManagePurchases}
                  >
                    Apply date
                  </Button>
                </div>
              ) : null}
              {selectedPendingCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={bulkApproveSelected}
                  disabled={!isAdmin}
                >
                  Approve selected
                </Button>
              ) : null}
              {selectedOpenCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => setBulkReceiveOpen(true)}
                  disabled={!canManagePurchases}
                >
                  Receive selected
                </Button>
              ) : null}
              {selectedReturnableCount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => setBulkReturnOpen(true)}
                  disabled={!canManagePurchases}
                >
                  Return selected
                </Button>
              ) : null}
              {selectedMissingSupplierCount > 0 ? (
                <div className="flex items-center gap-2 rounded border bg-background px-2 py-1">
                  <span className="text-xs text-muted-foreground">Supplier</span>
                  <select
                    className="h-7 rounded border bg-background px-1 text-xs"
                    value={bulkSupplierId}
                    onChange={(e) => setBulkSupplierId(e.target.value)}
                    disabled={bulkSupplierSubmitting || !canManagePurchases}
                  >
                    <option value="">Select</option>
                    {assignableSuppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={applyBulkSupplier}
                    disabled={bulkSupplierSubmitting || !canManagePurchases}
                  >
                    Assign
                  </Button>
                </div>
              ) : null}
              <Button size="sm" className="w-full sm:w-auto" onClick={exportSelected}>
                Export CSV
              </Button>
            </div>
          </div>
        )}

        <div className="lg:hidden space-y-3">
          {listMeta.total === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>
                {hasScopedViewMismatch
                  ? "No purchases match the current quick-view/expected window."
                  : "No purchases found for the current filters."}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {hasScopedViewMismatch ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuickView("all");
                      setExpectedWindow("all");
                      setExpectedSort("none");
                      setOpenOnly(false);
                    }}
                  >
                    Reset view filters
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={resetPurchasesScope}
                >
                  Clear filters
                </Button>
                <Button
                  size="sm"
                  onClick={openPurchaseFormPanel}
                >
                  Add purchase
                </Button>
              </div>
            </div>
          ) : (
            paginatedRows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-1"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelected(r.id)}
                    aria-label={`Select purchase ${r.id}`}
                  />
                  <div>
                    <p className="text-sm font-semibold">{toTitleCase(r.productName || "")}</p>
                    {r.productSku ? (
                      <p className="text-xs text-muted-foreground">SKU: {r.productSku}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                    {getExpectedUrgency(r) ? (
                      <span
                        className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[11px] ${
                          getExpectedUrgency(r)?.tone === "danger"
                            ? "border-red-300 bg-red-50 text-red-700"
                            : getExpectedUrgency(r)?.tone === "warning"
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-gray-300 bg-muted text-muted-foreground"
                        }`}
                      >
                        {getExpectedUrgency(r)?.label}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="View details"
                    title="View details"
                    onClick={() => { setSelected(r); setInfoOpen(true); }}
                  >
                    <Info className="w-4 h-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Qty</p>
                    <p className="font-medium">{r.quantity}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground text-xs uppercase">Status</p>
                    <p className="font-medium">{formatStatusLabel(r.status)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground text-xs uppercase">Unit Cost</p>
                    <p className="font-medium">{formatCurrency(Number(r.unitCost || 0))}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Total</p>
                    <p className="font-medium">{formatCurrency(Number(r.total || 0))}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Received</p>
                    <p className="font-medium">
                      {Number(r.receivedQuantity ?? r.quantity)} / {Number(r.orderedQuantity ?? r.quantity)}
                    </p>
                  </div>
                  {r.supplier ? (
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs uppercase">Supplier</p>
                      <p className="font-medium">{r.supplier}</p>
                    </div>
                  ) : null}
                </div>
                {r.reason ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Reason:</span> {r.reason}
                  </p>
                ) : null}
                {r.note ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Note:</span> {r.note}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {isAwaitingReceive(r) ? (
                    <div className="w-full rounded-md border p-2">
                      <p className="mb-1 text-xs font-medium text-muted-foreground">Expected date</p>
                      <div className="flex items-center gap-2">
                        <Input
                          type="date"
                          value={expectedDraftById[r.id] ?? ""}
                          onChange={(e) =>
                            setExpectedDraftById((prev) => ({ ...prev, [r.id]: e.target.value }))
                          }
                          disabled={!canManagePurchases || updatingExpectedId === r.id}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateExpectedDate(r)}
                          disabled={!canManagePurchases || updatingExpectedId === r.id}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {r.status === "PENDING_APPROVAL" && isAdmin ? (
                    <Button size="sm" variant="outline" onClick={() => openApproveDialog(r)}>
                      Approve
                    </Button>
                  ) : null}
                  {["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(String(r.status || "")) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openReceiveDialog(r)}
                      disabled={!canManagePurchases}
                    >
                      Receive
                    </Button>
                  ) : null}
                  {Number(r.receivedQuantity ?? 0) > 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openReturnDialog(r)}
                      disabled={!canManagePurchases}
                    >
                      Return to supplier
                    </Button>
                  ) : null}
                  {isCancelablePurchase(r) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openCancelDialog(r)}
                      disabled={!canManagePurchases}
                    >
                      Cancel purchase
                    </Button>
                  ) : null}
                  {!canManagePurchases ? (
                    <span className="text-xs text-muted-foreground">Admin only</span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="overflow-x-auto hidden lg:block">
          <table className="w-full table-fixed text-sm border-collapse border border-gray-200 dark:border-gray-800 admin-purchases-table">
            <thead className="bg-muted text-left admin-purchases-head">
              <tr>
                <th className="p-2 border text-center relative" style={{ width: columnWidths.select }}>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible purchases"
                  />
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("select", event)}
                  />
                </th>
                <th className="p-2 border relative" style={{ width: columnWidths.date }}>
                  Date
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("date", event)}
                  />
                </th>
                <th className="p-2 border relative" style={{ width: columnWidths.product }}>
                  Product
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("product", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.qty }}>
                  Qty
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("qty", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.unitCost }}>
                  Unit Cost
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("unitCost", event)}
                  />
                </th>
                <th className="p-2 border relative" style={{ width: Math.max(columnWidths.status, 160) }}>
                  Status
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("status", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.received }}>
                  Received
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("received", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.total }}>
                  Total
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("total", event)}
                  />
                </th>
                {showSupplierCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.supplier }}>
                    Supplier
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("supplier", event)}
                    />
                  </th>
                )}
                {showReasonCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.reason }} title="Why this purchase was made">
                    Reason
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("reason", event)}
                    />
                  </th>
                )}
                {showNoteCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.note }} title="Additional context or internal notes">
                    Note
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("note", event)}
                    />
                  </th>
                )}
                <th className="p-2 border text-right relative" style={{ width: Math.max(columnWidths.actions, 120) }}>
                  Actions
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("actions", event)}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {listMeta.total === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="p-6 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>
                        {hasScopedViewMismatch
                          ? "No purchases match the current quick-view/expected window."
                          : "No purchases found for the current filters."}
                      </span>
                      <div className="flex flex-wrap justify-center gap-2">
                        {hasScopedViewMismatch ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setQuickView("all");
                              setExpectedWindow("all");
                              setExpectedSort("none");
                              setOpenOnly(false);
                            }}
                          >
                            Reset view filters
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="outline"
                        onClick={resetPurchasesScope}
                        >
                          Clear filters
                        </Button>
                        <Button
                          size="sm"
                          onClick={openPurchaseFormPanel}
                        >
                          Add purchase
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                  >
                    <td className="p-2 border text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelected(r.id)}
                        aria-label={`Select purchase ${r.id}`}
                      />
                    </td>
                    <td className="p-2 border">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2 border">
                      <div className="space-y-0.5">
                        <div>{toTitleCase(r.productName || "")}</div>
                        {r.productSku ? (
                          <div className="text-xs text-muted-foreground">SKU: {r.productSku}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 border text-right">{r.quantity}</td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.unitCost || 0))}</td>
                    <td className="p-2 border whitespace-nowrap">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{formatStatusLabel(r.status)}</span>
                        {getExpectedUrgency(r) ? (
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${
                              getExpectedUrgency(r)?.tone === "danger"
                                ? "border-red-300 bg-red-50 text-red-700"
                                : getExpectedUrgency(r)?.tone === "warning"
                                ? "border-amber-300 bg-amber-50 text-amber-700"
                                : "border-gray-300 bg-muted text-muted-foreground"
                            }`}
                          >
                            {getExpectedUrgency(r)?.label}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 border text-right">
                      {Number(r.receivedQuantity ?? r.quantity)} / {Number(r.orderedQuantity ?? r.quantity)}
                    </td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.total || 0))}</td>
                    {showSupplierCol && <td className="p-2 border">{r.supplier || ""}</td>}
                    {showReasonCol && (
                      <td className="p-2 border">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap" title={r.reason || ""}>
                          {r.reason || ""}
                        </div>
                      </td>
                    )}
                    {showNoteCol && (
                      <td className="p-2 border">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap" title={r.note || ""}>
                          {r.note || ""}
                        </div>
                      </td>
                    )}
                    <td className="p-2 border text-right">
                      <div className="flex flex-col items-end gap-1">
                        {isAwaitingReceive(r) ? (
                          <div className="mb-1 w-full max-w-[180px] rounded border p-1.5 text-left">
                            <p className="mb-1 text-[11px] text-muted-foreground">Expected date</p>
                            <div className="flex items-center gap-1">
                              <input
                                type="date"
                                className="h-7 min-w-0 flex-1 rounded border bg-background px-1 text-xs"
                                value={expectedDraftById[r.id] ?? ""}
                                onChange={(e) =>
                                  setExpectedDraftById((prev) => ({ ...prev, [r.id]: e.target.value }))
                                }
                                disabled={!canManagePurchases || updatingExpectedId === r.id}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => updateExpectedDate(r)}
                                disabled={!canManagePurchases || updatingExpectedId === r.id}
                              >
                                Save
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        {r.status === "PENDING_APPROVAL" && isAdmin ? (
                          <Button size="sm" variant="outline" onClick={() => openApproveDialog(r)}>
                            Approve
                          </Button>
                        ) : null}
                        {["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(String(r.status || "")) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openReceiveDialog(r)}
                            disabled={!canManagePurchases}
                          >
                            Receive
                          </Button>
                        ) : null}
                        {Number(r.receivedQuantity ?? 0) > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openReturnDialog(r)}
                            disabled={!canManagePurchases}
                          >
                            Return to supplier
                          </Button>
                        ) : null}
                        {isCancelablePurchase(r) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openCancelDialog(r)}
                            disabled={!canManagePurchases}
                          >
                            Cancel purchase
                          </Button>
                        ) : null}
                        {!canManagePurchases ? (
                          <span className="text-xs text-muted-foreground">Admin only</span>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="View details"
                          title="View details"
                          onClick={() => { setSelected(r); setInfoOpen(true); }}
                        >
                          <Info className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {listMeta.total > pageSize && (
          <div className="flex flex-col gap-2 pt-2">
            <div className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
            </div>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (currentPage > 1) setPage(currentPage - 1);
                    }}
                  />
                </PaginationItem>
                {visiblePages[0] && visiblePages[0] > 1 && (
                  <>
                    <PaginationItem>
                      <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(1); }}>
                        1
                      </PaginationLink>
                    </PaginationItem>
                    {visiblePages[0] > 2 && (
                      <PaginationItem>
                        <span className="px-2 text-muted-foreground">…</span>
                      </PaginationItem>
                    )}
                  </>
                )}
                {visiblePages.map((p) => (
                  <PaginationItem key={p}>
                    <PaginationLink
                      href="#"
                      isActive={p === currentPage}
                      onClick={(e) => { e.preventDefault(); setPage(p); }}
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                {visiblePages[visiblePages.length - 1] && visiblePages[visiblePages.length - 1] < totalPages && (
                  <>
                    {visiblePages[visiblePages.length - 1] < totalPages - 1 && (
                      <PaginationItem>
                        <span className="px-2 text-muted-foreground">…</span>
                      </PaginationItem>
                    )}
                    <PaginationItem>
                      <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(totalPages); }}>
                        {totalPages}
                      </PaginationLink>
                    </PaginationItem>
                  </>
                )}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (currentPage < totalPages) setPage(currentPage + 1);
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
        <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Purchase Details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{toTitleCase(selected.productName || "")}</span></div>
                {selected.reason ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span>{selected.reason}</span></div>
                ) : null}
                {selected.productSku ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{selected.productSku}</span></div>
                ) : null}
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{selected.quantity}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{formatStatusLabel(selected.status)}</span></div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Received</span>
                  <span>{Number(selected.receivedQuantity ?? selected.quantity)} / {Number(selected.orderedQuantity ?? selected.quantity)}</span>
                </div>
                {selected.expectedAt ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Expected</span><span>{new Date(selected.expectedAt).toLocaleDateString()}</span></div>
                ) : null}
                <div className="flex justify-between"><span className="text-muted-foreground">Unit Cost</span><span>{formatCurrency(Number(selected.unitCost || 0))}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span>{formatCurrency(Number(selected.total || 0))}</span></div>
                {selected.supplier ? (<div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{selected.supplier}</span></div>) : null}
                {selected.note ? (<div className="flex justify-between"><span className="text-muted-foreground">Note</span><span>{selected.note}</span></div>) : null}
              </div>
            )}
          </DialogContent>
        </Dialog>
        <Dialog
          open={approveOpen}
          onOpenChange={(open) => {
            setApproveOpen(open);
            if (!open) {
              setApproveTarget(null);
            }
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Approve purchase</DialogTitle>
            </DialogHeader>
            {approveTarget ? (
              <div className="grid gap-4 text-sm">
                <div className="space-y-1">
                  <div className="font-medium">
                    {toTitleCase(approveTarget.productName || "")}
                  </div>
                  {approveTarget.productSku ? (
                    <div className="text-xs text-muted-foreground">SKU: {approveTarget.productSku}</div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    Qty {approveTarget.quantity} · Total {formatCurrency(Number(approveTarget.total || 0))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  This will approve the purchase so it can be received and paid.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setApproveOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={confirmApprove}>Approve purchase</Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
        <Dialog
          open={purchaseConfirmOpen}
          onOpenChange={(open) => {
            setPurchaseConfirmOpen(open);
            if (!open && !purchaseSubmitting) {
              setPendingPurchasePayload(null);
            }
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Confirm purchase</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{toTitleCase(selectedProduct?.name || "") || "-"}</span></div>
              {selectedProduct?.sku ? (
                <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{selectedProduct.sku}</span></div>
              ) : null}
              <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{form.quantity || "-"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Unit cost</span><span>{form.unitCost ? formatCurrency(Number(form.unitCost)) : "-"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Line total</span><span>{form.quantity && form.unitCost ? formatCurrency(Number(form.quantity) * Number(form.unitCost)) : "-"}</span></div>
              {currentCost != null ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Current average cost</span><span>{formatCurrency(Number(currentCost))}</span></div>
              ) : null}
              {projectedAverageCost != null ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Projected average cost</span><span>{formatCurrency(Number(projectedAverageCost))}</span></div>
              ) : null}
              <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{form.supplier || "-"}</span></div>
              {form.expectedAt ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Expected date</span><span>{new Date(form.expectedAt).toLocaleDateString()}</span></div>
              ) : null}
              {form.reason ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span>{form.reason}</span></div>
              ) : null}
              {form.note ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Note</span><span>{form.note}</span></div>
              ) : null}
              {form.lotCode ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Lot / Batch</span><span>{form.lotCode}</span></div>
              ) : null}
              {form.expiryDate ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Expiry date</span><span>{new Date(form.expiryDate).toLocaleDateString()}</span></div>
              ) : null}
              <div className="flex justify-between"><span className="text-muted-foreground">Receive now</span><span>{pendingPurchasePayload?.receiveNow ? "Yes" : "No"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Pay now</span><span>{pendingPurchasePayload?.paidOnReceipt ? "Yes" : "No"}</span></div>
              {pendingPurchasePayload?.paidOnReceipt ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Payment mode</span><span>{toTitleCase(pendingPurchasePayload.paymentMethod || "-")}</span></div>
              ) : null}
              {approvalRequiredForForm ? (
                <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  This will create a pending-approval purchase order (not received now).
                </div>
              ) : null}
              {highValueCreditOnlyForForm ? (
                <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  High-value rule: payment is deferred and recorded after approval.
                </div>
              ) : null}
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setPurchaseConfirmOpen(false);
                    setPendingPurchasePayload(null);
                  }}
                  disabled={purchaseSubmitting}
                >
                  Cancel
                </Button>
                <Button onClick={confirmCreatePurchase} disabled={purchaseSubmitting}>
                  {purchaseSubmitting ? "Saving..." : "Confirm purchase"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={bulkReceiveOpen} onOpenChange={setBulkReceiveOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Bulk receive selected purchases</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <p>
                Selected open rows: <span className="font-medium">{selectedOpenCount}</span>
              </p>
              <div className="space-y-1">
                <Label htmlFor="bulkReceiveRule">Receive rule</Label>
                <select
                  id="bulkReceiveRule"
                  className="h-9 w-full rounded border bg-background px-2"
                  value={bulkReceiveRule}
                  onChange={(e) => setBulkReceiveRule(e.target.value as "full" | "remaining_only")}
                >
                  <option value="full">Full remaining qty (all open selected rows)</option>
                  <option value="remaining_only">Remaining only for partially received rows</option>
                </select>
              </div>
              <p className="text-xs text-muted-foreground">
                Rows requiring lot/expiry may fail and will be reported.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setBulkReceiveOpen(false)} disabled={bulkReceiveSubmitting}>
                  Cancel
                </Button>
                <Button onClick={confirmBulkReceive} disabled={bulkReceiveSubmitting}>
                  Confirm receive
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={bulkReturnOpen} onOpenChange={setBulkReturnOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Bulk return selected purchases</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <p>
                Selected returnable rows: <span className="font-medium">{selectedReturnableCount}</span>
              </p>
              <div className="space-y-1">
                <Label htmlFor="bulkReturnReason">Return reason *</Label>
                <Input
                  id="bulkReturnReason"
                  value={bulkReturnReason}
                  onChange={(e) => setBulkReturnReason(e.target.value)}
                  placeholder="Why these purchases are being returned"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                This returns currently received quantity for each selected row and creates supplier credit entries.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setBulkReturnOpen(false)} disabled={bulkReturnSubmitting}>
                  Cancel
                </Button>
                <Button onClick={confirmBulkReturn} disabled={bulkReturnSubmitting}>
                  Confirm return
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          open={bulkSummary.open}
          onOpenChange={(open) => setBulkSummary((prev) => ({ ...prev, open }))}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">{bulkSummary.title || "Bulk action result"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Successful</span>
                <span className="font-medium">{bulkSummary.success}</span>
              </div>
              <div className="flex justify-between">
                <span>Failed</span>
                <span className="font-medium">{bulkSummary.failed}</span>
              </div>
              {bulkSummary.details.length > 0 ? (
                <div className="rounded border p-2">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Failures</p>
                  <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs">
                    {bulkSummary.details.map((line, idx) => (
                      <li key={`${line}-${idx}`}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button
                  onClick={() => setBulkSummary((prev) => ({ ...prev, open: false }))}
                >
                  Close
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          open={receiveOpen}
          onOpenChange={(open) => {
            setReceiveOpen(open);
            if (!open) {
              setReceiveRow(null);
              setReceiveQty("");
              setReceiveLotCode("");
              setReceiveExpiry("");
              setReceiveLotNotes("");
              setReceiveErrors({});
            }
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Receive purchase</DialogTitle>
            </DialogHeader>
            {receiveRow ? (
              <div className="grid gap-4 text-sm">
                <div className="space-y-1">
                  <div className="font-medium">{toTitleCase(receiveRow.productName || "")}</div>
                  <div className="text-xs text-muted-foreground">
                    Remaining: {Math.max(0, Number(receiveRow.orderedQuantity ?? receiveRow.quantity) - Number(receiveRow.receivedQuantity ?? 0))}
                  </div>
                </div>
                <div className="space-y-2">
                <Label htmlFor="receiveQty">Receive quantity</Label>
                <Input
                  id="receiveQty"
                  type="number"
                  min={1}
                  value={receiveQty}
                  onChange={(e) => setReceiveQty(e.target.value)}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="receiveLotCode">Lot / Batch code</Label>
                    <Input
                      id="receiveLotCode"
                      placeholder={receiveRow.requiresLotTracking ? "Required for regulated SKU" : "e.g., LOT-2026-01"}
                      value={receiveLotCode}
                      onChange={(e) => {
                        setReceiveLotCode(e.target.value);
                        if (receiveErrors.lotCode) {
                          setReceiveErrors((prev) => ({ ...prev, lotCode: "" }));
                        }
                      }}
                      className={receiveErrors.lotCode ? "border-red-500" : ""}
                    />
                    {receiveErrors.lotCode ? (
                      <p className="text-xs text-red-600">{receiveErrors.lotCode}</p>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="receiveExpiry">Expiry date</Label>
                    <Input
                      id="receiveExpiry"
                      type="date"
                      value={receiveExpiry}
                      onChange={(e) => {
                        setReceiveExpiry(e.target.value);
                        if (receiveErrors.expiryDate) {
                          setReceiveErrors((prev) => ({ ...prev, expiryDate: "" }));
                        }
                      }}
                      className={receiveErrors.expiryDate ? "border-red-500" : ""}
                    />
                    {receiveErrors.expiryDate ? (
                      <p className="text-xs text-red-600">{receiveErrors.expiryDate}</p>
                    ) : null}
                  </div>
                </div>
                {receiveRow.requiresLotTracking || receiveRow.requiresExpiryDate ? (
                  <p className="text-xs text-muted-foreground">
                    This SKU requires {describeTrackingRequirements(
                      receiveRow.requiresLotTracking,
                      receiveRow.requiresExpiryDate,
                    )}
                  </p>
                ) : null}
                <div className="space-y-1">
                  <Label htmlFor="receiveLotNotes">Lot notes (optional)</Label>
                  <Input
                    id="receiveLotNotes"
                    placeholder="Short note for this batch"
                    value={receiveLotNotes}
                    onChange={(e) => setReceiveLotNotes(e.target.value)}
                  />
                </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setReceiveOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={confirmReceive} disabled={!canManagePurchases}>
                    Confirm receive
                  </Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
        <Dialog
          open={returnOpen}
          onOpenChange={(open) => {
            setReturnOpen(open);
            if (!open) {
              setReturnRow(null);
              setReturnQty("");
              setReturnLotCode("");
              setReturnNotes("");
            }
          }}
        >
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Return to supplier</DialogTitle>
            </DialogHeader>
            {returnRow ? (
              <div className="grid gap-4 text-sm">
                <div className="space-y-1">
                  <div className="font-medium">{toTitleCase(returnRow.productName || "")}</div>
                  {returnRow.productSku ? (
                    <div className="text-xs text-muted-foreground">SKU: {returnRow.productSku}</div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    Received: {Number(returnRow.receivedQuantity ?? 0)}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="returnQty">Return quantity</Label>
                  <Input
                    id="returnQty"
                    type="number"
                    min={1}
                    value={returnQty}
                    onChange={(e) => setReturnQty(e.target.value)}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="returnLotCode">Lot / Batch code (optional)</Label>
                    <Input
                      id="returnLotCode"
                      placeholder="Leave blank to use earliest lots"
                      value={returnLotCode}
                      onChange={(e) => setReturnLotCode(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="returnNotes">Notes (optional)</Label>
                    <Input
                      id="returnNotes"
                      placeholder="Reason for return"
                      value={returnNotes}
                      onChange={(e) => setReturnNotes(e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Returning items reduces inventory and creates an AP credit for the supplier.
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setReturnOpen(false)} disabled={returnSubmitting}>
                    Cancel
                  </Button>
                  <Button onClick={confirmReturn} disabled={returnSubmitting || !canManagePurchases}>
                    Confirm return
                  </Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
        <Dialog
          open={saveFilterOpen}
          onOpenChange={(open) => {
            setSaveFilterOpen(open);
            if (!open) setSaveFilterName("");
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Save current filter</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 text-sm">
              <div className="space-y-1">
                <Label htmlFor="saveFilterName">Filter name</Label>
                <Input
                  id="saveFilterName"
                  value={saveFilterName}
                  onChange={(e) => setSaveFilterName(e.target.value)}
                  placeholder="e.g., Pending approvals this week"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSaveFilterOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (!saveFilterName.trim()) {
                      toast.error("Enter a name for this saved filter.");
                      return;
                    }
                    saveCurrentFilter();
                  }}
                >
                  Save filter
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          open={cancelOpen}
          onOpenChange={(open) => {
            setCancelOpen(open);
            if (!open && !cancelSubmitting) {
              setCancelTarget(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Cancel purchase</DialogTitle>
            </DialogHeader>
            {cancelTarget ? (
              <div className="grid gap-3 text-sm">
                <div className="space-y-1">
                  <div className="font-medium">{toTitleCase(cancelTarget.productName || "")}</div>
                  {cancelTarget.productSku ? (
                    <div className="text-xs text-muted-foreground">SKU: {cancelTarget.productSku}</div>
                  ) : null}
                </div>
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  This keeps the purchase record for audit history and closes it without receiving stock.
                </div>
                <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{formatStatusLabel(cancelTarget.status)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{cancelTarget.quantity}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{cancelTarget.supplier || "-"}</span></div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelSubmitting}>
                    Close
                  </Button>
                  <Button onClick={confirmCancel} disabled={cancelSubmitting}>
                    {cancelSubmitting ? "Cancelling..." : "Cancel purchase"}
                  </Button>
                </div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default function AdminPurchasesPage() {
  return (
    <section className="container mx-auto py-8">
      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">Purchases</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Loading purchases…</p>
            </CardContent>
          </Card>
        }
      >
        <AdminPurchasesContent />
      </Suspense>
    </section>
  );
}
