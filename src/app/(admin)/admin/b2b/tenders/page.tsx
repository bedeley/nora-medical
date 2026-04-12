"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { formatDateGH } from "@/lib/currency";

// ─── Types ────────────────────────────────────────────────────────────────────

type TenderLine = {
  no: number;
  requestedDescription: string;
  requestedUnit: string;
  quantity: number;
  matchedProductId?: string | null;
  matchedProductName: string | null;
  matchedSku: string | null;
  availableStock: number | null;
  baseCost?: number | null;
  marginPct?: number | null;
  unitPrice: number;
  lineTotal: number;
  matchConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  bidDisposition?: "AVAILABLE" | "SUBSTITUTE" | "NO_BID";
  note: string | null;
};

type TenderPreview = {
  lines: TenderLine[];
  subtotal: number;
  total: number;
  matchedCount: number;
  unmatchedCount: number;
  currency: string;
};

type TenderSnapshot = {
  id: string;
  tenderNumber: string;
  status: "DRAFT" | "SUBMITTED" | "SENT" | "WON" | "LOST" | "EXPIRED" | "CANCELLED";
  buyerName: string;
  buyerContact: string | null;
  buyerEmail: string | null;
  tenderRef: string | null;
  lotTitle: string | null;
  currency: string;
  validityDays: number;
  notes: string | null;
  vatRatePct?: number;
  vatAmount?: number;
  discountAmount?: number;
  freightAmount?: number;
  handlingAmount?: number;
  leadTimeDays?: number | null;
  paymentTerms?: string | null;
  marginThresholdPct?: number;
  itemsText: string;
  subtotal: number;
  lines: TenderLine[];
  total: number;
  updatedAt: string;
};

type TenderListData = {
  items: TenderSnapshot[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type LineOverride = {
  unitPrice: string;
  quantity: string;
  leadTimeDays: string;
  supplyNote: string;
  bidDisposition: "AVAILABLE" | "SUBSTITUTE" | "NO_BID";
};

type ProcurementRequestRow = {
  id: string;
  requestType: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER";
  status: "SUBMITTED" | "IN_REVIEW" | "QUOTED" | "APPROVED" | "REJECTED" | "CLOSED";
  clinicName: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  itemsText: string | null;
  updatedAt: string;
};

type ProductRow = {
  id: string;
  name: string;
  sku?: string | null;
  price: number | string;
  cost?: number | string;
  stock?: number;
  archived?: boolean;
};

type TenderVersionRow = {
  id: string;
  versionNo: number;
  status: TenderSnapshot["status"];
  changeNote: string | null;
  createdAt: string;
  availableForCompare?: boolean;
};

type ApprovalStatus = {
  requireApproval: boolean;
  makerChecker: boolean;
  latestVersionNo: number;
  approvedVersionNo: number;
  approvedAt: string | null;
  approvedByName: string | null;
  canSend: boolean;
  reason: string;
};

type TemplateRow = {
  id: string;
  name: string;
  sourceType: "PUBLIC_HOSPITAL" | "PRIVATE_CLINIC" | "NGO" | "CORPORATE" | "CUSTOM";
  validityDays?: number;
  leadTimeDays?: number;
  paymentTerms?: string;
  notes?: string;
  updatedAt: string;
};

type ReminderRow = {
  id: string;
  tenderNumber: string;
  daysToExpiry: number;
  expiryDate: string;
  isExpiringSoon: boolean;
};

type DiffLineChange = {
  item: string;
  changeType: "ADDED" | "REMOVED" | "CHANGED";
  fromQty: number;
  toQty: number;
  fromUnitPrice: number;
  toUnitPrice: number;
  fromLineTotal?: number;
  toLineTotal?: number;
};

type DiffResult = {
  from: { versionNo: number; status: string; total: number };
  to: { versionNo: number; status: string; total: number };
  totalsDelta: { subtotal: number; total: number };
  lineChanges: DiffLineChange[];
};

type TenderOrderLink = {
  tenderId: string;
  orderId: string;
  createdAt: string;
};

type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const TENDER_ALLOWED_TRANSITIONS: Record<TenderSnapshot["status"], TenderSnapshot["status"][]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["SENT", "WON", "LOST", "EXPIRED", "CANCELLED"],
  SENT: ["WON", "LOST", "EXPIRED", "CANCELLED"],
  WON: [],
  LOST: [],
  EXPIRED: [],
  CANCELLED: [],
};

// Terminal states that require confirmation before setting
const TERMINAL_STATUSES = new Set<TenderSnapshot["status"]>(["LOST", "CANCELLED", "EXPIRED", "WON"]);

// Procurement request statuses eligible as tender sources
const ACTIVE_PROCUREMENT_STATUSES: ProcurementRequestRow["status"][] = [
  "SUBMITTED",
  "IN_REVIEW",
  "QUOTED",
];

const HISTORY_PAGE_SIZE = 20;

function getTenderAllowedTargets(status: TenderSnapshot["status"]) {
  return TENDER_ALLOWED_TRANSITIONS[status] || [];
}

function isTenderSendEligible(status: TenderSnapshot["status"]) {
  return status === "SUBMITTED" || status === "SENT";
}

// ─── Helper components ────────────────────────────────────────────────────────

function TenderStatusBadge({ status }: { status: TenderSnapshot["status"] }) {
  const map: Record<TenderSnapshot["status"], { variant: "outline" | "secondary" | "warning" | "success" | "destructive" | "default"; label: string }> = {
    DRAFT:     { variant: "outline",     label: "Draft"     },
    SUBMITTED: { variant: "secondary",   label: "Submitted" },
    SENT:      { variant: "warning",     label: "Sent"      },
    WON:       { variant: "success",     label: "Won"       },
    LOST:      { variant: "destructive", label: "Lost"      },
    EXPIRED:   { variant: "outline",     label: "Expired"   },
    CANCELLED: { variant: "outline",     label: "Cancelled" },
  };
  const { variant, label } = map[status] ?? { variant: "outline", label: status };
  return <Badge variant={variant}>{label}</Badge>;
}

function DiffChangeTypeBadge({ type }: { type: DiffLineChange["changeType"] }) {
  if (type === "ADDED")   return <Badge variant="success">Added</Badge>;
  if (type === "REMOVED") return <Badge variant="destructive">Removed</Badge>;
  return <Badge variant="warning">Changed</Badge>;
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminB2BTendersPage() {
  const searchParams = useSearchParams();
  const prefillHandledRef = useRef(false);

  // Session / role
  const { data: sessionData } = useSession();
  const isAdmin = (sessionData?.user as { role?: string } | undefined)?.role === "ADMIN";

  // ── Tabs
  const [activeTab, setActiveTab] = useState<"build" | "send" | "history">("build");

  // ── Form fields
  const [buyerName, setBuyerName]           = useState("");
  const [buyerContact, setBuyerContact]     = useState("");
  const [buyerEmail, setBuyerEmail]         = useState("");
  const [tenderRef, setTenderRef]           = useState("");
  const [lotTitle, setLotTitle]             = useState("LOT 1");
  const [currency, setCurrency]             = useState("GHS");
  const [validityDays, setValidityDays]     = useState("14");
  const [notes, setNotes]                   = useState("");
  const [vatRatePct, setVatRatePct]         = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [freightAmount, setFreightAmount]   = useState("0");
  const [handlingAmount, setHandlingAmount] = useState("0");
  const [leadTimeDays, setLeadTimeDays]     = useState("");
  const [paymentTerms, setPaymentTerms]     = useState("");
  const [marginThresholdPct, setMarginThresholdPct] = useState("0");
  const [itemsText, setItemsText]           = useState("");

  // ── Preview / line review
  const [preview, setPreview]               = useState<TenderPreview | null>(null);
  const [busy, setBusy]                     = useState(false);
  const [activeTender, setActiveTender]     = useState<TenderSnapshot | null>(null);
  const [lastSavedTender, setLastSavedTender] = useState<TenderSnapshot | null>(null);
  const [lineOverrides, setLineOverrides]   = useState<Record<number, LineOverride>>({});
  const [lineResolvedProductIds, setLineResolvedProductIds] = useState<Record<number, string>>({});
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [clearedReviewLines, setClearedReviewLines] = useState<Record<number, true>>({});

  // ── Source mode
  const [sourceMode, setSourceMode] = useState<"manual" | "procurement">("manual");
  const [selectedProcurementRequestId, setSelectedProcurementRequestId] = useState("");

  // ── Send section
  const [emailTo, setEmailTo]           = useState("");
  const [emailCc, setEmailCc]           = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [sendTenderId, setSendTenderId] = useState("");
  const [sendVersionNo, setSendVersionNo] = useState<string>("");

  // ── Status management (history tab)
  const [statusByTender, setStatusByTender] = useState<Record<string, TenderSnapshot["status"]>>({});

  // ── Approval
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus | null>(null);
  const [approvalBusy, setApprovalBusy]     = useState(false);

  // ── Templates
  const [templateName, setTemplateName]           = useState("");
  const [templateSourceType, setTemplateSourceType] = useState<TemplateRow["sourceType"]>("CUSTOM");

  // ── Version compare
  const [compareFromVersion, setCompareFromVersion] = useState<string>("");
  const [compareToVersion, setCompareToVersion]     = useState<string>("");
  const [diffResult, setDiffResult]                 = useState<DiffResult | null>(null);

  // ── History search / filter / pagination
  const [historySearch, setHistorySearch]         = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<"" | TenderSnapshot["status"]>("");
  const [historyPage, setHistoryPage]             = useState(1);

  // ── Confirmation dialog
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  // ─── Data queries ────────────────────────────────────────────────────────

  const historyQueryString = useMemo(() => {
    const q = new URLSearchParams();
    q.set("page", String(historyPage));
    q.set("pageSize", String(HISTORY_PAGE_SIZE));
    if (historySearch.trim()) q.set("search", historySearch.trim());
    if (historyStatusFilter) q.set("status", historyStatusFilter);
    return q.toString();
  }, [historyPage, historySearch, historyStatusFilter]);

  const { data, refetch } = useClientQuery<TenderListData>({
    queryKey: ["admin", "b2b-tenders", historyQueryString],
    queryFn: () => fetcher(`/api/admin/b2b/tenders?${historyQueryString}`),
  });

  const { data: procurementData } = useClientQuery<{ items: ProcurementRequestRow[] }>({
    queryKey: ["admin", "b2b-procurement-requests", "for-tender-source"],
    queryFn: () => fetcher("/api/admin/b2b/procurement/requests"),
  });

  const { data: productsData } = useClientQuery<{ items: ProductRow[] }>({
    queryKey: ["products", "tender-builder", { pageSize: 500, includeArchived: 0 }],
    queryFn: () => fetcher("/api/products?pageSize=500&includeArchived=0"),
  });

  const history = useMemo(() => data?.items || [], [data?.items]);
  const historyTotalCount = data?.totalCount ?? history.length;
  const historyPageCount = data?.totalPages ?? Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));

  const procurementRequests = useMemo(() => procurementData?.items || [], [procurementData?.items]);

  // BUG-5 FIX: use productsData?.items as the dependency
  const products = useMemo(() => productsData?.items || [], [productsData?.items]);

  const { data: versionsData } = useClientQuery<{ items: TenderVersionRow[] }>({
    queryKey: ["admin", "b2b-tender-versions", sendTenderId || "__none__"],
    queryFn: () =>
      sendTenderId
        ? fetcher(`/api/admin/b2b/tenders/${sendTenderId}/versions`)
        : Promise.resolve({ items: [] }),
  });

  const versions = useMemo(() => versionsData?.items || [], [versionsData?.items]);
  const comparableVersions = useMemo(
    () => versions.filter((v) => v.availableForCompare !== false),
    [versions],
  );

  const { data: templatesData, refetch: refetchTemplates } = useClientQuery<{ items: TemplateRow[] }>({
    queryKey: ["admin", "b2b-tender-templates"],
    queryFn: () => fetcher("/api/admin/b2b/tender-templates"),
  });
  const templates = templatesData?.items || [];

  const { data: remindersData, refetch: refetchReminders } = useClientQuery<{ items: ReminderRow[] }>({
    queryKey: ["admin", "b2b-tender-reminders"],
    queryFn: () => fetcher("/api/admin/b2b/tenders/reminders"),
  });

  const tenderIdsCsv = useMemo(() => history.map((row) => row.id).join(","), [history]);
  const { data: orderLinksData } = useClientQuery<{ items: TenderOrderLink[] }>({
    queryKey: ["admin", "b2b-tender-order-links", tenderIdsCsv || "__none__"],
    queryFn: () =>
      tenderIdsCsv
        ? fetcher(`/api/admin/b2b/tenders/order-links?ids=${encodeURIComponent(tenderIdsCsv)}`)
        : Promise.resolve({ items: [] }),
  });

  const reminders = useMemo(() => remindersData?.items || [], [remindersData?.items]);
  const orderLinks = useMemo(() => orderLinksData?.items || [], [orderLinksData?.items]);
  const sendEligibleTenders = useMemo(
    () => history.filter((row) => isTenderSendEligible(row.status)),
    [history],
  );
  const selectedSendTender = useMemo(
    () => history.find((row) => row.id === sendTenderId) || null,
    [history, sendTenderId],
  );

  const reminderByTenderId = useMemo(
    () => new Map(reminders.map((row) => [row.id, row])),
    [reminders],
  );
  const orderLinkByTenderId = useMemo(
    () => new Map(orderLinks.map((row) => [row.tenderId, row])),
    [orderLinks],
  );

  // Tenders expiring soon (for banner)
  const expiringSoon = useMemo(
    () => reminders.filter((r) => r.isExpiringSoon).sort((a, b) => a.daysToExpiry - b.daysToExpiry),
    [reminders],
  );

  // ─── Derived preview data ─────────────────────────────────────────────────

  const summaryText = useMemo(() => {
    if (!preview) return "";
    return `Matched ${preview.matchedCount}/${preview.lines.length} lines`;
  }, [preview]);

  const updateLineOverride = (lineNo: number, patch: Partial<LineOverride>) => {
    setClearedReviewLines((prev) => {
      if (!prev[lineNo]) return prev;
      const next = { ...prev };
      delete next[lineNo];
      return next;
    });
    setLineOverrides((prev) => ({
      ...prev,
      [lineNo]: {
        unitPrice:     prev[lineNo]?.unitPrice     || "",
        quantity:      prev[lineNo]?.quantity      || "",
        leadTimeDays:  prev[lineNo]?.leadTimeDays  || "",
        supplyNote:    prev[lineNo]?.supplyNote    || "",
        bidDisposition: prev[lineNo]?.bidDisposition || "AVAILABLE",
        ...patch,
      },
    }));
  };

  const isOutOfStockLine = (line: TenderLine, bidDisposition?: "AVAILABLE" | "SUBSTITUTE" | "NO_BID") => {
    const disposition = bidDisposition || line.bidDisposition || "AVAILABLE";
    if (disposition === "NO_BID") return false;
    const stock = Number(line.availableStock ?? NaN);
    if (!Number.isFinite(stock)) return false;
    return stock < line.quantity;
  };

  const hasSplitSupplyNote = (note: string, availableNow: number, balance: number) => {
    const clean = note.trim();
    if (!clean) return false;
    return clean.includes(String(availableNow)) && clean.includes(String(balance));
  };

  const isAutoSupplyNoteFormat = (note: string) => {
    return /^\d+\s+available now,\s+\d+\s+in\s+\d+\s+days?$/i.test(note.trim());
  };

  const setLineBidDisposition = (lineNo: number, bidDisposition: "AVAILABLE" | "SUBSTITUTE" | "NO_BID") => {
    setClearedReviewLines((prev) => {
      if (!prev[lineNo]) return prev;
      const next = { ...prev };
      delete next[lineNo];
      return next;
    });
    if (bidDisposition === "NO_BID") {
      setLineResolvedProductIds((prev) => {
        const next = { ...prev };
        delete next[lineNo];
        return next;
      });
      updateLineOverride(lineNo, { bidDisposition, unitPrice: "0", leadTimeDays: "" });
      setReviewConfirmed(false);
      return;
    }
    updateLineOverride(lineNo, { bidDisposition });
    setReviewConfirmed(false);
  };

  // ─── Effective lines (live preview with overrides applied) ────────────────

  const effectiveLines = useMemo(() => {
    if (!preview) return [];
    const productById = new Map(products.map((row) => [row.id, row]));
    return preview.lines.map((line) => {
      const ov = lineOverrides[line.no];
      const resolvedProductId = lineResolvedProductIds[line.no] || "";
      const resolvedProduct = resolvedProductId ? productById.get(resolvedProductId) : null;
      const quantity = ov?.quantity?.trim() ? Number(ov.quantity) : line.quantity;
      const bidDisposition = ov?.bidDisposition || line.bidDisposition || "AVAILABLE";
      const unitPrice = ov?.unitPrice?.trim()
        ? Number(ov.unitPrice)
        : resolvedProduct
          ? Number(resolvedProduct.price || 0)
          : line.unitPrice;
      const safeQty   = Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : line.quantity;
      const safePrice = bidDisposition === "NO_BID"
        ? 0
        : Number.isFinite(unitPrice) && unitPrice >= 0
          ? unitPrice
          : line.unitPrice;
      const cost = Number(resolvedProduct?.cost ?? line.baseCost ?? 0);
      const marginPct =
        bidDisposition === "NO_BID"
          ? null
          : cost > 0
            ? ((safePrice - cost) / cost) * 100
            : (line.marginPct ?? null);
      return {
        ...line,
        matchedProductId:   bidDisposition === "NO_BID" ? null : (resolvedProduct?.id   || line.matchedProductId),
        matchedProductName: bidDisposition === "NO_BID" ? null : (resolvedProduct?.name || line.matchedProductName),
        matchedSku:         bidDisposition === "NO_BID" ? null : (resolvedProduct?.sku  || line.matchedSku),
        availableStock:     bidDisposition === "NO_BID" ? null : resolvedProduct
          ? Number(resolvedProduct.stock || 0)
          : line.availableStock,
        matchConfidence: resolvedProduct ? "HIGH" : line.matchConfidence,
        bidDisposition,
        note: (() => {
          const tags: string[] = [];
          if (bidDisposition === "NO_BID") tags.push("No bid - discontinued");
          if (resolvedProduct) tags.push("Manually resolved");
          if (ov?.leadTimeDays?.trim()) tags.push(`Lead ${ov.leadTimeDays}d`);
          if (ov?.supplyNote?.trim()) tags.push(ov.supplyNote.trim());
          return tags.length ? tags.join("; ") : line.note;
        })(),
        baseCost:  bidDisposition === "NO_BID" ? null : line.baseCost,
        marginPct,
        quantity:  safeQty,
        unitPrice: safePrice,
        lineTotal: safeQty * safePrice,
      };
    });
  }, [lineOverrides, lineResolvedProductIds, preview, products]);

  const visiblePreviewLines = useMemo(
    () =>
      effectiveLines.filter((line) => {
        const disposition = lineOverrides[line.no]?.bidDisposition || line.bidDisposition || "AVAILABLE";
        return disposition !== "NO_BID";
      }),
    [effectiveLines, lineOverrides],
  );

  const effectiveSubtotal = useMemo(
    () => effectiveLines.reduce((sum, line) => sum + line.lineTotal, 0),
    [effectiveLines],
  );
  const effectiveVat = useMemo(
    () => effectiveSubtotal * (Math.max(0, Number(vatRatePct || 0)) / 100),
    [effectiveSubtotal, vatRatePct],
  );
  const effectiveTotal = useMemo(() => {
    const discount = Math.max(0, Number(discountAmount || 0));
    const freight  = Math.max(0, Number(freightAmount  || 0));
    const handling = Math.max(0, Number(handlingAmount || 0));
    return Math.max(0, effectiveSubtotal + effectiveVat + freight + handling - discount);
  }, [discountAmount, effectiveSubtotal, effectiveVat, freightAmount, handlingAmount]);

  const minMargin = Math.max(0, Number(marginThresholdPct || 0));

  const marginViolations = useMemo(
    () =>
      effectiveLines.filter((line) => {
        const cost = Number(line.baseCost || 0);
        if (!cost || cost <= 0) return false;
        return ((line.unitPrice - cost) / cost) * 100 < minMargin;
      }),
    [effectiveLines, minMargin],
  );

  // BUG-1 FIX: OOS lines now correctly exit with `return false` when fully remediated
  const reviewLines = useMemo(() => {
    const suspiciousPattern = /[^a-z0-9\s\-\.,\/()'&+]/i;
    return effectiveLines.filter((line) => {
      const disposition = lineOverrides[line.no]?.bidDisposition || line.bidDisposition || "AVAILABLE";
      if (disposition === "NO_BID") return false;

      if (disposition === "SUBSTITUTE") {
        return !clearedReviewLines[line.no];
      }

      const stock = Number(line.availableStock ?? 0);
      const isOutOfStock = line.availableStock != null && stock < line.quantity;

      if (isOutOfStock && clearedReviewLines[line.no]) return false;

      if (isOutOfStock) {
        const availableNow = Math.max(0, Math.floor(stock));
        const balance      = Math.max(0, line.quantity - availableNow);
        const note         = lineOverrides[line.no]?.supplyNote?.trim() || "";
        const hasLeadTime  = Boolean(lineOverrides[line.no]?.leadTimeDays?.trim());
        const hasRequiredSplitNote = hasSplitSupplyNote(note, availableNow, balance);
        // BUG-1 FIX: when both conditions met, remove from review list
        if (hasLeadTime && hasRequiredSplitNote) return false;
        return true;
      }

      if (line.matchConfidence === "NONE" && !lineResolvedProductIds[line.no]) return true;
      if (line.matchConfidence === "LOW" || line.matchConfidence === "NONE") return true;
      if (!line.requestedDescription || line.requestedDescription.trim().length < 3) return true;
      if (suspiciousPattern.test(line.requestedDescription)) return true;
      return false;
    });
  }, [clearedReviewLines, effectiveLines, lineOverrides, lineResolvedProductIds]);

  const oosPolicyViolations = useMemo(() => {
    return effectiveLines.filter((line) => {
      const disposition = lineOverrides[line.no]?.bidDisposition || line.bidDisposition || "AVAILABLE";
      if (!isOutOfStockLine(line, disposition)) return false;
      const stock        = Number(line.availableStock || 0);
      const availableNow = Math.max(0, Math.floor(stock));
      const balance      = Math.max(0, line.quantity - availableNow);
      const lead         = lineOverrides[line.no]?.leadTimeDays?.trim() || "";
      const note         = lineOverrides[line.no]?.supplyNote?.trim() || "";
      return !(Boolean(lead) && hasSplitSupplyNote(note, availableNow, balance));
    });
  }, [effectiveLines, lineOverrides]);

  // Product suggestions for unmatched lines
  const suggestionsFor = (line: TenderLine) => {
    const q = line.requestedDescription.trim().toLowerCase();
    if (!q) return products.slice(0, 20);
    const tokens = q.split(/\s+/).filter((t) => t.length >= 3).slice(0, 4);
    const scored = products
      .map((p) => {
        const hay   = `${p.name} ${p.sku || ""}`.toLowerCase();
        const score = tokens.reduce((acc, t) => (hay.includes(t) ? acc + 1 : acc), 0);
        return { p, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((row) => row.p);
    return scored.length ? scored : products.slice(0, 20);
  };

  // ─── History filtering ────────────────────────────────────────────────────

  const pagedHistory = history;

  // Reset to page 1 when filter changes
  useEffect(() => { setHistoryPage(1); }, [historySearch, historyStatusFilter]);
  useEffect(() => {
    if (historyPage > historyPageCount) setHistoryPage(historyPageCount);
  }, [historyPage, historyPageCount]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const resetForm = () => {
    setSourceMode("manual");
    setActiveTender(null);
    setBuyerName("");
    setBuyerContact("");
    setBuyerEmail("");
    setTenderRef("");
    setLotTitle("LOT 1");
    setCurrency("GHS");
    setValidityDays("14");
    setNotes("");
    setVatRatePct("0");
    setDiscountAmount("0");
    setFreightAmount("0");
    setHandlingAmount("0");
    setLeadTimeDays("");
    setPaymentTerms("");
    setMarginThresholdPct("0");
    setItemsText("");
    setPreview(null);
    setLineOverrides({});
    setLineResolvedProductIds({});
    setClearedReviewLines({});
    setReviewConfirmed(false);
    setSelectedProcurementRequestId("");
    setLastSavedTender(null);
    setActiveTab("build");
    toast.info("Form cleared. Ready for a new tender.");
  };

  const analyze = async () => {
    if (!itemsText.trim()) {
      toast.error("Paste or upload an item list first.");
      return;
    }
    try {
      setBusy(true);
      const res = await fetch("/api/admin/b2b/tenders/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemsText, currency }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; preview?: TenderPreview }));
      if (!res.ok || !body.preview) {
        toast.error(body.error || "Failed to analyze item list");
        return;
      }
      setPreview(body.preview);
      setLineOverrides({});
      setLineResolvedProductIds({});
      setClearedReviewLines({});
      setReviewConfirmed(false);
      toast.success("Item list analyzed.");
    } finally {
      setBusy(false);
    }
  };

  const saveTender = async () => {
    if (!buyerName.trim() || !itemsText.trim()) {
      toast.error("Buyer name and item list are required.");
      return;
    }
    if (reviewLines.length > 0 && !reviewConfirmed) {
      toast.error("Review and confirm low-confidence/suspicious lines before saving.");
      return;
    }
    if (marginViolations.length > 0) {
      toast.error(`Cannot save: ${marginViolations.length} line(s) are below minimum margin.`);
      return;
    }
    if (oosPolicyViolations.length > 0) {
      toast.error(
        `Cannot save: ${oosPolicyViolations.length} out-of-stock line(s) require lead time + split supply note.`,
      );
      return;
    }

    const overrideRows = Object.entries(lineOverrides)
      .map(([no, row]) => ({
        no: Number(no),
        matchedProductId: lineResolvedProductIds[Number(no)] || undefined,
        unitPrice:    row.unitPrice.trim()    ? Number(row.unitPrice)    : undefined,
        quantity:     row.quantity.trim()     ? Number(row.quantity)     : undefined,
        leadTimeDays: row.leadTimeDays.trim() ? Number(row.leadTimeDays) : undefined,
        supplyNote:   row.supplyNote.trim()   || undefined,
        bidDisposition: row.bidDisposition    || undefined,
      }))
      .concat(
        Object.entries(lineResolvedProductIds)
          .filter(([no]) => !lineOverrides[Number(no)])
          .map(([no, matchedProductId]) => ({
            no: Number(no),
            matchedProductId,
            unitPrice:     undefined,
            quantity:      undefined,
            leadTimeDays:  undefined,
            supplyNote:    undefined,
            bidDisposition: "AVAILABLE" as const,
          })),
      )
      .filter(
        (row, index, arr) =>
          (row.unitPrice != null || row.quantity != null || row.matchedProductId ||
           row.leadTimeDays != null || Boolean(row.supplyNote) || Boolean(row.bidDisposition)) &&
          arr.findIndex((x) => x.no === row.no) === index,
      );

    try {
      setBusy(true);
      const res = await fetch("/api/admin/b2b/tenders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenderId:           activeTender?.id || undefined,
          buyerName,
          buyerContact:       buyerContact      || undefined,
          buyerEmail:         buyerEmail        || undefined,
          tenderRef:          tenderRef         || undefined,
          lotTitle:           lotTitle          || undefined,
          currency,
          validityDays:       Number(validityDays || 14),
          notes:              notes             || undefined,
          vatRatePct:         Number(vatRatePct     || 0),
          discountAmount:     Number(discountAmount || 0),
          freightAmount:      Number(freightAmount  || 0),
          handlingAmount:     Number(handlingAmount || 0),
          leadTimeDays:       leadTimeDays.trim() ? Number(leadTimeDays) : undefined,
          paymentTerms:       paymentTerms.trim() || undefined,
          marginThresholdPct: Number(marginThresholdPct || 0),
          itemsText,
          lineOverrides: overrideRows,
        }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; snapshot?: TenderSnapshot }));
      if (!res.ok || !body.snapshot) {
        toast.error(body.error || "Failed to save tender");
        return;
      }
      setActiveTender(body.snapshot);
      setLastSavedTender(body.snapshot);
      setSendTenderId(body.snapshot.id);
      setPreview(null);
      setLineOverrides({});
      setLineResolvedProductIds({});
      setClearedReviewLines({});
      setReviewConfirmed(false);
      toast.success(activeTender?.id ? "Tender updated." : "Tender draft saved.");
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const uploadItems = async (file: File | null) => {
    if (!file) return;
    try {
      setBusy(true);
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/b2b/tenders/upload-items", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({} as { error?: string; itemsText?: string }));
      if (!res.ok || !body.itemsText) {
        toast.error(body.error || "Upload failed");
        return;
      }
      setItemsText(body.itemsText);
      toast.success("Item list uploaded.");
    } finally {
      setBusy(false);
    }
  };

  // BUG-3 FIX: explicit sendTenderId validation — no silent fallback to history[0]
  const sendTenderEmail = async () => {
    if (!sendTenderId) {
      toast.error("Select a tender from the dropdown first.");
      return;
    }
    const tender = history.find((row) => row.id === sendTenderId);
    if (!tender) {
      toast.error("Selected tender not found. Refresh and try again.");
      return;
    }
    if (!isTenderSendEligible(tender.status)) {
      toast.error(
        tender.status === "DRAFT"
          ? "Submit the tender before sending."
          : `Cannot send a tender with status ${tender.status}.`,
      );
      return;
    }
    if (!emailTo.trim()) {
      toast.error("Recipient email is required.");
      return;
    }
    try {
      setBusy(true);
      const res = await fetch(`/api/admin/b2b/tenders/${tender.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: emailTo.trim(),
          cc: emailCc.trim() || undefined,
          message: emailMessage.trim() || undefined,
          versionNo: sendVersionNo.trim() ? Number(sendVersionNo) : undefined,
        }),
      });
      const body = await res.json().catch(
        () => ({} as { error?: string; snapshot?: TenderSnapshot; details?: { fieldErrors?: Record<string, string[]> }; ccWarning?: string }),
      );
      if (!res.ok || !body.snapshot) {
        const fieldErrors   = body.details?.fieldErrors || {};
        const firstFieldErr = Object.values(fieldErrors).flatMap((v) => (Array.isArray(v) ? v : []))[0] || "";
        toast.error(firstFieldErr || body.error || "Failed to send tender email");
        return;
      }
      // Surface CC warning if CC send degraded gracefully
      if (body.ccWarning) {
        toast.warning(`Tender sent to primary recipient. CC warning: ${body.ccWarning}`);
      } else {
        toast.success("Tender emailed successfully.");
      }
      setActiveTender(body.snapshot);
      setSendTenderId("");
      setSendVersionNo("");
      setEmailTo("");
      setEmailCc("");
      setEmailMessage("");
      setCompareFromVersion("");
      setCompareToVersion("");
      setDiffResult(null);
      setApprovalStatus(null);
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  const refreshApprovalStatus = async (tenderId: string) => {
    if (!tenderId) { setApprovalStatus(null); return; }
    const res  = await fetch(`/api/admin/b2b/tenders/${tenderId}/approval-status`);
    const body = await res.json().catch(() => ({} as { error?: string } & ApprovalStatus));
    setApprovalStatus(res.ok ? body : null);
  };

  const approveForSend = async () => {
    if (!sendTenderId) { toast.error("Select a tender first."); return; }
    if (selectedSendTender && !isTenderSendEligible(selectedSendTender.status)) {
      toast.error(
        selectedSendTender.status === "DRAFT"
          ? "Submit the tender before approval."
          : `Cannot approve a tender with status ${selectedSendTender.status}.`,
      );
      return;
    }
    try {
      setApprovalBusy(true);
      const res  = await fetch(`/api/admin/b2b/tenders/${sendTenderId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) { toast.error(body.error || "Approval failed"); return; }
      toast.success("Tender approved for send.");
      await refreshApprovalStatus(sendTenderId);
    } finally {
      setApprovalBusy(false);
    }
  };

  const compareVersions = async () => {
    if (!sendTenderId) { toast.error("Select a tender first."); return; }
    const q = new URLSearchParams();
    if (compareFromVersion) q.set("from", compareFromVersion);
    if (compareToVersion)   q.set("to",   compareToVersion);
    const res  = await fetch(`/api/admin/b2b/tenders/${sendTenderId}/diff?${q.toString()}`);
    const body = await res.json().catch(() => ({} as { error?: string } & DiffResult));
    if (!res.ok) { toast.error(body.error || "Failed to compare versions."); return; }
    setDiffResult(body);
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) { toast.error("Template name is required."); return; }
    const res = await fetch("/api/admin/b2b/tender-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name:         templateName.trim(),
        sourceType:   templateSourceType,
        validityDays: Number(validityDays || 14),
        leadTimeDays: leadTimeDays.trim() ? Number(leadTimeDays) : undefined,
        paymentTerms: paymentTerms.trim() || undefined,
        notes:        notes.trim()        || undefined,
      }),
    });
    const body = await res.json().catch(() => ({} as { error?: string }));
    if (!res.ok) { toast.error(body.error || "Failed to save template"); return; }
    toast.success("Template saved.");
    setTemplateName("");
    await refetchTemplates();
  };

  // UX-3 FIX: template delete with confirmation dialog
  const requestDeleteTemplate = (id: string, name: string) => {
    setConfirmAction({
      title:        "Delete Template",
      description:  `Delete template "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      variant:      "destructive",
      onConfirm: async () => {
        const res  = await fetch(`/api/admin/b2b/tender-templates?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const body = await res.json().catch(() => ({} as { error?: string }));
        if (!res.ok) { toast.error(body.error || "Failed to delete template"); return; }
        toast.success("Template deleted.");
        await refetchTemplates();
      },
    });
  };

  const applyTemplate = (id: string) => {
    const tpl = templates.find((row) => row.id === id);
    if (!tpl) return;
    if (tpl.validityDays != null) setValidityDays(String(tpl.validityDays));
    if (tpl.leadTimeDays != null) setLeadTimeDays(String(tpl.leadTimeDays));
    if (tpl.paymentTerms != null) setPaymentTerms(tpl.paymentTerms);
    if (tpl.notes        != null) setNotes(tpl.notes);
    toast.success(`Template applied: ${tpl.name}`);
  };

  const sendReminderNow = async (tenderId: string) => {
    const res  = await fetch(`/api/admin/b2b/tenders/${tenderId}/reminder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({} as { error?: string }));
    if (!res.ok) { toast.error(body.error || "Failed to send reminder"); return; }
    toast.success("Reminder sent.");
    await refetchReminders();
  };

  const convertWonTenderToOrder = async (tenderId: string) => {
    const existing = orderLinkByTenderId.get(tenderId);
    if (existing) {
      window.location.href = `/admin/orders/${encodeURIComponent(existing.orderId)}`;
      return;
    }
    const res  = await fetch(`/api/admin/b2b/tenders/${tenderId}/draft-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({} as { error?: string; draft?: { canPrefill?: boolean } }));
    if (!res.ok || !body.draft) {
      toast.error(body.error || "Could not prepare order draft from tender");
      return;
    }
    toast.success("Tender order draft prepared.");
    window.location.href = `/admin/orders/new?tenderId=${encodeURIComponent(tenderId)}`;
  };

  const downloadPackage = (tenderId: string) => {
    window.open(`/api/admin/b2b/tenders/${tenderId}/export`, "_blank");
  };

  const loadFromProcurementRequest = useCallback(async (requestIdArg?: string) => {
    const requestId = requestIdArg || selectedProcurementRequestId || "";
    if (!requestId) { toast.error("Select a procurement request first."); return; }
    const reqRow = procurementRequests.find((row) => row.id === requestId);
    if (!reqRow) { toast.error("Selected procurement request not found."); return; }
    setBuyerName(reqRow.clinicName || "");
    setBuyerContact(reqRow.contactName || reqRow.contactPhone || "");
    setBuyerEmail(reqRow.contactEmail || "");
    setTenderRef(reqRow.id);
    if (!lotTitle.trim()) setLotTitle("LOT 1");
    setReviewConfirmed(false);
    setLineOverrides({});
    setLineResolvedProductIds({});

    if (reqRow.itemsText?.trim()) {
      setItemsText(reqRow.itemsText.trim());
      toast.success("Loaded buyer and item list from procurement request.");
      return;
    }
    try {
      setBusy(true);
      const res  = await fetch(`/api/admin/b2b/procurement/requests/${requestId}/draft-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({} as { error?: string; draft?: { lines?: Array<{ raw?: string; itemRef?: string; quantity?: number }> } }));
      if (!res.ok || !body?.draft?.lines?.length) {
        toast.error(body?.error || "Could not load item lines from procurement request.");
        return;
      }
      const linesText = body.draft.lines
        .map((line: { raw?: string; itemRef?: string; quantity?: number }) =>
          `${line.itemRef || line.raw || "Item"}: ${line.quantity || 1}`,
        )
        .join("\n");
      setItemsText(linesText);
      toast.success("Loaded buyer and derived item list from procurement request.");
    } finally {
      setBusy(false);
    }
  }, [selectedProcurementRequestId, procurementRequests, lotTitle]);

  // BUG-4 FIX: currency fallback GHS not EUR; also re-runs live preview on load
  const loadTenderForEdit = (row: TenderSnapshot) => {
    setSourceMode("manual");
    setActiveTender(row.status === "DRAFT" ? row : null);
    setBuyerName(row.buyerName || "");
    setBuyerContact(row.buyerContact || "");
    setBuyerEmail(row.buyerEmail || "");
    setTenderRef(row.tenderRef || "");
    setLotTitle(row.lotTitle || "LOT 1");
    setCurrency(row.currency || "GHS");  // BUG-4 FIX
    setValidityDays(String(row.validityDays || 14));
    setNotes(row.notes || "");
    setVatRatePct(String(row.vatRatePct ?? 0));
    setDiscountAmount(String(row.discountAmount ?? 0));
    setFreightAmount(String(row.freightAmount ?? 0));
    setHandlingAmount(String(row.handlingAmount ?? 0));
    setLeadTimeDays(row.leadTimeDays != null ? String(row.leadTimeDays) : "");
    setPaymentTerms(row.paymentTerms || "");
    setMarginThresholdPct(String(row.marginThresholdPct ?? 0));
    setItemsText(row.itemsText || "");
    setPreview({
      lines:         row.lines || [],
      subtotal:      Number(row.subtotal || 0),
      total:         Number(row.total    || 0),
      matchedCount:  (row.lines || []).filter((l) => Boolean(l.matchedProductId)).length,
      unmatchedCount:(row.lines || []).filter((l) => !l.matchedProductId).length,
      currency:      row.currency || "GHS",  // BUG-4 FIX
    });
    setLineOverrides({});
    setLineResolvedProductIds({});
    setClearedReviewLines({});
    setReviewConfirmed(true);
    setSendTenderId(row.id);

    // Rebuild preview from live catalog for current stock/cost accuracy
    void (async () => {
      try {
        const res  = await fetch("/api/admin/b2b/tenders/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemsText: row.itemsText || "", currency: row.currency || "GHS" }),
        });
        const body = await res.json().catch(() => ({} as { error?: string; preview?: TenderPreview }));
        if (!res.ok || !body.preview) return;

        const savedByNo = new Map((row.lines || []).map((line) => [line.no, line]));
        const nextOverrides: Record<number, LineOverride>  = {};
        const nextResolvedIds: Record<number, string>      = {};

        for (const liveLine of body.preview.lines) {
          const savedLine = savedByNo.get(liveLine.no);
          if (!savedLine) continue;
          const ov: LineOverride = {
            quantity:      "",
            unitPrice:     "",
            leadTimeDays:  "",
            supplyNote:    "",
            bidDisposition: savedLine.bidDisposition || "AVAILABLE",
          };
          if (Number(savedLine.quantity)  !== Number(liveLine.quantity))  ov.quantity  = String(savedLine.quantity);
          if (Number(savedLine.unitPrice) !== Number(liveLine.unitPrice)) ov.unitPrice = String(savedLine.unitPrice);
          if ((savedLine.bidDisposition || "AVAILABLE") !== (liveLine.bidDisposition || "AVAILABLE")) {
            ov.bidDisposition = savedLine.bidDisposition || "AVAILABLE";
          }
          if (ov.quantity || ov.unitPrice || ov.bidDisposition !== (liveLine.bidDisposition || "AVAILABLE")) {
            nextOverrides[liveLine.no] = ov;
          }
          if (savedLine.matchedProductId && savedLine.matchedProductId !== liveLine.matchedProductId) {
            nextResolvedIds[liveLine.no] = savedLine.matchedProductId;
          }
        }
        setPreview(body.preview);
        setLineOverrides(nextOverrides);
        setLineResolvedProductIds(nextResolvedIds);
        setClearedReviewLines({});
        setReviewConfirmed(false);
        toast.info("Draft revalidated with current stock and pricing.");
      } catch { /* keep snapshot preview if live refresh fails */ }
    })();

    setActiveTab("build");
    toast.success(
      row.status === "DRAFT"
        ? "Draft loaded for editing."
        : "Non-draft loaded as template. Save will create a new tender draft.",
    );
  };

  // DEF-6 FIX: terminal status changes require confirmation
  const updateTenderStatus = async (tenderId: string) => {
    const status = statusByTender[tenderId];
    if (!status) { toast.error("Select a status first."); return; }
    const row = history.find((item) => item.id === tenderId);
    if (!row) { toast.error("Tender not found."); return; }
    if (row.status === status) { toast.info("Tender is already in that status."); return; }
    const allowedTargets = getTenderAllowedTargets(row.status);
    if (!allowedTargets.includes(status)) {
      toast.error(`Cannot move tender from ${row.status} to ${status}.`);
      return;
    }

    const doUpdate = async () => {
      try {
        setBusy(true);
        const res  = await fetch(`/api/admin/b2b/tenders/${tenderId}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const body = await res.json().catch(() => ({} as { error?: string; snapshot?: TenderSnapshot }));
        if (!res.ok || !body.snapshot) {
          toast.error(body.error || "Failed to update tender status");
          return;
        }
        if (activeTender?.id === tenderId) setActiveTender(body.snapshot);
        toast.success(`Tender status updated to ${status}.`);
        await refetch();
      } finally {
        setBusy(false);
      }
    };

    if (TERMINAL_STATUSES.has(status)) {
      setConfirmAction({
        title:        `Mark as ${status}`,
        description:  `Set tender ${row.tenderNumber} to ${status}? This status cannot be reversed.`,
        confirmLabel: `Yes, mark ${status}`,
        variant:      status === "WON" ? "default" : "destructive",
        onConfirm:    doUpdate,
      });
    } else {
      await doUpdate();
    }
  };

  // ─── Side effects ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (prefillHandledRef.current) return;
    const requestId = searchParams.get("procurementRequestId") || "";
    if (!requestId) return;
    const exists = procurementRequests.some((r) => r.id === requestId);
    if (!exists) return;
    prefillHandledRef.current = true;
    setSourceMode("procurement");
    setSelectedProcurementRequestId(requestId);
    setTimeout(() => { void loadFromProcurementRequest(requestId); }, 0);
  }, [procurementRequests, searchParams, loadFromProcurementRequest]);

  useEffect(() => { void refreshApprovalStatus(sendTenderId || ""); }, [sendTenderId]);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const openPdf = (id: string) => { window.open(`/api/admin/b2b/tenders/${id}/pdf`, "_blank"); };

  // DEF-3 FIX: only show active procurement requests
  const activeProcurementRequests = useMemo(
    () => procurementRequests.filter((r) => ACTIVE_PROCUREMENT_STATUSES.includes(r.status)),
    [procurementRequests],
  );

  // Tab classes helper
  const tabCls = (tab: typeof activeTab) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      activeTab === tab
        ? "border-primary text-primary"
        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
    }`;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="container mx-auto py-8 max-w-7xl space-y-4">

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tender Builder</h1>
          <p className="text-sm text-muted-foreground">
            Build, review and send branded tender PDFs from clinic procurement requests.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={resetForm}>
            New Tender
          </Button>
          {isAdmin && (
            <Link
              href="/admin/audit?sourcePage=admin%2Fb2b%2Ftenders"
              className="text-xs underline text-muted-foreground hover:text-foreground"
            >
              View Audit Log
            </Link>
          )}
          <Link href="/admin/b2b/procurement" className="text-xs underline text-muted-foreground hover:text-foreground">
            Back to Procurement
          </Link>
        </div>
      </div>

      {/* ── Expiry banner (DEF-8) ────────────────────────────────────────── */}
      {expiringSoon.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">
            {expiringSoon.length} tender{expiringSoon.length > 1 ? "s" : ""} expiring soon:
          </span>{" "}
          {expiringSoon.map((r, i) => (
            <span key={r.id}>
              {i > 0 && " · "}
              <button
                className="underline font-medium"
                onClick={() => {
                  setHistoryStatusFilter("");
                  setHistorySearch(r.tenderNumber);
                  setActiveTab("history");
                }}
              >
                {r.tenderNumber}
              </button>{" "}
              ({r.daysToExpiry}d left)
            </span>
          ))}
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="grid gap-2 rounded border bg-muted/20 p-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">Drafting</div>
          <div className="font-medium">{history.filter((row) => row.status === "DRAFT").length} draft</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Ready to send</div>
          <div className="font-medium">{sendEligibleTenders.length} tender{sendEligibleTenders.length === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Expiring soon</div>
          <div className="font-medium">{expiringSoon.length}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Visible results</div>
          <div className="font-medium">{history.length} of {historyTotalCount}</div>
        </div>
      </div>

      <div className="flex gap-0 border-b" role="tablist" aria-label="Tender workflow">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "build"}
          aria-controls="tender-build-panel"
          id="tender-build-tab"
          className={tabCls("build")}
          onClick={() => setActiveTab("build")}
        >
          Build Tender
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "send"}
          aria-controls="tender-send-panel"
          id="tender-send-tab"
          className={tabCls("send")}
          onClick={() => setActiveTab("send")}
        >
          Send &amp; Versions
          {approvalStatus && !approvalStatus.canSend && (
            <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-amber-400" title="Approval required" />
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "history"}
          aria-controls="tender-history-panel"
          id="tender-history-tab"
          className={tabCls("history")}
          onClick={() => setActiveTab("history")}
        >
          Tenders {historyTotalCount > 0 && `(${historyTotalCount})`}
        </button>
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          TAB: BUILD TENDER
         ════════════════════════════════════════════════════════════════════ */}
      {activeTab === "build" && (
        <div role="tabpanel" id="tender-build-panel" aria-labelledby="tender-build-tab" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Tender Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">

              {/* Source & buyer */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Source</label>
                  <select
                    className="h-10 w-full rounded border bg-background px-3 text-sm"
                    value={sourceMode}
                    onChange={(e) => setSourceMode(e.target.value as "manual" | "procurement")}
                  >
                    <option value="manual">Paste / Upload</option>
                    <option value="procurement">From Procurement Request</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="tender-buyer-name" className="mb-1 block text-xs text-muted-foreground">Buyer / Facility *</label>
                  <Input id="tender-buyer-name" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="tender-buyer-contact" className="mb-1 block text-xs text-muted-foreground">Buyer contact</label>
                  <Input id="tender-buyer-contact" value={buyerContact} onChange={(e) => setBuyerContact(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="tender-buyer-email" className="mb-1 block text-xs text-muted-foreground">Buyer email</label>
                  <Input id="tender-buyer-email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} type="email" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Tender reference
                    {tenderRef && procurementRequests.some((r) => r.id === tenderRef) && (
                      <Link
                        href={`/admin/b2b/procurement?highlight=${encodeURIComponent(tenderRef)}`}
                        className="ml-2 underline text-primary"
                      >
                        View request
                      </Link>
                    )}
                  </label>
                  <Input value={tenderRef} onChange={(e) => setTenderRef(e.target.value)} />
                </div>
              </div>

              {/* DEF-3 FIX: procurement dropdown — active statuses only, no raw IDs */}
              {sourceMode === "procurement" && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="sm:col-span-2 lg:col-span-3">
                    <label className="mb-1 block text-xs text-muted-foreground">
                      Procurement Request
                      {activeProcurementRequests.length === 0 && procurementRequests.length > 0 && (
                        <span className="ml-2 text-amber-600">(No active requests — showing all)</span>
                      )}
                    </label>
                    <select
                      className="h-10 w-full rounded border bg-background px-3 text-sm"
                      value={selectedProcurementRequestId}
                      onChange={(e) => setSelectedProcurementRequestId(e.target.value)}
                    >
                      <option value="">Select procurement request...</option>
                      {(activeProcurementRequests.length > 0
                        ? activeProcurementRequests
                        : procurementRequests
                      ).map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.clinicName} — {row.requestType} — {row.status} — {formatDateGH(row.updatedAt)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button type="button" variant="outline" onClick={() => void loadFromProcurementRequest()} disabled={busy}>
                      Load Request
                    </Button>
                  </div>
                </div>
              )}

              {/* Lot / Currency / Validity / Upload */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Lot title</label>
                  <Input value={lotTitle} onChange={(e) => setLotTitle(e.target.value)} placeholder="LOT 1" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Currency</label>
                  <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="GHS" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Validity (days)</label>
                  <Input value={validityDays} onChange={(e) => setValidityDays(e.target.value)} type="number" min={1} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Upload TXT / CSV / PDF / DOCX / Image</label>
                  <Input
                    type="file"
                    accept=".txt,.csv,.pdf,.doc,.docx,image/png,image/jpeg,image/webp"
                    onChange={(e) => uploadItems(e.target.files?.[0] || null)}
                  />
                </div>
              </div>

              {/* Charges */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">VAT %</label>
                  <Input value={vatRatePct} onChange={(e) => setVatRatePct(e.target.value)} type="number" min={0} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Discount Amount</label>
                  <Input value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} type="number" min={0} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Freight Amount</label>
                  <Input value={freightAmount} onChange={(e) => setFreightAmount(e.target.value)} type="number" min={0} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Handling Amount</label>
                  <Input value={handlingAmount} onChange={(e) => setHandlingAmount(e.target.value)} type="number" min={0} />
                </div>
              </div>

              {/* Terms */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Margin Lock % (min)</label>
                  <Input value={marginThresholdPct} onChange={(e) => setMarginThresholdPct(e.target.value)} type="number" min={0} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Global Lead Time (days)</label>
                  <Input value={leadTimeDays} onChange={(e) => setLeadTimeDays(e.target.value)} type="number" min={0} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Payment Terms</label>
                  <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g., Net 30 days / 50% advance" />
                </div>
              </div>

              {/* Template packs */}
              <div className="rounded border bg-muted/20 p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Template Packs</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <select
                    className="h-10 w-full rounded border bg-background px-3 text-sm"
                    onChange={(e) => {
                      if (!e.target.value) return;
                      applyTemplate(e.target.value);
                      e.currentTarget.value = "";
                    }}
                    defaultValue=""
                  >
                    <option value="">Apply saved template...</option>
                    {templates.map((tpl) => (
                      <option key={`tpl-${tpl.id}`} value={tpl.id}>
                        {tpl.name} ({tpl.sourceType})
                      </option>
                    ))}
                  </select>
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="Save current terms as template"
                  />
                  <select
                    className="h-10 w-full rounded border bg-background px-3 text-sm"
                    value={templateSourceType}
                    onChange={(e) => setTemplateSourceType(e.target.value as TemplateRow["sourceType"])}
                  >
                    <option value="CUSTOM">Custom</option>
                    <option value="PUBLIC_HOSPITAL">Public Hospital</option>
                    <option value="PRIVATE_CLINIC">Private Clinic</option>
                    <option value="NGO">NGO</option>
                    <option value="CORPORATE">Corporate</option>
                  </select>
                  <Button className="w-full" variant="outline" onClick={saveTemplate} disabled={busy}>
                    Save Template
                  </Button>
                </div>
                {templates.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-1">
                    {templates.slice(0, 8).map((tpl) => (
                      <Button
                        key={`tpl-del-${tpl.id}`}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => requestDeleteTemplate(tpl.id, tpl.name)}
                      >
                        Delete {tpl.name}
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              {/* Item list — UX-5: format hint */}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Item list *
                  <span className="ml-2 text-xs text-muted-foreground/70">
                    One per line — e.g.{" "}
                    <code className="rounded bg-muted px-1 text-[11px]">Paracetamol 500mg tabs, box, 100</code>
                    {" "}or <code className="rounded bg-muted px-1 text-[11px]">Paracetamol 500mg tabs: 100</code>
                  </span>
                </label>
                <Textarea id="tender-items-text" rows={9} value={itemsText} onChange={(e) => setItemsText(e.target.value)} />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Notes / Terms</label>
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={analyze} disabled={busy}>
                  Analyze Items
                </Button>
              </div>
              {summaryText && <p className="text-xs text-muted-foreground">{summaryText}</p>}

              {/* Last saved tender banner */}
              {lastSavedTender && (
                <div className="rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">
                  <div className="font-medium text-emerald-900">Last Saved Tender</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-emerald-900/90">
                    <span>{lastSavedTender.tenderNumber}</span>
                    <TenderStatusBadge status={lastSavedTender.status} />
                    <span>{lastSavedTender.currency} {lastSavedTender.total.toFixed(2)}</span>
                    <span>Updated {formatDateGH(lastSavedTender.updatedAt)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => openPdf(lastSavedTender.id)}>
                      Open PDF
                    </Button>
                    {lastSavedTender.status === "DRAFT" && (
                      <Button size="sm" variant="outline" onClick={() => loadTenderForEdit(lastSavedTender)}>
                        Edit Draft
                      </Button>
                    )}
                    {isTenderSendEligible(lastSavedTender.status) ? (
                      <Button size="sm" variant="secondary" onClick={() => { setSendTenderId(lastSavedTender.id); setActiveTab("send"); }}>
                        Go to Send
                      </Button>
                    ) : (
                      <span className="self-center text-xs text-emerald-900/80">
                        Submit this draft before sending.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Preview card */}
          {preview && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Preview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-xs text-muted-foreground">
                  Matched: {preview.matchedCount} | Unmatched: {preview.unmatchedCount} | Total:{" "}
                  {preview.currency} {effectiveTotal.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Subtotal: {preview.currency} {effectiveSubtotal.toFixed(2)} |{" "}
                  VAT: {preview.currency} {effectiveVat.toFixed(2)} |{" "}
                  Freight: {preview.currency} {Number(freightAmount || 0).toFixed(2)} |{" "}
                  Handling: {preview.currency} {Number(handlingAmount || 0).toFixed(2)} |{" "}
                  Discount: −{preview.currency} {Number(discountAmount || 0).toFixed(2)}
                </div>

                {marginViolations.length > 0 && (
                  <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900">
                    Margin lock violation: {marginViolations.length} line(s) below {minMargin.toFixed(2)}% minimum margin. Increase unit price before saving.
                  </div>
                )}

                <div className="overflow-x-auto rounded border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30 text-xs">
                        <th className="px-2 py-2 text-left">No</th>
                        <th className="px-2 py-2 text-left">Requested Item</th>
                        <th className="px-2 py-2 text-left">Matched Product</th>
                        <th className="px-2 py-2 text-right">Qty</th>
                        <th className="px-2 py-2 text-right">Stock</th>
                        <th className="px-2 py-2 text-right">Cost</th>
                        <th className="px-2 py-2 text-right">Margin %</th>
                        <th className="px-2 py-2 text-right">Unit Price</th>
                        <th className="px-2 py-2 text-right">Total</th>
                        <th className="px-2 py-2 text-left">Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiblePreviewLines.map((line) => (
                        <tr
                          key={`${line.no}-${line.requestedDescription}`}
                          className={`border-b last:border-0 ${
                            (line.availableStock != null && Number(line.availableStock || 0) < line.quantity) ||
                            line.matchConfidence === "NONE"
                              ? "bg-red-50"
                              : line.matchConfidence === "LOW"
                                ? "bg-amber-50"
                                : ""
                          }`}
                        >
                          <td className="px-2 py-2">{line.no}</td>
                          <td className="px-2 py-2">{line.requestedDescription}</td>
                          <td className="px-2 py-2">
                            {line.matchedProductName || "-"}{line.matchedSku ? ` (${line.matchedSku})` : ""}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Input
                              className="h-8 text-right"
                              value={lineOverrides[line.no]?.quantity ?? ""}
                              onChange={(e) => updateLineOverride(line.no, { quantity: e.target.value })}
                              placeholder={String(line.quantity)}
                            />
                          </td>
                          <td className="px-2 py-2 text-right">{line.availableStock ?? "-"}</td>
                          <td className="px-2 py-2 text-right">{line.baseCost != null ? Number(line.baseCost).toFixed(2) : "-"}</td>
                          <td className={`px-2 py-2 text-right ${line.marginPct != null && line.marginPct < minMargin && minMargin > 0 ? "text-red-600 font-medium" : ""}`}>
                            {line.marginPct != null ? Number(line.marginPct).toFixed(1) + "%" : "-"}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Input
                              className="h-8 text-right"
                              value={lineOverrides[line.no]?.unitPrice ?? ""}
                              onChange={(e) => updateLineOverride(line.no, { unitPrice: e.target.value })}
                              placeholder={line.unitPrice.toFixed(2)}
                            />
                          </td>
                          <td className="px-2 py-2 text-right font-medium">{line.lineTotal.toFixed(2)}</td>
                          <td className="px-2 py-2 text-xs">
                            {line.matchConfidence}
                            {line.bidDisposition ? ` / ${line.bidDisposition}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-xs text-muted-foreground">
                  Qty and Unit Price inputs are manual overrides applied when saving.
                  {" "}Image/PDF OCR support requires server configuration.
                </p>

                {/* Review required section */}
                {reviewLines.length > 0 ? (
                  <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm space-y-2">
                    <div className="font-medium text-amber-900">
                      Review Required ({reviewLines.length} line{reviewLines.length > 1 ? "s" : ""})
                    </div>
                    <div className="max-h-72 overflow-auto space-y-2 text-xs text-amber-900">
                      {reviewLines.map((line) => (
                        <div key={`review-${line.no}`} className="rounded border border-amber-200 bg-white/70 p-2">
                          <div>
                            Line {line.no}: <strong>{line.requestedDescription}</strong>{" "}
                            <Badge variant="outline" className="text-[10px]">{line.matchConfidence}</Badge>
                          </div>
                          <div className="mt-1">
                            <select
                              className="h-8 w-full sm:min-w-[220px] rounded border bg-white px-2"
                              value={lineOverrides[line.no]?.bidDisposition || line.bidDisposition || "AVAILABLE"}
                              onChange={(e) => setLineBidDisposition(line.no, e.target.value as "AVAILABLE" | "SUBSTITUTE" | "NO_BID")}
                            >
                              <option value="AVAILABLE">Available</option>
                              <option value="SUBSTITUTE">Substitute Offered</option>
                              <option value="NO_BID">No Bid (Discontinued)</option>
                            </select>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <select
                              className="h-8 w-full sm:min-w-[260px] rounded border bg-white px-2"
                              value={lineResolvedProductIds[line.no] || ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                setClearedReviewLines((prev) => {
                                  if (!prev[line.no]) return prev;
                                  const next = { ...prev };
                                  delete next[line.no];
                                  return next;
                                });
                                setLineResolvedProductIds((prev) => ({ ...prev, [line.no]: value }));
                                setReviewConfirmed(false);
                              }}
                            >
                              <option value="">Select product to resolve...</option>
                              {suggestionsFor(line).map((product) => (
                                <option key={`${line.no}-${product.id}`} value={product.id}>
                                  {product.name} {product.sku ? `(${product.sku})` : ""} — {Number(product.price || 0).toFixed(2)}
                                </option>
                              ))}
                            </select>
                            {(() => {
                              const disposition = lineOverrides[line.no]?.bidDisposition || line.bidDisposition || "AVAILABLE";
                              const stock       = Number(line.availableStock ?? 0);
                              const isOos       = disposition !== "NO_BID" && line.availableStock != null && stock < line.quantity;
                              if (!isOos) return null;
                              const availableNow = Math.max(0, Math.floor(stock));
                              const balance      = Math.max(0, line.quantity - availableNow);
                              const lead         = lineOverrides[line.no]?.leadTimeDays?.trim() || "";
                              const note         = lineOverrides[line.no]?.supplyNote?.trim() || "";
                              const canClear     = Boolean(lead) && hasSplitSupplyNote(note, availableNow, balance);
                              return (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={!canClear}
                                  onClick={() => {
                                    if (!canClear) return;
                                    setClearedReviewLines((prev) => ({ ...prev, [line.no]: true }));
                                    setReviewConfirmed(false);
                                  }}
                                >
                                  Clear OOS
                                </Button>
                              );
                            })()}
                          </div>
                          <div className="mt-1 grid gap-2 sm:grid-cols-2">
                            <Input
                              value={lineOverrides[line.no]?.leadTimeDays ?? ""}
                              onChange={(e) => {
                                const lead    = e.target.value;
                                const stock   = Number(line.availableStock ?? NaN);
                                const isOos   = Number.isFinite(stock) && stock < line.quantity;
                                if (!isOos || !lead.trim()) {
                                  updateLineOverride(line.no, { leadTimeDays: lead });
                                  return;
                                }
                                const availableNow = Math.max(0, Math.floor(stock));
                                const balance      = Math.max(0, line.quantity - availableNow);
                                const dayCount     = Number(lead);
                                const dayLabel     = Number.isFinite(dayCount) && dayCount === 1 ? "day" : "days";
                                const autoNote     = `${availableNow} available now, ${balance} in ${lead} ${dayLabel}`;
                                const currentNote  = lineOverrides[line.no]?.supplyNote || "";
                                const shouldAutofill = !currentNote.trim() || isAutoSupplyNoteFormat(currentNote);
                                updateLineOverride(line.no, {
                                  leadTimeDays: lead,
                                  supplyNote:   shouldAutofill ? autoNote : currentNote,
                                });
                              }}
                              placeholder="Lead time days (OOS)"
                            />
                            <Input
                              value={lineOverrides[line.no]?.supplyNote ?? ""}
                              onChange={(e) => updateLineOverride(line.no, { supplyNote: e.target.value })}
                              placeholder="e.g. 5 available now, 10 in 7 days"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={reviewConfirmed}
                        onChange={(e) => setReviewConfirmed(e.target.checked)}
                      />
                      I reviewed flagged lines and confirm tender values are correct.
                    </label>
                  </div>
                ) : (
                  <div className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
                    No low-confidence lines detected.
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button onClick={saveTender} disabled={busy}>
                    Save Tender Draft
                  </Button>
                  {activeTender && (
                    <Button variant="secondary" onClick={() => openPdf(activeTender.id)}>
                      Download / Print PDF
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          TAB: SEND & VERSIONS
         ════════════════════════════════════════════════════════════════════ */}
      {activeTab === "send" && (
        <div role="tabpanel" id="tender-send-panel" aria-labelledby="tender-send-tab" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Send Tender by Email</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Approval status banner */}
              {approvalStatus && (
                <div className={`rounded border p-2 text-xs ${
                  approvalStatus.canSend
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-amber-300 bg-amber-50 text-amber-900"
                }`}>
                  Approval: {approvalStatus.reason}
                  {approvalStatus.approvedAt && ` — Last approved ${formatDateGH(approvalStatus.approvedAt)}`}
                  {approvalStatus.approvedByName && ` by ${approvalStatus.approvedByName}`}
                </div>
              )}
              {sendTenderId && selectedSendTender && !isTenderSendEligible(selectedSendTender.status) && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  Submit this tender before sending. Terminal tenders cannot be sent.
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Tender *</label>
                  <select
                    className="h-10 w-full rounded border bg-background px-3 text-sm"
                    value={sendTenderId}
                    onChange={(e) => {
                      setSendTenderId(e.target.value);
                      setSendVersionNo("");
                      setDiffResult(null);
                      const nextTender = history.find((row) => row.id === e.target.value);
                      if (nextTender?.buyerEmail && !emailTo.trim()) setEmailTo(nextTender.buyerEmail);
                    }}
                  >
                    <option value="">— select a tender —</option>
                    {sendEligibleTenders.map((row) => (
                      <option key={`send-${row.id}`} value={row.id}>
                        {row.tenderNumber} | {row.buyerName} | {row.status}
                      </option>
                    ))}
                  </select>
                  {history.length > 0 && sendEligibleTenders.length === 0 && (
                    <p className="mt-1 text-xs text-amber-700">No submitted or previously sent tenders are available on this page.</p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Version (optional)</label>
                  <select
                    className="h-10 w-full rounded border bg-background px-3 text-sm"
                    value={sendVersionNo}
                    onChange={(e) => setSendVersionNo(e.target.value)}
                    disabled={!sendTenderId}
                  >
                    <option value="">Latest version</option>
                    {versions.map((v) => (
                      <option key={`v-${v.id}`} value={String(v.versionNo)}>
                        v{v.versionNo} | {v.status} | {formatDateGH(v.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">To *</label>
                  <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="procurement@clinic.com" type="email" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">CC (optional)</label>
                  <Input value={emailCc} onChange={(e) => setEmailCc(e.target.value)} type="email" />
                </div>
              </div>

              {/* DEF-1: custom message field */}
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
                  Email message (optional — leave blank for default)
                </label>
                <Textarea
                  rows={3}
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  placeholder="Please find attached our tender submission. We look forward to your response."
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={approveForSend}
                  disabled={busy || approvalBusy || !sendTenderId || !selectedSendTender || !isTenderSendEligible(selectedSendTender.status)}
                >
                  Approve for Send
                </Button>
                <Button
                  onClick={sendTenderEmail}
                  disabled={busy || !sendTenderId || !selectedSendTender || !isTenderSendEligible(selectedSendTender.status) || (approvalStatus?.requireApproval === true && !approvalStatus?.canSend)}
                >
                  Send Tender
                </Button>
                {sendTenderId && (
                  <Button variant="ghost" size="sm" onClick={() => openPdf(sendTenderId)}>
                    Preview PDF
                  </Button>
                )}
                {isAdmin && sendTenderId && (
                  <Link
                    href={`/admin/audit?entityType=B2B_TENDER&entityId=${encodeURIComponent(sendTenderId)}`}
                    className="text-xs underline text-muted-foreground hover:text-foreground"
                  >
                    Audit trail
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Version comparison card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Version Comparison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <select
                  className="h-10 w-full rounded border bg-background px-3 text-sm"
                  value={compareFromVersion}
                  onChange={(e) => setCompareFromVersion(e.target.value)}
                  disabled={!sendTenderId}
                >
                  <option value="">From (default previous)</option>
                  {comparableVersions.map((v) => (
                    <option key={`cf-${v.id}`} value={String(v.versionNo)}>
                      v{v.versionNo} — {v.status} — {formatDateGH(v.createdAt)}
                    </option>
                  ))}
                </select>
                <select
                  className="h-10 w-full rounded border bg-background px-3 text-sm"
                  value={compareToVersion}
                  onChange={(e) => setCompareToVersion(e.target.value)}
                  disabled={!sendTenderId}
                >
                  <option value="">To (default latest)</option>
                  {comparableVersions.map((v) => (
                    <option key={`ct-${v.id}`} value={String(v.versionNo)}>
                      v{v.versionNo} — {v.status} — {formatDateGH(v.createdAt)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  onClick={compareVersions}
                  disabled={!sendTenderId}
                >
                  Compare
                </Button>
              </div>

              {/* DEF-2 FIX: render full diff detail */}
              {diffResult && (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap gap-4 rounded border bg-muted/20 p-3">
                    <div>
                      <span className="text-muted-foreground">From:</span>{" "}
                      v{diffResult.from.versionNo} ({diffResult.from.status}){" "}
                      {diffResult.from.total.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">To:</span>{" "}
                      v{diffResult.to.versionNo} ({diffResult.to.status}){" "}
                      {diffResult.to.total.toFixed(2)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Total change:</span>{" "}
                      <span className={diffResult.totalsDelta.total >= 0 ? "text-green-700" : "text-red-700"}>
                        {diffResult.totalsDelta.total >= 0 ? "+" : ""}
                        {diffResult.totalsDelta.total.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {diffResult.lineChanges.length === 0 ? (
                    <p className="text-muted-foreground">No line-level changes between these versions.</p>
                  ) : (
                    <div className="overflow-x-auto rounded border">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b bg-muted/30 text-left">
                            <th className="px-2 py-1.5">Change</th>
                            <th className="px-2 py-1.5">Item</th>
                            <th className="px-2 py-1.5 text-right">From Qty</th>
                            <th className="px-2 py-1.5 text-right">To Qty</th>
                            <th className="px-2 py-1.5 text-right">From Price</th>
                            <th className="px-2 py-1.5 text-right">To Price</th>
                            <th className="px-2 py-1.5 text-right">Δ Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {diffResult.lineChanges.map((lc, i) => (
                            <tr key={i} className="border-b last:border-0">
                              <td className="px-2 py-1.5"><DiffChangeTypeBadge type={lc.changeType} /></td>
                              <td className="px-2 py-1.5">{lc.item}</td>
                              <td className="px-2 py-1.5 text-right">{lc.fromQty || "—"}</td>
                              <td className="px-2 py-1.5 text-right">{lc.toQty || "—"}</td>
                              <td className="px-2 py-1.5 text-right">{lc.fromUnitPrice ? lc.fromUnitPrice.toFixed(2) : "—"}</td>
                              <td className="px-2 py-1.5 text-right">{lc.toUnitPrice ? lc.toUnitPrice.toFixed(2) : "—"}</td>
                              <td className="px-2 py-1.5 text-right">
                                {lc.fromLineTotal != null && lc.toLineTotal != null ? (
                                  <span className={(lc.toLineTotal - lc.fromLineTotal) >= 0 ? "text-green-700" : "text-red-700"}>
                                    {(lc.toLineTotal - lc.fromLineTotal) >= 0 ? "+" : ""}
                                    {(lc.toLineTotal - lc.fromLineTotal).toFixed(2)}
                                  </span>
                                ) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          TAB: TENDERS HISTORY
         ════════════════════════════════════════════════════════════════════ */}
      {activeTab === "history" && (
        <Card role="tabpanel" id="tender-history-panel" aria-labelledby="tender-history-tab">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium">
                Tenders
                {(historySearch || historyStatusFilter) && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {historyTotalCount} matching
                  </span>
                )}
              </CardTitle>
              {isAdmin && (
                <Link
                  href="/admin/audit?sourcePage=admin%2Fb2b%2Ftenders"
                  className="text-xs underline text-muted-foreground hover:text-foreground"
                >
                  View Audit Log
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* DEF-9 FIX: search + filter */}
            <div className="flex flex-wrap gap-2">
              <Input
                className="h-8 max-w-xs text-sm"
                placeholder="Search by tender no, buyer, ref…"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
              <select
                className="h-8 rounded border bg-background px-2 text-sm"
                value={historyStatusFilter}
                onChange={(e) => setHistoryStatusFilter(e.target.value as "" | TenderSnapshot["status"])}
              >
                <option value="">All statuses</option>
                <option value="DRAFT">Draft</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="SENT">Sent</option>
                <option value="WON">Won</option>
                <option value="LOST">Lost</option>
                <option value="EXPIRED">Expired</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
              {(historySearch || historyStatusFilter) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setHistorySearch(""); setHistoryStatusFilter(""); }}
                >
                  Clear filters
                </Button>
              )}
            </div>

            {pagedHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {historySearch || historyStatusFilter ? "No tenders match the current filters." : "No tenders yet."}
              </p>
            ) : (
              <div className="space-y-2">
                {pagedHistory.map((row) => {
                  const reminder   = reminderByTenderId.get(row.id);
                  const orderLink  = orderLinkByTenderId.get(row.id);
                  const allowedTargets = getTenderAllowedTargets(row.status);
                  const isLocked   = allowedTargets.length === 0;
                  const selectedStatus = statusByTender[row.id] || row.status;

                  return (
                    <div key={row.id} className="flex flex-wrap items-start justify-between gap-2 rounded border p-3 text-sm">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          <span>{row.tenderNumber} — {row.buyerName}</span>
                          <TenderStatusBadge status={row.status} />
                          {reminder?.isExpiringSoon && (
                            <Badge variant="warning">Expires in {reminder.daysToExpiry}d</Badge>
                          )}
                          {orderLink && (
                            <Badge variant="secondary">Order linked</Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{row.currency} {row.total.toFixed(2)}</span>
                          <span>Updated {formatDateGH(row.updatedAt)}</span>
                          {row.tenderRef && (
                            <span>
                              Ref:{" "}
                              {procurementRequests.some((r) => r.id === row.tenderRef) ? (
                                <Link
                                  href={`/admin/b2b/procurement?highlight=${encodeURIComponent(row.tenderRef)}`}
                                  className="underline text-primary"
                                >
                                  {row.tenderRef.slice(0, 12)}…
                                </Link>
                              ) : (
                                row.tenderRef
                              )}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {/* Status dropdown + set */}
                        <select
                          className="h-8 rounded border bg-background px-2 text-xs"
                          value={selectedStatus}
                          onChange={(e) =>
                            setStatusByTender((prev) => ({
                              ...prev,
                              [row.id]: e.target.value as TenderSnapshot["status"],
                            }))
                          }
                          disabled={isLocked}
                        >
                          <option value={row.status}>{row.status}</option>
                          {allowedTargets.map((target) => (
                            <option key={`${row.id}-${target}`} value={target}>{target}</option>
                          ))}
                        </select>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => updateTenderStatus(row.id)}
                          disabled={busy || isLocked || selectedStatus === row.status}
                        >
                          Set
                        </Button>

                        <Button variant="outline" size="sm" onClick={() => { loadTenderForEdit(row); setActiveTab("build"); }}>
                          {row.status === "DRAFT" ? "Edit" : "Revise"}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openPdf(row.id)}>
                          PDF
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => downloadPackage(row.id)}>
                          Export
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSendTenderId(row.id);
                            if (row.buyerEmail && !emailTo.trim()) setEmailTo(row.buyerEmail);
                            setActiveTab("send");
                          }}
                          disabled={!isTenderSendEligible(row.status)}
                        >
                          Send
                        </Button>

                        {row.status === "WON" && !orderLink && (
                          <Button variant="secondary" size="sm" onClick={() => convertWonTenderToOrder(row.id)}>
                            Convert to Order
                          </Button>
                        )}
                        {row.status === "WON" && orderLink && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => (window.location.href = `/admin/orders/${encodeURIComponent(orderLink.orderId)}`)}
                          >
                            Open Order
                          </Button>
                        )}
                        {reminder && (
                          <Button variant="outline" size="sm" onClick={() => sendReminderNow(row.id)}>
                            Send Reminder
                          </Button>
                        )}

                        {/* DEF-4: per-tender audit trail link (admin only) */}
                        {isAdmin && (
                          <Link
                            href={`/admin/audit?entityType=B2B_TENDER&entityId=${encodeURIComponent(row.id)}`}
                            className="text-xs underline text-muted-foreground hover:text-foreground whitespace-nowrap"
                          >
                            Audit
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination */}
            {historyPageCount > 1 && (
              <div className="flex items-center justify-between pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  disabled={historyPage === 1}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {historyPage} of {historyPageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryPage((p) => Math.min(historyPageCount, p + 1))}
                  disabled={historyPage === historyPageCount}
                >
                  Next
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Confirmation Dialog ──────────────────────────────────────────── */}
      <Dialog open={Boolean(confirmAction)} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmAction?.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{confirmAction?.description}</p>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant={confirmAction?.variant ?? "default"}
              onClick={() => {
                confirmAction?.onConfirm();
                setConfirmAction(null);
              }}
            >
              {confirmAction?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </section>
  );
}
