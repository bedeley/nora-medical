"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";

type ProductRow = { id: string; name: string; price: number | string; stock?: number; archived?: boolean };
type CustomerSuggestRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  source?: "REGISTERED" | "WALK_IN_HISTORY";
};

type OtcShiftClosedStatus = {
  isOpen: boolean;
  isClosed: boolean;
  day: string;
  openEventId: string | null;
  closeEventId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  openedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  closedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  canOpenNow: boolean;
  openWindowStartHourUtc: number;
  requiresHandoverAck: boolean;
  lastClose: {
    shiftCloseId: string;
    createdAt: string;
    closedBy: { id: string; name: string | null; email: string | null; role: string } | null;
  } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const OTC_DRAFT_KEY = "otc-sale-draft-v1";
type OtcDraft = {
  ts?: number;
  walkInName?: string;
  walkInPhone?: string;
  allowAnonymousSale?: boolean;
  anonymousReason?: string;
  linkedCustomerId?: string;
  linkedCustomerLabel?: string;
  items?: Array<{ productId: string; name: string; price: number; quantity: number }>;
  amountPaid?: string;
  paymentMethod?: "" | "cash" | "momo" | "transfer" | "credit";
  paymentCaptureMode?: "record_existing" | "initiate_momo";
  momoProvider?: "mtn" | "vodafone" | "airteltigo";
  paymentReference?: string;
  shiftSession?: string;
  customShiftSession?: string;
  markDeliveredNow?: boolean;
  discountAmount?: string;
  discountReason?: string;
};

const normalizePhone = (value: string | null | undefined) =>
  String(value || "").replace(/\D/g, "");

export default function OtcSalesPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const isAdmin = role === "ADMIN";
  const canCreateSale = role === "ADMIN" || role === "STAFF";
  const canVoidSale = role === "ADMIN";
  const { data: productsData } = useClientQuery({
    queryKey: ["products", { pageSize: 200 }],
    queryFn: () => fetcher("/api/products?pageSize=200"),
  });
  const { data: shiftClosedStatus, refetch: refetchShiftClosedStatus } =
    useClientQuery<OtcShiftClosedStatus>({
      queryKey: ["admin", "otc-shift-closed-status"],
      queryFn: () => fetcher("/api/admin/otc/shift-close/status"),
    });

  const products = useMemo(
    () => ((productsData?.items || []) as ProductRow[]).filter((p) => !p.archived),
    [productsData],
  );

  const [walkInName, setWalkInName] = useState("");
  const [walkInPhone, setWalkInPhone] = useState("");
  const [allowAnonymousSale, setAllowAnonymousSale] = useState(false);
  const [anonymousReason, setAnonymousReason] = useState("");
  const [linkedCustomerId, setLinkedCustomerId] = useState("");
  const [linkedCustomerLabel, setLinkedCustomerLabel] = useState("");
  const [suggestions, setSuggestions] = useState<CustomerSuggestRow[]>([]);
  const [suppressAutoSuggest, setSuppressAutoSuggest] = useState(false);
  const [findingMatches, setFindingMatches] = useState(false);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [items, setItems] = useState<
    { productId: string; name: string; price: number; quantity: number }[]
  >([]);
  const [amountPaid, setAmountPaid] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"" | "cash" | "momo" | "transfer" | "credit">("");
  const [paymentCaptureMode, setPaymentCaptureMode] = useState<"record_existing" | "initiate_momo">(
    "record_existing",
  );
  const [momoProvider, setMomoProvider] = useState<"mtn" | "vodafone" | "airteltigo">("mtn");
  const [paymentReference, setPaymentReference] = useState("");
  const [shiftSession, setShiftSession] = useState("MORNING");
  const [customShiftSession, setCustomShiftSession] = useState("");
  const [markDeliveredNow, setMarkDeliveredNow] = useState(true);
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [voidingOrder, setVoidingOrder] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [retryPosting, setRetryPosting] = useState(false);
  const [completedOrderId, setCompletedOrderId] = useState<string | null>(null);
  const [postingIssue, setPostingIssue] = useState<{
    orderId: string;
    orderStatus: "POSTED" | "FAILED" | "SKIPPED";
    orderError: string | null;
    paymentStatus: "POSTED" | "FAILED" | "SKIPPED";
    paymentError: string | null;
    paymentExpected: boolean;
  } | null>(null);
  const [momoPending, setMomoPending] = useState<{
    orderId: string;
    paymentId: string;
    providerRef: string | null;
    status: "PENDING" | "SUCCESSFUL" | "FAILED";
    lastCheckedAt: Date | null;
  } | null>(null);
  const [errors, setErrors] = useState<{
    walkInName?: string;
    anonymousReason?: string;
    productId?: string;
    quantity?: string;
    items?: string;
    amountPaid?: string;
    paymentReference?: string;
    paymentMethod?: string;
    walkInPhone?: string;
    closedShiftOverrideReason?: string;
    discountReason?: string;
  }>({});
  const [forceClosedShiftOverride, setForceClosedShiftOverride] = useState(false);
  const [closedShiftOverrideReason, setClosedShiftOverrideReason] = useState("");
  const [openingShift, setOpeningShift] = useState(false);
  const [openingNote, setOpeningNote] = useState("");
  const [openingCashFloat, setOpeningCashFloat] = useState("");
  const [handoverAcknowledged, setHandoverAcknowledged] = useState(false);
  const [handoverCashCountVerified, setHandoverCashCountVerified] = useState(false);
  const [handoverPaymentSummaryVerified, setHandoverPaymentSummaryVerified] =
    useState(false);
  const [handoverPendingItemsReviewed, setHandoverPendingItemsReviewed] =
    useState(false);
  const [handoverNotes, setHandoverNotes] = useState("");
  const [draftAvailableAt, setDraftAvailableAt] = useState<number | null>(null);
  const [pendingDraft, setPendingDraft] = useState<OtcDraft | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastValidationAt, setLastValidationAt] = useState<Date | null>(null);

  function resetSaleForm() {
    setWalkInName("");
    setWalkInPhone("");
    setAllowAnonymousSale(false);
    setAnonymousReason("");
    setLinkedCustomerId("");
    setLinkedCustomerLabel("");
    setSuggestions([]);
    setSuppressAutoSuggest(false);
    setProductId("");
    setQuantity("1");
    setItems([]);
    setAmountPaid("");
    setAmountTouched(false);
    setPaymentMethod("");
    setPaymentCaptureMode("record_existing");
    setMomoProvider("mtn");
    setPaymentReference("");
    setShiftSession("MORNING");
    setCustomShiftSession("");
    setMarkDeliveredNow(true);
    setDiscountAmount("");
    setDiscountReason("");
    setVoidReason("");
    setForceClosedShiftOverride(false);
    setClosedShiftOverrideReason("");
    setErrors({});
    setPostingIssue(null);
    setCompletedOrderId(null);
    setMomoPending(null);
    setDraftAvailableAt(null);
    setPendingDraft(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(OTC_DRAFT_KEY);
    }
  }

  function clearSaleEntryFields() {
    setWalkInName("");
    setWalkInPhone("");
    setAllowAnonymousSale(false);
    setAnonymousReason("");
    setLinkedCustomerId("");
    setLinkedCustomerLabel("");
    setSuggestions([]);
    setSuppressAutoSuggest(false);
    setProductId("");
    setQuantity("1");
    setItems([]);
    setAmountPaid("");
    setAmountTouched(false);
    setPaymentMethod("");
    setPaymentCaptureMode("record_existing");
    setMomoProvider("mtn");
    setPaymentReference("");
    setMarkDeliveredNow(true);
    setDiscountAmount("");
    setDiscountReason("");
    setVoidReason("");
    setForceClosedShiftOverride(false);
    setClosedShiftOverrideReason("");
    setErrors({});
  }

  async function refreshPendingMomoStatus(manual = false) {
    if (!momoPending?.paymentId) return;
    try {
      const res = await fetch(`/api/payments/momo/status/${momoPending.paymentId}`);
      const body = await res.json().catch(() => ({} as { error?: string; status?: string }));
      if (!res.ok) {
        if (manual) toast.error(body?.error || "Failed to refresh MoMo status");
        return;
      }
      const normalized = String(body?.status || "PENDING").toUpperCase();
      if (normalized === "SUCCESSFUL") {
        setMomoPending(null);
        queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
        toast.success("MoMo payment confirmed. Safe to release items.");
        return;
      }
      if (normalized === "FAILED") {
        setMomoPending((prev) =>
          prev
            ? {
                ...prev,
                status: "FAILED",
                lastCheckedAt: new Date(),
              }
            : prev,
        );
        if (manual) toast.warning("MoMo payment is not successful yet.");
        return;
      }
      setMomoPending((prev) =>
        prev
          ? {
              ...prev,
              status: "PENDING",
              lastCheckedAt: new Date(),
            }
          : prev,
      );
      if (manual) toast.message("MoMo payment is still pending customer approval.");
    } catch {
      if (manual) toast.error("Unexpected error checking MoMo status");
    }
  }

  useEffect(() => {
    if (!momoPending || momoPending.status !== "PENDING") return;
    const timer = window.setInterval(() => {
      void refreshPendingMomoStatus(false);
    }, 8000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [momoPending?.paymentId, momoPending?.status]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(OTC_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OtcDraft;
      const ts = Number(parsed?.ts || 0);
      if (!ts) return;
      const ageMs = Date.now() - ts;
      if (ageMs <= 3 * 60 * 1000) {
        setDraftAvailableAt(ts);
        setPendingDraft(parsed);
      } else {
        window.localStorage.removeItem(OTC_DRAFT_KEY);
      }
    } catch {
      // ignore malformed local data
    }
  }, []);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [products, productId],
  );
  const sortedSuggestions = useMemo(() => {
    const inputName = walkInName.trim().toLowerCase();
    const inputPhone = normalizePhone(walkInPhone);
    const inputPhoneTail = inputPhone.length >= 7 ? inputPhone.slice(-7) : inputPhone;
    const score = (row: CustomerSuggestRow) => {
      let s = 0;
      const rowName = String(row.name || "").trim().toLowerCase();
      const rowPhone = normalizePhone(row.phone);
      if (inputName && rowName && rowName === inputName) s += 4;
      if (inputName && rowName && rowName.includes(inputName)) s += 1;
      if (inputPhone && rowPhone && rowPhone === inputPhone) s += 5;
      if (inputPhoneTail && rowPhone && rowPhone.endsWith(inputPhoneTail)) s += 3;
      return s;
    };
    return [...suggestions].sort((a, b) => score(b) - score(a));
  }, [suggestions, walkInName, walkInPhone]);
  const topSuggestion = sortedSuggestions[0] || null;
  const visibleSuggestions = useMemo(() => {
    if (!topSuggestion || topSuggestion.source === "WALK_IN_HISTORY") {
      return sortedSuggestions;
    }
    return sortedSuggestions.filter((row) => row.id !== topSuggestion.id);
  }, [sortedSuggestions, topSuggestion]);
  const subtotal = useMemo(
    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [items],
  );
  const normalizedDiscount = useMemo(() => {
    if (!isAdmin) return 0;
    const value = Number(discountAmount || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.min(subtotal, value);
  }, [discountAmount, isAdmin, subtotal]);
  const total = Math.max(0, subtotal - normalizedDiscount);
  const normalizedPhone = useMemo(() => normalizePhone(walkInPhone), [walkInPhone]);
  const hasUnsavedChanges = useMemo(
    () =>
      Boolean(
        walkInName.trim() ||
          walkInPhone.trim() ||
          allowAnonymousSale ||
          anonymousReason.trim() ||
          linkedCustomerId ||
          productId ||
          quantity !== "1" ||
          items.length > 0 ||
          amountPaid.trim() ||
          paymentMethod ||
          paymentReference.trim() ||
          discountAmount.trim() ||
          discountReason.trim() ||
          shiftSession !== "MORNING" ||
          customShiftSession.trim() ||
          !markDeliveredNow,
      ),
    [
      walkInName,
      walkInPhone,
      allowAnonymousSale,
      anonymousReason,
      linkedCustomerId,
      productId,
      quantity,
      items.length,
      amountPaid,
      paymentMethod,
      paymentReference,
      discountAmount,
      discountReason,
      shiftSession,
      customShiftSession,
      markDeliveredNow,
    ],
  );
  const currentFlowStep = useMemo(() => {
    const customerReady = Boolean(walkInName.trim() || (allowAnonymousSale && anonymousReason.trim()));
    if (!customerReady) return 0;
    if (items.length === 0) return 1;
    if (Number(amountPaid || 0) > 0 && !paymentMethod) return 2;
    return 3;
  }, [walkInName, allowAnonymousSale, anonymousReason, items.length, amountPaid, paymentMethod]);
  const predictedStatus = useMemo(() => {
    const paid = Number(amountPaid || 0);
    if (!Number.isFinite(paid) || paid <= 0) return "UNPAID";
    if (paid >= total) return "PAID";
    return "PARTIALLY_PAID";
  }, [amountPaid, total]);

  function addItem() {
    if (!selectedProduct) {
      setErrors((prev) => ({ ...prev, productId: "Select a product." }));
      return;
    }
    const qty = Math.max(1, Number(quantity || 1));
    if (!Number.isFinite(qty) || qty <= 0) {
      setErrors((prev) => ({ ...prev, quantity: "Quantity must be at least 1." }));
      return;
    }

    const availableStock = Number(selectedProduct.stock ?? 0);
    const existingQty = items.find((it) => it.productId === selectedProduct.id)?.quantity || 0;
    const requestedTotal = existingQty + qty;
    if (Number.isFinite(availableStock) && requestedTotal > availableStock) {
      const shortage = Math.max(0, requestedTotal - availableStock);
      setErrors((prev) => ({
        ...prev,
        quantity: `Low stock: only ${availableStock} available. Short by ${shortage}.`,
      }));
      toast.warning(
        `Cannot add ${selectedProduct.name}. Requested total ${requestedTotal}, available ${availableStock}.`,
      );
      return;
    }

    setItems((prev) => {
      const wasEmpty = prev.length === 0;
      const existing = prev.find((it) => it.productId === selectedProduct.id);
      const next = existing
        ? prev.map((it) =>
            it.productId === selectedProduct.id
              ? { ...it, quantity: it.quantity + qty }
              : it,
          )
        : [
            ...prev,
            {
              productId: selectedProduct.id,
              name: selectedProduct.name,
              price: Number(selectedProduct.price),
              quantity: qty,
            },
          ];

      const nextTotal = next.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const discountValue = Number(discountAmount || 0);
      const boundedDiscount =
        isAdmin && Number.isFinite(discountValue) && discountValue > 0
          ? Math.min(nextTotal, discountValue)
          : 0;
      const nextNetTotal = Math.max(0, nextTotal - boundedDiscount);
      if (paymentMethod !== "credit" && (wasEmpty || !amountTouched)) {
        setAmountPaid(nextNetTotal > 0 ? nextNetTotal.toFixed(2) : "");
      }
      return next;
    });

    setProductId("");
    setQuantity("1");
    setErrors((prev) => ({ ...prev, productId: "", quantity: "", items: "" }));
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const next = prev.filter((it) => it.productId !== id);
      const nextTotal = next.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const discountValue = Number(discountAmount || 0);
      const boundedDiscount =
        isAdmin && Number.isFinite(discountValue) && discountValue > 0
          ? Math.min(nextTotal, discountValue)
          : 0;
      const nextNetTotal = Math.max(0, nextTotal - boundedDiscount);
      if (paymentMethod === "credit") {
        setAmountPaid("0");
      } else if (!amountTouched || next.length === 0) {
        setAmountPaid(nextNetTotal > 0 ? nextNetTotal.toFixed(2) : "");
      }
      return next;
    });
  }

  async function openShiftNow() {
    if (!canCreateSale) return;
    try {
      setOpeningShift(true);
      const res = await fetch("/api/admin/otc/shift-close/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: openingNote.trim() || undefined,
          openingCashFloat: Number(openingCashFloat || 0),
          handoverAcknowledged,
          handoverFromShiftCloseId: shiftClosedStatus?.lastClose?.shiftCloseId || undefined,
          handoverChecklist: {
            cashCountVerified: handoverCashCountVerified,
            paymentSummaryVerified: handoverPaymentSummaryVerified,
            pendingItemsReviewed: handoverPendingItemsReviewed,
            notes: handoverNotes.trim() || undefined,
          },
        }),
      });
      const body = await res.json().catch(
        () =>
          ({} as {
            error?: string;
            code?: string;
            alreadyOpen?: boolean;
          }),
      );
      if (!res.ok) {
        toast.error(body?.error || "Failed to open shift");
        return;
      }
      toast.success(body?.alreadyOpen ? "Shift already open." : "Shift opened.");
      setOpeningNote("");
      setOpeningCashFloat("");
      setHandoverAcknowledged(false);
      setHandoverCashCountVerified(false);
      setHandoverPaymentSummaryVerified(false);
      setHandoverPendingItemsReviewed(false);
      setHandoverNotes("");
      await refetchShiftClosedStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("otc-shift-status-changed"));
      }
    } catch {
      toast.error("Unexpected error while opening shift");
    } finally {
      setOpeningShift(false);
    }
  }

  async function submitOrder(confirmed = false) {
    if (submitting) return;
    setLastValidationAt(new Date());
    setPostingIssue(null);
    setCompletedOrderId(null);
    const nextErrors: typeof errors = {};
    const trimmedWalkInName = walkInName.trim();
    const trimmedAnonymousReason = anonymousReason.trim();
    if (!trimmedWalkInName) {
      if (!allowAnonymousSale) {
        nextErrors.walkInName =
          "Customer name is required for OTC sales. Use anonymous override if needed.";
      } else if (!trimmedAnonymousReason) {
        nextErrors.anonymousReason = "Enter a reason for anonymous OTC sale.";
      }
    }
    if (items.length === 0) {
      nextErrors.items = "Add at least one item.";
    }
    if (isAdmin && normalizedDiscount > 0 && !discountReason.trim()) {
      nextErrors.discountReason = "Discount reason is required for discounted OTC sales.";
    }
    const parsedAmount = Number(amountPaid || 0);
    if (amountPaid.trim()) {
      if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
        nextErrors.amountPaid = "Enter a valid amount paid.";
      } else if (parsedAmount > total) {
        nextErrors.amountPaid = "Amount paid cannot exceed order total.";
      }
    }
    if (
      paymentCaptureMode === "record_existing" &&
      parsedAmount > 0 &&
      paymentMethod !== "cash" &&
      paymentMethod !== "credit" &&
      !paymentReference.trim()
    ) {
      nextErrors.paymentReference = "Reference is required for MoMo or transfer payments.";
    }
    if (parsedAmount > 0 && !paymentMethod) {
      nextErrors.paymentMethod = "Select payment method.";
    }
    if (parsedAmount > 0 && paymentMethod === "credit") {
      nextErrors.amountPaid = "Credit sales must have Amount Paid as 0.00.";
    }
    const useMomoInitiateMode = paymentMethod === "momo" && paymentCaptureMode === "initiate_momo";
    if (useMomoInitiateMode) {
      if (!normalizedPhone) {
        nextErrors.walkInPhone = "Phone is required to send MoMo request.";
      } else if (normalizedPhone.length !== 10) {
        nextErrors.walkInPhone = "Enter a valid phone number (exactly 10 digits).";
      }
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        nextErrors.amountPaid = "Enter amount to request for MoMo.";
      }
      if (!trimmedWalkInName && allowAnonymousSale) {
        nextErrors.walkInName = "Anonymous sale cannot use MoMo initiation mode.";
      }
    }
    if (!trimmedWalkInName && allowAnonymousSale) {
      if (!amountPaid.trim() || parsedAmount < total) {
        nextErrors.amountPaid = "Anonymous OTC sale must be paid in full.";
      }
    }
    if (!shiftClosedStatus?.isOpen && !shiftClosedStatus?.isClosed) {
      nextErrors.items = "OTC shift is not open. Open shift before creating sales.";
    }
    if (
      shiftClosedStatus?.isClosed &&
      canVoidSale &&
      forceClosedShiftOverride &&
      closedShiftOverrideReason.trim().length < 10
    ) {
      nextErrors.closedShiftOverrideReason =
        "Enter override reason (at least 10 characters).";
    }
    if (shiftClosedStatus?.isClosed && !canVoidSale) {
      nextErrors.items =
        "OTC shift is closed for today. Ask admin to open next shift/session.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    if (!confirmed) {
      setConfirmOpen(true);
      return;
    }

    try {
      setConfirmOpen(false);
      setSubmitting(true);
      const payload: {
        customerType: "WALK_IN";
        walkInName?: string;
        walkInPhone?: string;
        linkedCustomerId?: string;
        allowAnonymousWalkIn?: boolean;
        anonymousReason?: string;
        items: { productId: string; quantity: number }[];
        initialPayment?: number;
        initialPaymentMethod?: "cash" | "momo" | "transfer" | "credit";
        initialPaymentReference?: string;
        shiftSession?: string;
        note?: string;
        forceClosedShiftOverride?: boolean;
        closedShiftOverrideReason?: string;
        deliveryStatus?: "NOT_DELIVERED";
        discountAmount?: number;
        discountReason?: string;
      } = {
        customerType: "WALK_IN",
        walkInName:
          (linkedCustomerId ? linkedCustomerLabel.trim() : trimmedWalkInName) ||
          "Walk-in Anonymous",
        walkInPhone: walkInPhone.trim() || undefined,
        linkedCustomerId: linkedCustomerId || undefined,
        items: items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
      };
      const resolvedShiftSession =
        shiftSession === "CUSTOM" ? customShiftSession.trim() : shiftSession.trim();
      if (resolvedShiftSession) {
        payload.shiftSession = resolvedShiftSession;
      }
      if (!markDeliveredNow) {
        payload.deliveryStatus = "NOT_DELIVERED";
      }
      if (isAdmin && normalizedDiscount > 0) {
        payload.discountAmount = normalizedDiscount;
        payload.discountReason = discountReason.trim();
      }
      if (!trimmedWalkInName) {
        payload.allowAnonymousWalkIn = true;
        payload.anonymousReason = trimmedAnonymousReason;
        payload.note = `ANONYMOUS_OTC: ${trimmedAnonymousReason}`;
      }
      if (
        shiftClosedStatus?.isClosed &&
        canVoidSale &&
        forceClosedShiftOverride &&
        closedShiftOverrideReason.trim().length >= 10
      ) {
        payload.forceClosedShiftOverride = true;
        payload.closedShiftOverrideReason = closedShiftOverrideReason.trim();
      }
      if (parsedAmount > 0) {
        if (paymentCaptureMode === "record_existing") {
          payload.initialPayment = parsedAmount;
          payload.initialPaymentMethod = paymentMethod as "cash" | "momo" | "transfer" | "credit";
          if (paymentMethod !== "cash" && paymentMethod !== "credit") {
            payload.initialPaymentReference = paymentReference.trim();
          }
        }
      }

      const res = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(
        () =>
          ({} as {
            error?: string;
            orderId?: string;
            posting?: {
              orderStatus: "POSTED" | "FAILED" | "SKIPPED";
              orderError: string | null;
              paymentStatus: "POSTED" | "FAILED" | "SKIPPED";
              paymentError: string | null;
              paymentExpected: boolean;
            };
          }),
      );
      if (!res.ok) {
        if ((body as { code?: string }).code === "OTC_SHIFT_CLOSED") {
          toast.error(body?.error || "OTC shift is closed for today.");
          await refetchShiftClosedStatus();
          return;
        }
        if ((body as { code?: string }).code === "OTC_SHIFT_NOT_OPEN") {
          toast.error(body?.error || "OTC shift is not open yet.");
          await refetchShiftClosedStatus();
          return;
        }
        toast.error(body?.error || "Failed to create OTC sale");
        return;
      }

      if (useMomoInitiateMode && body?.orderId && parsedAmount > 0) {
        const momoRes = await fetch(`/api/admin/orders/${body.orderId}/momo/initiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: normalizedPhone,
            provider: momoProvider,
            amount: parsedAmount,
          }),
        });
        const momoBody = await momoRes.json().catch(
          () =>
            ({} as {
              error?: string;
              reference?: string;
              simulated?: boolean;
              applied?: boolean;
              paymentId?: string;
            }),
        );
        if (!momoRes.ok) {
          toast.warning(
            momoBody?.error
              ? `Order created, but MoMo request failed: ${momoBody.error}`
              : "Order created, but MoMo request failed.",
          );
        } else if (momoBody?.simulated && momoBody?.applied) {
          setMomoPending(null);
          toast.success(
            `MoMo request simulated and applied${momoBody.reference ? ` (${momoBody.reference})` : ""}.`,
          );
          queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
        } else {
          if (momoBody?.paymentId) {
            setMomoPending({
              orderId: body.orderId,
              paymentId: momoBody.paymentId,
              providerRef: momoBody.reference || null,
              status: "PENDING",
              lastCheckedAt: null,
            });
          }
          toast.success(
            `MoMo request sent${momoBody.reference ? ` (${momoBody.reference})` : ""}. Await customer approval.`,
          );
        }
      } else {
        setMomoPending(null);
      }

      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      const posting = body?.posting;
      const hasPostingIssue =
        !!posting &&
        (posting.orderStatus !== "POSTED" ||
          (posting.paymentExpected && posting.paymentStatus !== "POSTED"));
      if (hasPostingIssue && body.orderId) {
        toast.warning("OTC sale created, but journal posting is pending.");
        clearSaleEntryFields();
        setCompletedOrderId(body.orderId);
        setPostingIssue({
          orderId: body.orderId,
          orderStatus: posting.orderStatus,
          orderError: posting.orderError,
          paymentStatus: posting.paymentStatus,
          paymentError: posting.paymentError,
          paymentExpected: posting.paymentExpected,
        });
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(OTC_DRAFT_KEY);
        }
        return;
      }
      toast.success("OTC sale created");
      if (body.orderId) {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(OTC_DRAFT_KEY);
        }
        clearSaleEntryFields();
        setCompletedOrderId(body.orderId);
      }
    } catch {
      toast.error("Unexpected error creating OTC sale");
    } finally {
      setSubmitting(false);
    }
  }

  async function voidCompletedOrder() {
    if (!completedOrderId || !canVoidSale) return;
    const reason = voidReason.trim();
    if (reason.length < 5) {
      toast.error("Enter a brief void reason (at least 5 characters).");
      return;
    }
    try {
      setVoidingOrder(true);
      const res = await fetch(`/api/orders/${completedOrderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "CANCELLED",
          cancelReason: reason,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(body?.error || "Failed to void sale");
        return;
      }
      toast.success("Sale voided successfully.");
      setCompletedOrderId(null);
      setVoidReason("");
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
    } catch {
      toast.error("Unexpected error while voiding sale");
    } finally {
      setVoidingOrder(false);
    }
  }

  const fetchCustomerMatches = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = Boolean(opts?.quiet);
    const name = walkInName.trim();
    const phone = walkInPhone.trim();
    if (!name && !phone) {
      if (!quiet) {
        toast.error("Enter walk-in name or phone to find matching customers.");
      }
      return;
    }
    try {
      setFindingMatches(true);
      const sp = new URLSearchParams();
      if (name) sp.set("name", name);
      if (phone) sp.set("phone", phone);
      const res = await fetch(`/api/admin/customers/suggest?${sp.toString()}`);
      const body = await res.json().catch(() => ({} as { items?: CustomerSuggestRow[]; error?: string }));
      if (!res.ok) {
        toast.error(body?.error || "Failed to find customer matches");
        return;
      }
      const next = Array.isArray(body?.items) ? body.items : [];
      setSuggestions(next);
      if (next.length === 0 && !quiet) toast.message("No close customer matches found.");
    } catch {
      if (!quiet) toast.error("Unexpected error while searching matches");
    } finally {
      setFindingMatches(false);
    }
  }, [walkInName, walkInPhone]);

  async function findCustomerMatches() {
    await fetchCustomerMatches({ quiet: false });
  }

  useEffect(() => {
    if (suppressAutoSuggest) return;
    if (linkedCustomerId) {
      setSuggestions([]);
      return;
    }
    const name = walkInName.trim();
    const phone = walkInPhone.trim();
    const canSearch = name.length >= 1 || normalizePhone(phone).length >= 4;
    if (!canSearch) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchCustomerMatches({ quiet: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [walkInName, walkInPhone, linkedCustomerId, suppressAutoSuggest, fetchCustomerMatches]);

  async function retryOrderPosting() {
    if (!postingIssue?.orderId) return;
    try {
      setRetryPosting(true);
      const res = await fetch(`/api/admin/orders/${postingIssue.orderId}/post`, {
        method: "POST",
      });
      const body = await res.json().catch(
        () =>
          ({} as {
            error?: string;
            orderPostingStatus?: "POSTED" | "FAILED" | "SKIPPED";
            orderPostingError?: string | null;
            paymentRetryCount?: number;
            paymentPostedCount?: number;
            paymentErrors?: Array<{ paymentId: string; error: string }>;
          }),
      );
      if (!res.ok) {
        toast.error(body?.error || "Retry posting failed");
        return;
      }
      const paymentErrors = Array.isArray(body?.paymentErrors) ? body.paymentErrors : [];
      if (body.orderPostingStatus === "FAILED" || paymentErrors.length > 0) {
        setPostingIssue((prev) =>
          prev
            ? {
                ...prev,
                orderStatus: body.orderPostingStatus || prev.orderStatus,
                orderError:
                  body.orderPostingStatus === "FAILED"
                    ? body.orderPostingError || prev.orderError
                    : null,
                paymentStatus: paymentErrors.length > 0 ? "FAILED" : "POSTED",
                paymentError: paymentErrors.length > 0 ? paymentErrors[0].error : null,
              }
            : prev,
        );
        toast.warning("Posting retry completed with remaining errors.");
        return;
      }
      setPostingIssue(null);
      toast.success("Journal posting completed.");
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      setCompletedOrderId(postingIssue.orderId);
    } catch {
      toast.error("Unexpected error while retrying posting");
    } finally {
      setRetryPosting(false);
    }
  }

  function restoreDraft() {
    if (typeof window === "undefined") return;
    try {
      const parsed = pendingDraft;
      if (!parsed) return;
      setWalkInName(String(parsed.walkInName || ""));
      setWalkInPhone(String(parsed.walkInPhone || ""));
      setAllowAnonymousSale(Boolean(parsed.allowAnonymousSale));
      setAnonymousReason(String(parsed.anonymousReason || ""));
      setLinkedCustomerId(String(parsed.linkedCustomerId || ""));
      setLinkedCustomerLabel(String(parsed.linkedCustomerLabel || ""));
      setItems(Array.isArray(parsed.items) ? parsed.items : []);
      setAmountPaid(String(parsed.amountPaid || ""));
      setAmountTouched(Boolean(String(parsed.amountPaid || "").trim()));
      setPaymentMethod((parsed.paymentMethod as "" | "cash" | "momo" | "transfer" | "credit") || "");
      setPaymentCaptureMode(
        (parsed.paymentCaptureMode as "record_existing" | "initiate_momo") || "record_existing",
      );
      setMomoProvider((parsed.momoProvider as "mtn" | "vodafone" | "airteltigo") || "mtn");
      setPaymentReference(String(parsed.paymentReference || ""));
      setShiftSession(String(parsed.shiftSession || "MORNING"));
      setCustomShiftSession(String(parsed.customShiftSession || ""));
      setMarkDeliveredNow(parsed.markDeliveredNow !== false);
      setDiscountAmount(String(parsed.discountAmount || ""));
      setDiscountReason(String(parsed.discountReason || ""));
      setDraftAvailableAt(null);
      setPendingDraft(null);
      toast.success("Recovered recent OTC draft.");
    } catch {
      toast.error("Failed to restore OTC draft.");
    }
  }

  function discardDraft() {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(OTC_DRAFT_KEY);
    setDraftAvailableAt(null);
    setPendingDraft(null);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      ts: Date.now(),
      walkInName,
      walkInPhone,
      allowAnonymousSale,
      anonymousReason,
      linkedCustomerId,
      linkedCustomerLabel,
      items,
      amountPaid,
      paymentMethod,
      paymentCaptureMode,
      momoProvider,
      paymentReference,
      shiftSession,
      customShiftSession,
      markDeliveredNow,
      discountAmount,
      discountReason,
    };
    const hasContent =
      walkInName.trim() ||
      walkInPhone.trim() ||
      items.length > 0 ||
      amountPaid.trim() ||
      paymentReference.trim() ||
      discountAmount.trim();
    if (!hasContent && pendingDraft) {
      return;
    }
    if (hasContent) {
      window.localStorage.setItem(OTC_DRAFT_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(OTC_DRAFT_KEY);
    }
  }, [
    walkInName,
    walkInPhone,
    allowAnonymousSale,
    anonymousReason,
    linkedCustomerId,
    linkedCustomerLabel,
    items,
    amountPaid,
    paymentMethod,
    paymentCaptureMode,
    momoProvider,
    paymentReference,
    shiftSession,
    customShiftSession,
    markDeliveredNow,
    discountAmount,
    discountReason,
    pendingDraft,
  ]);

  const addItemRef = useRef(addItem);
  const submitOrderRef = useRef(submitOrder);
  addItemRef.current = addItem;
  submitOrderRef.current = submitOrder;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      const typingTarget =
        active &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
      if (typingTarget) return;
      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        if (canCreateSale && !submitting) addItemRef.current();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canCreateSale && !submitting) {
          void submitOrderRef.current();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canCreateSale, submitting]);

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

  return (
    <section className="container mx-auto max-w-5xl py-8 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">OTC Quick Sale</h1>
          <p className="text-sm text-muted-foreground">
            Fast walk-in checkout for counter sales.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Keyboard shortcuts: <span className="font-medium">Alt+I</span> add item,{" "}
            <span className="font-medium">Alt+S</span> submit sale.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/orders?customerType=WALK_IN">
            <Button className="w-full sm:w-auto" variant="secondary">OTC Orders</Button>
          </Link>
          <Link href="/admin/orders">
            <Button className="w-full sm:w-auto" variant="outline">All Orders</Button>
          </Link>
        </div>
      </div>
      <div
        className="sticky z-20 rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
        style={{ top: "var(--admin-nav-height, 4rem)" }}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {["Customer", "Items", "Payment", "Confirm"].map((step, index) => {
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
      {draftAvailableAt ? (
        <Card className="border-amber-300 bg-amber-50/70 shadow-sm">
          <CardContent className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              Unsaved OTC draft found from {new Date(draftAvailableAt).toLocaleTimeString()}.
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={restoreDraft}>
                Restore Draft
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={discardDraft}>
                Discard Draft
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Customer</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="mb-1 block text-sm font-medium">
              Walk-in Name <span className="text-red-600">*</span>
            </label>
            <Input
              value={walkInName}
              onChange={(e) => {
                setWalkInName(e.target.value);
                if (suppressAutoSuggest) setSuppressAutoSuggest(false);
                if (errors.walkInName) setErrors((prev) => ({ ...prev, walkInName: "" }));
              }}
              placeholder="e.g., Ama Mensah"
              className={errors.walkInName ? "border-red-500" : ""}
            />
            {errors.walkInName ? <p className="mt-1 text-xs text-red-600">{errors.walkInName}</p> : null}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Phone (optional)</label>
            <Input
              value={walkInPhone}
              onChange={(e) => {
                setWalkInPhone(e.target.value);
                if (suppressAutoSuggest) setSuppressAutoSuggest(false);
                if (errors.walkInPhone) setErrors((prev) => ({ ...prev, walkInPhone: "" }));
              }}
              placeholder="0241234567"
              className={errors.walkInPhone ? "border-red-500" : ""}
            />
            {walkInPhone.trim() && normalizedPhone !== walkInPhone.trim() ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Digits-only phone for MoMo: {normalizedPhone || "-"}
              </p>
            ) : null}
            {errors.walkInPhone ? <p className="mt-1 text-xs text-red-600">{errors.walkInPhone}</p> : null}
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              onClick={findCustomerMatches}
              disabled={findingMatches}
              className="w-full sm:w-auto"
            >
              {findingMatches ? "Finding..." : "Find Customer Match"}
            </Button>
          </div>
          <div className="sm:col-span-2 lg:col-span-3 rounded border border-amber-300 bg-amber-50/70 p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allowAnonymousSale}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAllowAnonymousSale(checked);
                  if (!checked) {
                    setAnonymousReason("");
                    if (errors.anonymousReason) setErrors((prev) => ({ ...prev, anonymousReason: "" }));
                  }
                }}
              />
              Allow anonymous walk-in sale (exception only)
            </label>
            {allowAnonymousSale ? (
              <div className="mt-2">
                <label className="mb-1 block text-sm font-medium">
                  Anonymous reason <span className="text-red-600">*</span>
                </label>
                <Input
                  value={anonymousReason}
                  onChange={(e) => {
                    setAnonymousReason(e.target.value);
                    if (errors.anonymousReason) setErrors((prev) => ({ ...prev, anonymousReason: "" }));
                  }}
                  placeholder="e.g., Customer declined to share details"
                  className={errors.anonymousReason ? "border-red-500" : ""}
                />
                {errors.anonymousReason ? (
                  <p className="mt-1 text-xs text-red-600">{errors.anonymousReason}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          {linkedCustomerId ? (
            <div className="sm:col-span-2 lg:col-span-3 rounded border border-emerald-300 bg-emerald-50 p-2.5 text-sm">
              Linked customer: <span className="font-medium">{linkedCustomerLabel}</span>
              <div className="mt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setLinkedCustomerId("");
                    setLinkedCustomerLabel("");
                  }}
                >
                  Unlink
                </Button>
              </div>
            </div>
          ) : null}
          {sortedSuggestions.length > 0 ? (
            <div className="sm:col-span-2 lg:col-span-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                Suggested matches. Registered customers can be linked; prior walk-ins can be reused.
              </p>
              {!linkedCustomerId && topSuggestion && topSuggestion.source !== "WALK_IN_HISTORY" ? (
                <div className="flex flex-col gap-2 rounded border border-sky-300 bg-sky-50 p-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <span className="font-medium">Top suggestion:</span>{" "}
                    {topSuggestion.name || topSuggestion.email || topSuggestion.id}
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      ({topSuggestion.phone || "-"})
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setLinkedCustomerId(topSuggestion.id);
                      setLinkedCustomerLabel(topSuggestion.name || topSuggestion.email || topSuggestion.id);
                      if (topSuggestion.name?.trim()) {
                        setWalkInName(topSuggestion.name.trim());
                        if (errors.walkInName) {
                          setErrors((prev) => ({ ...prev, walkInName: "" }));
                        }
                      }
                      if (topSuggestion.phone) {
                        setWalkInPhone(topSuggestion.phone);
                        if (errors.walkInPhone) {
                          setErrors((prev) => ({ ...prev, walkInPhone: "" }));
                        }
                      }
                      setSuppressAutoSuggest(false);
                      setSuggestions([]);
                    }}
                  >
                    Link Top Suggestion
                  </Button>
                </div>
              ) : null}
              <div className="space-y-2">
                {visibleSuggestions.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-col gap-2 rounded border bg-background p-2.5 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium">{row.name || row.email || row.id}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.phone || "-"} {row.email ? `- ${row.email}` : ""}{" "}
                        {row.source === "WALK_IN_HISTORY" ? "- prior walk-in" : ""}
                      </div>
                    </div>
                    {row.source === "WALK_IN_HISTORY" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full sm:w-auto"
                        onClick={() => {
                          setSuppressAutoSuggest(true);
                          setWalkInName(row.name || "");
                          setWalkInPhone(row.phone || "");
                          setLinkedCustomerId("");
                          setLinkedCustomerLabel("");
                          setSuggestions([]);
                        }}
                      >
                        Use Walk-in Details
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full sm:w-auto"
                        onClick={() => {
                          setLinkedCustomerId(row.id);
                          setLinkedCustomerLabel(row.name || row.email || row.id);
                          if (row.name?.trim()) {
                            setWalkInName(row.name.trim());
                            if (errors.walkInName) {
                              setErrors((prev) => ({ ...prev, walkInName: "" }));
                            }
                          }
                          if (row.phone) {
                            setWalkInPhone(row.phone);
                            if (errors.walkInPhone) {
                              setErrors((prev) => ({ ...prev, walkInPhone: "" }));
                            }
                          }
                          setSuppressAutoSuggest(false);
                          setSuggestions([]);
                        }}
                      >
                        Link Customer
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Items</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2 lg:col-span-2">
              <label className="mb-1 block text-sm font-medium">Product</label>
              <Select
                value={productId}
                onValueChange={(value) => {
                  setProductId(value);
                  if (errors.productId) setErrors((prev) => ({ ...prev, productId: "" }));
                }}
              >
                <SelectTrigger className={`w-full ${errors.productId ? "border-red-500" : ""}`}>
                  <SelectValue placeholder="Select product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} - {formatCurrency(Number(p.price))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.productId ? <p className="mt-1 text-xs text-red-600">{errors.productId}</p> : null}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Quantity</label>
              <Input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  if (errors.quantity) setErrors((prev) => ({ ...prev, quantity: "" }));
                }}
                className={errors.quantity ? "border-red-500" : ""}
              />
              {errors.quantity ? <p className="mt-1 text-xs text-red-600">{errors.quantity}</p> : null}
            </div>
            <div>
              <Button type="button" onClick={addItem} className="w-full" disabled={!canCreateSale}>
                Add Item
              </Button>
            </div>
          </div>

          {errors.items ? <p className="text-xs text-red-600">{errors.items}</p> : null}

          {items.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.productId} className="border-b last:border-0">
                      <td className="px-3 py-2">{it.name}</td>
                      <td className="px-3 py-2 text-right">{it.quantity}</td>
                      <td className="px-3 py-2 text-right">{formatCurrency(it.price)}</td>
                      <td className="px-3 py-2 text-right">
                        {formatCurrency(it.price * it.quantity)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => removeItem(it.productId)}
                          disabled={!canCreateSale}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Payment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!shiftClosedStatus?.isOpen && !shiftClosedStatus?.isClosed ? (
            <div className="rounded border border-blue-300 bg-blue-50 p-3 text-sm">
              <p className="font-medium text-blue-800">
                OTC shift is not open for {shiftClosedStatus?.day || "today"}.
              </p>
              <p className="text-xs text-blue-700 mt-1">
                Open shift before creating OTC sales.
                {!shiftClosedStatus?.canOpenNow
                  ? ` Staff can open after ${String(shiftClosedStatus?.openWindowStartHourUtc ?? 6).padStart(2, "0")}:00 UTC.`
                  : ""}
              </p>
              <div className="mt-2">
                <div className="mb-2 grid gap-2 sm:grid-cols-2">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={openingCashFloat}
                    onChange={(e) => setOpeningCashFloat(e.target.value)}
                    placeholder="Opening cash float"
                  />
                  <Input
                    value={openingNote}
                    onChange={(e) => setOpeningNote(e.target.value)}
                    placeholder="Opening note (optional)"
                  />
                </div>
                {shiftClosedStatus?.requiresHandoverAck && shiftClosedStatus?.lastClose ? (
                  <div className="mb-2 rounded border border-blue-200 bg-white p-2 text-xs text-blue-900 space-y-2">
                    <div>
                      Handover from last close ({shiftClosedStatus.lastClose.shiftCloseId.slice(0, 8)}...)
                    </div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={handoverAcknowledged}
                        onChange={(e) => setHandoverAcknowledged(e.target.checked)}
                      />
                      I acknowledge handover from previous shift
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={handoverCashCountVerified}
                        onChange={(e) => setHandoverCashCountVerified(e.target.checked)}
                      />
                      Cash count verified
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={handoverPaymentSummaryVerified}
                        onChange={(e) => setHandoverPaymentSummaryVerified(e.target.checked)}
                      />
                      Payment summary verified
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={handoverPendingItemsReviewed}
                        onChange={(e) => setHandoverPendingItemsReviewed(e.target.checked)}
                      />
                      Pending items reviewed
                    </label>
                    <Input
                      value={handoverNotes}
                      onChange={(e) => setHandoverNotes(e.target.value)}
                      placeholder="Handover notes (optional)"
                    />
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={openShiftNow}
                  disabled={
                    openingShift ||
                    !canCreateSale ||
                    !shiftClosedStatus?.canOpenNow ||
                    Boolean(
                      shiftClosedStatus?.requiresHandoverAck &&
                        (!handoverAcknowledged ||
                          !handoverCashCountVerified ||
                          !handoverPaymentSummaryVerified ||
                          !handoverPendingItemsReviewed),
                    )
                  }
                >
                  {openingShift ? "Opening..." : "Open Shift"}
                </Button>
              </div>
            </div>
          ) : null}
          {shiftClosedStatus?.isClosed ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-800">
                OTC shift is closed for {shiftClosedStatus.day}.
              </p>
              <p className="text-xs text-amber-700 mt-1">
                Staff cannot create new OTC sales after close.
                {shiftClosedStatus.closedBy?.name
                  ? ` Closed by ${shiftClosedStatus.closedBy.name}.`
                  : ""}
              </p>
              {canVoidSale ? (
                <div className="mt-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={forceClosedShiftOverride}
                      onChange={(e) => {
                        setForceClosedShiftOverride(e.target.checked);
                        if (!e.target.checked) {
                          setClosedShiftOverrideReason("");
                          if (errors.closedShiftOverrideReason) {
                            setErrors((prev) => ({ ...prev, closedShiftOverrideReason: "" }));
                          }
                        }
                      }}
                    />
                    Admin override for emergency sale
                  </label>
                  {forceClosedShiftOverride ? (
                    <div>
                      <label className="mb-1 block text-sm font-medium">
                        Override reason <span className="text-red-600">*</span>
                      </label>
                      <Input
                        value={closedShiftOverrideReason}
                        onChange={(e) => {
                          setClosedShiftOverrideReason(e.target.value);
                          if (errors.closedShiftOverrideReason) {
                            setErrors((prev) => ({ ...prev, closedShiftOverrideReason: "" }));
                          }
                        }}
                        placeholder="Explain why this sale is allowed after shift close."
                        className={errors.closedShiftOverrideReason ? "border-red-500" : ""}
                      />
                      {errors.closedShiftOverrideReason ? (
                        <p className="mt-1 text-xs text-red-600">
                          {errors.closedShiftOverrideReason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!canCreateSale ? (
            <div className="rounded border border-slate-300 bg-slate-50 p-3 text-sm">
              View-only mode: accountants can review OTC details but cannot create, void, or open shifts.
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Shift / Session</label>
              <Select value={shiftSession} onValueChange={setShiftSession}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select shift/session" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MORNING">Morning Shift</SelectItem>
                  <SelectItem value="AFTERNOON">Afternoon Shift</SelectItem>
                  <SelectItem value="EVENING">Evening Shift</SelectItem>
                  <SelectItem value="CUSTOM">Custom Session</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                  ? "MoMo Request Amount"
                  : "Amount Paid Now"}
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amountPaid}
                onChange={(e) => {
                  setAmountTouched(true);
                  setAmountPaid(e.target.value);
                  if (errors.amountPaid) setErrors((prev) => ({ ...prev, amountPaid: "" }));
                }}
                className={errors.amountPaid ? "border-red-500" : ""}
                disabled={!canCreateSale || paymentMethod === "credit"}
              />
              {paymentMethod === "credit" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Credit mode keeps amount at 0. Record payment later from the order.
                </p>
              ) : null}
              {errors.amountPaid ? <p className="mt-1 text-xs text-red-600">{errors.amountPaid}</p> : null}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Payment Method</label>
              <Select
                value={paymentMethod || undefined}
                onValueChange={(value: "" | "cash" | "momo" | "transfer" | "credit") => {
                  setPaymentMethod(value);
                  setPaymentCaptureMode(value === "momo" ? "initiate_momo" : "record_existing");
                  if (value === "credit") {
                    setAmountPaid("0");
                    setAmountTouched(true);
                    setPaymentReference("");
                  }
                  setErrors((prev) => ({
                    ...prev,
                    amountPaid: "",
                    paymentReference: "",
                    paymentMethod: "",
                    walkInPhone: "",
                  }));
                }}
                disabled={!canCreateSale}
              >
                <SelectTrigger className={`w-full ${errors.paymentMethod ? "border-red-500" : ""}`}>
                  <SelectValue placeholder="Select payment method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="momo">MoMo</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="credit">Credit</SelectItem>
                </SelectContent>
              </Select>
              {errors.paymentMethod ? (
                <p className="mt-1 text-xs text-red-600">{errors.paymentMethod}</p>
              ) : null}
            </div>
            {isAdmin ? (
              <div>
                <label className="mb-1 block text-sm font-medium">Discount Amount (admin)</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discountAmount}
                  onChange={(e) => {
                    const nextValue = e.target.value;
                    setDiscountAmount(nextValue);
                    if (paymentMethod === "credit") {
                      setAmountPaid("0");
                      setAmountTouched(true);
                      return;
                    }
                    const parsed = Number(nextValue || 0);
                    const boundedDiscount =
                      Number.isFinite(parsed) && parsed > 0
                        ? Math.min(subtotal, parsed)
                        : 0;
                    const nextTotal = Math.max(0, subtotal - boundedDiscount);
                    setAmountPaid(nextTotal > 0 ? nextTotal.toFixed(2) : "0");
                    setAmountTouched(false);
                    if (errors.amountPaid) setErrors((prev) => ({ ...prev, amountPaid: "" }));
                  }}
                  placeholder="0.00"
                  disabled={!canCreateSale}
                />
              </div>
            ) : null}
            {isAdmin ? (
              <div className="sm:col-span-2 lg:col-span-3">
                <label className="mb-1 block text-sm font-medium">
                  Discount reason {normalizedDiscount > 0 ? <span className="text-red-600">*</span> : null}
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
                  className={errors.discountReason ? "border-red-500" : ""}
                  disabled={!canCreateSale}
                />
                {errors.discountReason ? (
                  <p className="mt-1 text-xs text-red-600">{errors.discountReason}</p>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAmountTouched(true);
                  setAmountPaid(total > 0 ? total.toFixed(2) : "");
                  if (errors.amountPaid) setErrors((prev) => ({ ...prev, amountPaid: "" }));
                }}
                className="w-full"
                disabled={!canCreateSale || paymentMethod === "credit"}
              >
                {paymentMethod === "credit" ? "Set Full Payment (disabled for credit)" : "Set Full Payment"}
              </Button>
            </div>
          </div>
          {paymentMethod === "momo" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">Payment Capture Mode</label>
              <Select
                value={paymentCaptureMode}
                onValueChange={(value: "record_existing" | "initiate_momo") => {
                  setPaymentCaptureMode(value);
                  if (errors.paymentReference) setErrors((prev) => ({ ...prev, paymentReference: "" }));
                  if (value === "initiate_momo") {
                    setPaymentMethod("momo");
                    setPaymentReference("");
                  }
                }}
                disabled={!canCreateSale}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="initiate_momo">Live MoMo Request (Recommended)</SelectItem>
                  <SelectItem value="record_existing">Record Existing External Payment</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Live request: sends prompt to customer phone now. Record existing: logs a payment already confirmed outside the system.
              </p>
            </div>
          ) : null}
          {shiftSession === "CUSTOM" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">Custom Session Label</label>
              <Input
                value={customShiftSession}
                onChange={(e) => setCustomShiftSession(e.target.value)}
                placeholder="e.g., Night Relief (Cashier A)"
                disabled={!canCreateSale}
              />
            </div>
          ) : null}
          {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">MoMo Provider</label>
              <Select
                value={momoProvider}
                onValueChange={(value: "mtn" | "vodafone" | "airteltigo") => setMomoProvider(value)}
                disabled={!canCreateSale}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtn">MTN</SelectItem>
                  <SelectItem value="vodafone">Vodafone</SelectItem>
                  <SelectItem value="airteltigo">AirtelTigo</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo" ? (
            <p className="text-xs text-muted-foreground">
              Mode: order is created first, then MoMo request is sent to customer phone.
            </p>
          ) : null}
          {paymentCaptureMode === "record_existing" &&
          (paymentMethod === "transfer" || paymentMethod === "momo") ? (
            <div>
              <label className="mb-1 block text-sm font-medium">
                Payment Reference <span className="text-red-600">*</span>
              </label>
              <Input
                value={paymentReference}
                onChange={(e) => {
                  setPaymentReference(e.target.value);
                  if (errors.paymentReference) setErrors((prev) => ({ ...prev, paymentReference: "" }));
                }}
                placeholder={
                  paymentMethod === "momo"
                    ? "e.g., MOMO TXN ID"
                    : "e.g., bank transfer reference"
                }
                className={errors.paymentReference ? "border-red-500" : ""}
                disabled={!canCreateSale}
              />
              {errors.paymentReference ? (
                <p className="mt-1 text-xs text-red-600">{errors.paymentReference}</p>
              ) : null}
            </div>
          ) : null}
          {!walkInName.trim() && allowAnonymousSale ? (
            <p className="text-xs text-amber-700">
              Anonymous OTC sales require full payment. Use <span className="font-medium">Set Full Payment</span>.
            </p>
          ) : null}
          {paymentMethod !== "credit" && Number(amountPaid || 0) <= 0 ? (
            <p className="text-xs text-muted-foreground">
              No upfront payment entered. Sale will be created with outstanding balance.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            OTC orders default to <span className="font-medium">Delivered</span>. If live MoMo is pending, hold release until status is successful.
          </p>
          <div className="rounded border bg-background/70 p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={markDeliveredNow}
                onChange={(e) => setMarkDeliveredNow(e.target.checked)}
                disabled={!canCreateSale}
              />
              Mark delivered now (default)
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              Uncheck to create this OTC order as <span className="font-medium">Not delivered</span> and fulfill later.
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                Payment type:{" "}
                <span className="font-medium">{paymentMethod || "none"}</span>
              </span>
              <span>
                Will mark delivery as:{" "}
                <span className="font-medium">
                  {markDeliveredNow ? "Delivered now" : "Not delivered"}
                </span>
              </span>
              <span>
                Will create status:{" "}
                <span className="font-medium">
                  {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                    ? "UNPAID (pending MoMo approval)"
                    : predictedStatus}
                </span>
              </span>
              <span>
                Payment flow:{" "}
                <span className="font-medium">
                  {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                    ? "Live MoMo request"
                    : paymentMethod
                      ? "Recorded payment"
                      : "No upfront payment"}
                </span>
              </span>
            </div>
          </div>

          <div className="rounded-md border bg-muted/20 p-4 text-sm">
            <div className="flex justify-between py-1">
              <span>Order Total</span>
              <span className="font-medium">{formatCurrency(total)}</span>
            </div>
            {normalizedDiscount > 0 ? (
              <div className="flex justify-between py-1">
                <span>Discount</span>
                <span>-{formatCurrency(normalizedDiscount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between py-1">
              <span>Amount Paid</span>
              <span>{formatCurrency(Number(amountPaid || 0))}</span>
            </div>
            <div className="flex justify-between py-1 font-semibold">
              <span>Balance</span>
              <span>{formatCurrency(Math.max(0, total - Number(amountPaid || 0)))}</span>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={() => {
                void submitOrder(false);
              }}
              disabled={
                !canCreateSale ||
                submitting ||
                items.length === 0 ||
                Boolean(!shiftClosedStatus?.isOpen && !shiftClosedStatus?.isClosed) ||
                Boolean(shiftClosedStatus?.isClosed && !canVoidSale) ||
                Boolean(shiftClosedStatus?.isClosed && canVoidSale && !forceClosedShiftOverride)
              }
            >
              {submitting
                ? "Creating..."
                : paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                  ? "Create Sale + Request MoMo"
                  : "Complete OTC Sale"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Shortcuts: <span className="font-medium">Alt+I</span> add item,{" "}
            <span className="font-medium">Alt+S</span> submit sale.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {lastValidationAt
              ? `Last validation check: ${lastValidationAt.toLocaleTimeString()}`
              : "Validation check will appear after first submit attempt."}
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle>Confirm OTC Sale</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded border bg-muted/30 p-3 space-y-1">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Customer</span>
                <span className="font-medium">
                  {(linkedCustomerLabel || walkInName || "Walk-in Anonymous").trim() || "Walk-in Anonymous"}
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
                <span className="text-muted-foreground">Payment</span>
                <span className="font-medium">
                  {paymentMethod || "none"}
                  {paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                    ? " (live request)"
                    : ""}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Delivery</span>
                <span className="font-medium">{markDeliveredNow ? "Delivered now" : "Not delivered"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {normalizedDiscount > 0 ? (
                <div className="flex justify-between gap-2 text-amber-700">
                  <span>Discount</span>
                  <span>-{formatCurrency(normalizedDiscount)}</span>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Amount paid now</span>
                <span>{formatCurrency(Number(amountPaid || 0))}</span>
              </div>
              <div className="flex justify-between gap-2 border-t pt-1 font-semibold">
                <span>Total / Balance</span>
                <span>
                  {formatCurrency(total)} / {formatCurrency(Math.max(0, total - Number(amountPaid || 0)))}
                </span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  void submitOrder(true);
                }}
                disabled={submitting}
              >
                {submitting
                  ? "Creating..."
                  : paymentMethod === "momo" && paymentCaptureMode === "initiate_momo"
                    ? "Confirm & Create + Request MoMo"
                    : "Confirm & Complete Sale"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {postingIssue ? (
        <Card className="border-amber-300 bg-amber-50/70 shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Journal Posting Attention Needed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Order <span className="font-mono">{postingIssue.orderId}</span> was created, but posting is not fully
              complete.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded border bg-background p-2">
                <div className="text-xs text-muted-foreground">Order journal status</div>
                <div className="font-medium">{postingIssue.orderStatus}</div>
                {postingIssue.orderError ? (
                  <div className="text-xs text-red-600 mt-1">{postingIssue.orderError}</div>
                ) : null}
              </div>
              <div className="rounded border bg-background p-2">
                <div className="text-xs text-muted-foreground">Payment journal status</div>
                <div className="font-medium">
                  {postingIssue.paymentExpected ? postingIssue.paymentStatus : "NOT_REQUIRED"}
                </div>
                {postingIssue.paymentError ? (
                  <div className="text-xs text-red-600 mt-1">{postingIssue.paymentError}</div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={retryOrderPosting} disabled={retryPosting}>
                {retryPosting ? "Retrying..." : "Retry Posting Now"}
              </Button>
              <Link href={`/admin/orders/${postingIssue.orderId}/receipt`} target="_blank">
                <Button type="button" variant="outline">Print Receipt</Button>
              </Link>
              <Link href={`/admin/orders/${postingIssue.orderId}`}>
                <Button type="button" variant="outline">Open Order</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {completedOrderId && !postingIssue ? (
        <Card className="border-emerald-300 bg-emerald-50/70 shadow-sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Sale Completed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              OTC sale created successfully. Order ID:{" "}
              <span className="font-mono">{completedOrderId}</span>
            </p>
            {momoPending && momoPending.orderId === completedOrderId ? (
              <div className="rounded border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm font-medium text-amber-800">
                  MoMo payment pending approval. Do not release items yet.
                </p>
                <p className="text-xs text-amber-700 mt-1">
                  Status: {momoPending.status}
                  {momoPending.providerRef ? ` - Ref: ${momoPending.providerRef}` : ""}
                  {momoPending.lastCheckedAt
                    ? ` - Last check: ${momoPending.lastCheckedAt.toLocaleTimeString()}`
                    : ""}
                </p>
                <div className="mt-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => refreshPendingMomoStatus(true)}>
                    Refresh MoMo Status
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Link href={`/admin/orders/${completedOrderId}/receipt`} target="_blank">
                <Button
                  type="button"
                  disabled={Boolean(momoPending && momoPending.orderId === completedOrderId)}
                >
                  Print Receipt
                </Button>
              </Link>
              <Link href={`/admin/orders/${completedOrderId}`}>
                <Button type="button" variant="outline">Open Order</Button>
              </Link>
              <Link href={`/admin/audit?entityType=ORDER&entityId=${completedOrderId}`}>
                <Button type="button" variant="outline">Open Audit Trail</Button>
              </Link>
              <Button type="button" variant="outline" onClick={resetSaleForm}>
                Start New Sale
              </Button>
            </div>
            {canVoidSale ? (
              <div className="rounded border border-red-300 bg-red-50 p-3">
                <p className="text-xs text-red-700 mb-2">
                  Void sale is admin-only and should be used for true counter mistakes.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={voidReason}
                    onChange={(e) => setVoidReason(e.target.value)}
                    placeholder="Void reason (required)"
                  />
                  <Button type="button" variant="destructive" onClick={voidCompletedOrder} disabled={voidingOrder}>
                    {voidingOrder ? "Voiding..." : "Void Sale"}
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}






