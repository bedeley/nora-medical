"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/currency";
import { hasPermission } from "@/lib/permissions";
import { toast } from "sonner";

type Row = {
  id: string;
  createdAt: string;
  expectedAt: string | null;
  status: string;
  supplier: string;
  supplierId: string | null;
  product: { id: string; name: string; sku: string | null };
  quantity: number;
  unitCost: number;
  total: number;
  paidAmount: number;
  creditAmount?: number;
  refundAmount?: number;
  pendingAmount: number;
  outstanding: number;
  paymentStatus: string;
};

type PendingPayment = {
  id: string;
  amount: number;
  method: string;
  reference: string;
  proofUrl: string;
  note: string;
  createdAt: string;
  supplier: { id: string; name: string } | null;
  purchase: { id: string; product: { name: string; sku: string | null } | null } | null;
};
type PendingPurchaseApproval = {
  id: string;
  createdAt: string;
  supplier: string;
  supplierId: string | null;
  product: { id: string; name: string; sku: string | null } | null;
  quantity: number;
  unitCost: number;
  total: number;
  expectedAt: string | null;
  status: string;
};
type ApprovalConfirmState =
  | {
      kind: "purchase";
      id: string;
      supplier: string;
      itemLabel: string;
      amount: number;
    }
  | {
      kind: "payment";
      id: string;
      supplier: string;
      itemLabel: string;
      amount: number;
      method?: string;
      reference?: string;
      proofUrl?: string;
      note?: string;
    };

type SupplierOption = {
  id: string;
  name: string;
};
type SortMode = "newest" | "oldest" | "amount_desc" | "amount_asc";
type ExposureView = "full" | "received";
type SummaryBasis = "operational" | "ledger_ap";
type AgingFilter =
  | "all"
  | "due_today"
  | "due_7"
  | "overdue"
  | "0_30"
  | "31_60"
  | "61_90"
  | "90_plus";
type SavedFilterPreset = {
  name: string;
  q: string;
  supplierId: string;
  month: string;
  status: string;
  strictDate: boolean;
  sortMode: SortMode;
  exposureView: ExposureView;
  summaryBasis: SummaryBasis;
  agingFilter: AgingFilter;
  pageSize: number;
};
type SavedRecipient = {
  email: string;
  label?: string;
};
type SummaryScheduleFrequency = "OFF" | "DAILY" | "WEEKLY";
type SummaryScheduleConfig = {
  enabled: boolean;
  frequency: SummaryScheduleFrequency;
  to: string;
  cc?: string;
  subjectPrefix?: string;
  weekday?: number; // 0-6 for weekly
  lastSentAt?: string;
};
type CronRecipientPreview = {
  to: string[];
  cc: string[];
};

const summaryBasisHelp =
  "Operational exposure = all operational open supplier exposure (including ordered/not-received). " +
  "Ledger AP basis = accounting-focused received AP outstanding. " +
  "Compare both to spot timing/posting gaps between operations and finance.";
const summaryBasisOperationalHelp =
  "Use Operational exposure for day-to-day follow-up and procurement execution queues.";
const summaryBasisLedgerHelp =
  "Use Ledger AP basis for accounting reconciliation, AP review, and period-close reporting.";
const summaryBasisCadenceHelp =
  "Review deviations daily (or at least weekly). Investigate any non-trivial delta that persists after posting cycles.";
const SUMMARY_ALERTS_STORAGE_KEY = "supplierPayments.summaryAlerts.v1";
const SUMMARY_SCHEDULE_STORAGE_KEY = "supplierPayments.summarySchedule.v1";
const CRON_TEST_LAST_SENT_KEY = "supplierPayments.cronTest.lastRunAt.v1";
const CRON_TEST_COOLDOWN_SECONDS = 60;
const SUPPLIER_PAYMENTS_SOURCE_PAGE = "admin/supplier-payments";
const SUPPLIER_PAYMENTS_AUDIT_HREF = "/admin/audit?sourcePage=admin%2Fsupplier-payments";

const paymentEligibleStatuses = new Set([
  "APPROVED",
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
]);
const purchaseStatusLabels: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending purchase approval",
  APPROVED: "Approved",
  ORDERED: "Ordered",
  PARTIALLY_RECEIVED: "Partially received",
  RECEIVED: "Received",
  CANCELLED: "Cancelled",
};
const paymentStatusLabels: Record<string, string> = {
  UNPAID: "Unpaid",
  PAID: "Paid",
  PARTIALLY_PAID: "Partially paid",
  PENDING_APPROVAL: "Pending payment approval",
};

function isValidUrl(value: string): boolean {
  if (!value.trim()) return true; // optional field
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string })?.error || "Failed to load supplier payables.";
    throw new Error(message);
  }
  return data;
};

function humanPurchaseStatus(status: string) {
  return purchaseStatusLabels[status] || status;
}

function humanPaymentStatus(status: string) {
  return paymentStatusLabels[status] || status;
}

function statusChipClass(kind: "ok" | "warn" | "info" | "neutral" | "danger") {
  if (kind === "ok") return "bg-emerald-100 text-emerald-800";
  if (kind === "warn") return "bg-amber-100 text-amber-800";
  if (kind === "info") return "bg-sky-100 text-sky-800";
  if (kind === "danger") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function rowUrgencyClass(row: Row): string {
  if (Number(row.outstanding || 0) <= 0.01) return "";
  const diff = expectedDiffDays(row.expectedAt);
  if (diff !== null && diff < 0) return "bg-rose-50 border-l-4 border-l-rose-400";
  if (diff !== null && diff <= 7) return "bg-amber-50 border-l-4 border-l-amber-400";
  if (row.paymentStatus === "UNPAID" && (row.status === "RECEIVED" || row.status === "PARTIALLY_RECEIVED"))
    return "bg-slate-50";
  return "";
}

function paymentChipTone(status: string): "ok" | "warn" | "info" | "neutral" | "danger" {
  if (status === "PAID") return "ok";
  if (status === "PARTIALLY_PAID") return "info";
  if (status === "PENDING_APPROVAL") return "warn";
  if (status === "UNPAID") return "neutral";
  return "neutral";
}

function operationalStatus(row: Row) {
  if (row.status === "PENDING_APPROVAL") return "Pending purchase approval";
  if (row.paymentStatus === "PENDING_APPROVAL") return "Pending payment approval";
  if (
    (row.status === "RECEIVED" || row.status === "PARTIALLY_RECEIVED") &&
    row.outstanding > 0.01 &&
    row.paidAmount <= 0.01
  ) {
    return "Unpaid received";
  }
  return `${humanPurchaseStatus(row.status)} / ${humanPaymentStatus(row.paymentStatus)}`;
}

function sortRows<T extends { createdAt: string; total?: number; amount?: number }>(
  items: T[],
  sortMode: SortMode,
) {
  const list = [...items];
  list.sort((a, b) => {
    if (sortMode === "amount_desc") return Number(b.total ?? b.amount ?? 0) - Number(a.total ?? a.amount ?? 0);
    if (sortMode === "amount_asc") return Number(a.total ?? a.amount ?? 0) - Number(b.total ?? b.amount ?? 0);
    const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return sortMode === "newest" ? delta : -delta;
  });
  return list;
}

function daysBetween(fromIso: string, toDate = new Date()) {
  const from = new Date(fromIso);
  const ms = toDate.getTime() - from.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function getAgingBucket(days: number) {
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

function expectedStatus(expectedAt: string | null, today = new Date()) {
  if (!expectedAt) return { label: "No expected date", tone: "neutral" as const };
  const expected = new Date(expectedAt);
  const expectedDay = new Date(expected.getFullYear(), expected.getMonth(), expected.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.floor((expectedDay.getTime() - todayDay.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { label: `Overdue ${Math.abs(diffDays)}d`, tone: "danger" as const };
  if (diffDays <= 7) return { label: `Due in ${diffDays}d`, tone: "warn" as const };
  return { label: `Due in ${diffDays}d`, tone: "ok" as const };
}

function expectedDiffDays(expectedAt: string | null, today = new Date()) {
  if (!expectedAt) return null;
  const expected = new Date(expectedAt);
  const expectedDay = new Date(expected.getFullYear(), expected.getMonth(), expected.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((expectedDay.getTime() - todayDay.getTime()) / (1000 * 60 * 60 * 24));
}

export default function SupplierPaymentsPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const canManageSupplierPayments = hasPermission(role, "supplierPayments.manage");
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const fromAgingHub = Boolean(
    searchParams.get("agingFilter") ||
      searchParams.get("sortMode") ||
      searchParams.get("exposureView") ||
      searchParams.get("outstandingOnly"),
  );
  const focusedPaymentId = String(searchParams.get("paymentId") || "").trim();
  const [q, setQ] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [month, setMonth] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [strictDate, setStrictDate] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [exposureView, setExposureView] = useState<ExposureView>("full");
  const [summaryBasis, setSummaryBasis] = useState<SummaryBasis>("operational");
  const [agingFilter, setAgingFilter] = useState<AgingFilter>("all");
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentRow, setPaymentRow] = useState<Row | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentProof, setPaymentProof] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAmount, setBulkAmount] = useState("");
  const [bulkMethod, setBulkMethod] = useState("cash");
  const [bulkReference, setBulkReference] = useState("");
  const [bulkProof, setBulkProof] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("bank");
  const [refundReference, setRefundReference] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refundError, setRefundError] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [confirmState, setConfirmState] = useState<ApprovalConfirmState | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [savedRecipients, setSavedRecipients] = useState<SavedRecipient[]>([]);
  const [deviationAbsThreshold, setDeviationAbsThreshold] = useState("50");
  const [deviationPctThreshold, setDeviationPctThreshold] = useState("2");
  const [scheduleConfig, setScheduleConfig] = useState<SummaryScheduleConfig>({
    enabled: false,
    frequency: "OFF",
    to: "",
    cc: "",
    subjectPrefix: "Supplier payables summary",
    weekday: 1,
    lastSentAt: "",
  });
  const [cronTestSubmitting, setCronTestSubmitting] = useState(false);
  const [lastCronTestAt, setLastCronTestAt] = useState("");
  const [cronTestRemaining, setCronTestRemaining] = useState(0);
  const [cronRecipientPreview, setCronRecipientPreview] = useState<CronRecipientPreview>({ to: [], cc: [] });
  const [lastSummaryEmailInfo, setLastSummaryEmailInfo] = useState<{
    to: string;
    cc?: string;
    at: string;
  } | null>(null);
  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [selectedPresetName, setSelectedPresetName] = useState("");
  const [chartSupplierKey, setChartSupplierKey] = useState("");

  useEffect(() => {
    const supplier = searchParams.get("supplier");
    const supplierIdParam = searchParams.get("supplierId");
    const agingFilterParam = searchParams.get("agingFilter");
    const sortModeParam = searchParams.get("sortMode");
    const exposureViewParam = searchParams.get("exposureView");
    const outstandingOnlyParam = searchParams.get("outstandingOnly");
    if (supplierIdParam) {
      setSupplierId(supplierIdParam);
      setPage(1);
    }
    if (supplier) {
      setQ(supplier);
      setPage(1);
    }
    if (
      agingFilterParam &&
      ["all", "due_today", "due_7", "overdue", "0_30", "31_60", "61_90", "90_plus"].includes(
        agingFilterParam,
      )
    ) {
      setAgingFilter(agingFilterParam as AgingFilter);
      setPage(1);
    }
    if (sortModeParam && ["newest", "oldest", "amount_desc", "amount_asc"].includes(sortModeParam)) {
      setSortMode(sortModeParam as SortMode);
      setPage(1);
    }
    if (exposureViewParam && ["full", "received"].includes(exposureViewParam)) {
      setExposureView(exposureViewParam as ExposureView);
      setPage(1);
    }
    setOutstandingOnly(outstandingOnlyParam === "1");
  }, [searchParams]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("supplierPayments.filterPresets.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setSavedPresets(parsed as SavedFilterPreset[]);
    } catch {
      // ignore malformed local preset storage
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCronRecipientPreview = async () => {
      try {
        const res = await fetch("/api/admin/supplier-payables/summary/cron/test", { method: "GET" });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || !payload) return;
        if (cancelled) return;
        setCronRecipientPreview({
          to: Array.isArray(payload.to) ? payload.to : [],
          cc: Array.isArray(payload.cc) ? payload.cc : [],
        });
      } catch {
        // best-effort preview only
      }
    };
    loadCronRecipientPreview();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("supplierPayments.summaryRecipients.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setSavedRecipients(parsed as SavedRecipient[]);
    } catch {
      // ignore malformed recipient storage
    }
    try {
      const raw = window.localStorage.getItem("supplierPayments.lastSummaryEmail.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      setLastSummaryEmailInfo(parsed as { to: string; cc?: string; at: string });
    } catch {
      // ignore malformed last-send storage
    }
    try {
      const raw = window.localStorage.getItem(SUMMARY_ALERTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { abs?: string; pct?: string };
        if (typeof parsed.abs === "string") setDeviationAbsThreshold(parsed.abs);
        if (typeof parsed.pct === "string") setDeviationPctThreshold(parsed.pct);
      }
    } catch {
      // ignore malformed thresholds
    }
    try {
      const raw = window.localStorage.getItem(SUMMARY_SCHEDULE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SummaryScheduleConfig>;
        if (parsed && typeof parsed === "object") {
          setScheduleConfig((prev) => ({
            ...prev,
            ...parsed,
          }));
        }
      }
    } catch {
      // ignore malformed schedule
    }
    try {
      const raw = window.localStorage.getItem(CRON_TEST_LAST_SENT_KEY);
      if (raw) setLastCronTestAt(raw);
    } catch {
      // ignore malformed test timestamp
    }
  }, []);

  useEffect(() => {
    if (!lastCronTestAt) {
      setCronTestRemaining(0);
      return;
    }
    const tick = () => {
      const elapsed = (Date.now() - new Date(lastCronTestAt).getTime()) / 1000;
      const remaining = Math.max(0, Math.ceil(CRON_TEST_COOLDOWN_SECONDS - elapsed));
      setCronTestRemaining(remaining);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lastCronTestAt]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      SUMMARY_ALERTS_STORAGE_KEY,
      JSON.stringify({ abs: deviationAbsThreshold, pct: deviationPctThreshold }),
    );
  }, [deviationAbsThreshold, deviationPctThreshold]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SUMMARY_SCHEDULE_STORAGE_KEY, JSON.stringify(scheduleConfig));
  }, [scheduleConfig]);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (supplierId) sp.set("supplierId", supplierId);
    if (focusedPaymentId) sp.set("paymentId", focusedPaymentId);
    if (month) sp.set("month", month);
    if (status !== "all") sp.set("status", status);
    if (strictDate) sp.set("strictDate", "1");
    sp.set("sortMode", sortMode);
    sp.set("exposureView", exposureView);
    sp.set("agingFilter", agingFilter);
    if (outstandingOnly) sp.set("outstandingOnly", "1");
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [q, supplierId, focusedPaymentId, month, status, strictDate, sortMode, exposureView, agingFilter, outstandingOnly, page, pageSize]);

  const { data, error, isLoading } = useClientQuery<{
    rows: Row[];
    scopeRows: Row[];
    total: number;
    totalAmount: number;
    totalPaid: number;
    totalPending: number;
    totalPendingPaymentApprovals?: number;
    totalPendingPurchaseApprovals?: number;
    totalCredits: number;
    totalRefunds: number;
    totalCreditBalance: number;
    totalOutstanding: number;
    page: number;
    pageSize: number;
    pendingPayments: PendingPayment[];
    pendingPurchaseApprovals: PendingPurchaseApproval[];
  }>({
    queryKey: [
      "admin",
      "supplier-payments",
      q,
      supplierId,
      focusedPaymentId,
      month,
      status,
      strictDate,
      sortMode,
      exposureView,
      agingFilter,
      outstandingOnly,
      page,
      pageSize,
    ],
    queryFn: () => fetcher(`/api/admin/supplier-payments?${params}`),
  });

  const { data: suppliersData } = useClientQuery<{ rows: SupplierOption[] }>({
    queryKey: ["admin", "suppliers", "payables-filter"],
    queryFn: () => fetch("/api/admin/suppliers?includeArchived=0").then((r) => r.json()),
  });
  const supplierOptions = Array.isArray(suppliersData?.rows) ? suppliersData?.rows : [];

  const scopedRows = useMemo(() => (Array.isArray(data?.scopeRows) ? (data?.scopeRows as Row[]) : []), [data?.scopeRows]);
  const rows = useMemo(() => (Array.isArray(data?.rows) ? (data?.rows as Row[]) : []), [data?.rows]);
  const supplierChartOptions = useMemo(() => {
    const map = new Map<string, { key: string; label: string; total: number }>();
    for (const row of scopedRows) {
      const outstanding = Number(row.outstanding || 0);
      if (outstanding <= 0.01) continue;
      const key = row.supplierId || `name:${row.supplier}`;
      const label = row.supplier;
      const current = map.get(key);
      if (current) {
        current.total += outstanding;
      } else {
        map.set(key, { key, label, total: outstanding });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [scopedRows]);
  useEffect(() => {
    if (supplierId) {
      if (chartSupplierKey !== supplierId) setChartSupplierKey(supplierId);
      return;
    }
    const exists = supplierChartOptions.some((option) => option.key === chartSupplierKey);
    if (!exists) setChartSupplierKey(supplierChartOptions[0]?.key || "");
  }, [supplierId, supplierChartOptions, chartSupplierKey]);
  const supplierAgingChart = useMemo(() => {
    const totals = { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 } as Record<
      "0_30" | "31_60" | "61_90" | "90_plus",
      number
    >;
    if (!chartSupplierKey) return { totals, max: 0, total: 0, label: "No supplier selected" };
    for (const row of scopedRows) {
      const key = row.supplierId || `name:${row.supplier}`;
      if (key !== chartSupplierKey) continue;
      const outstanding = Number(row.outstanding || 0);
      if (outstanding <= 0.01) continue;
      const bucket = getAgingBucket(daysBetween(row.createdAt));
      totals[bucket] += outstanding;
    }
    const total = totals["0_30"] + totals["31_60"] + totals["61_90"] + totals["90_plus"];
    const max = Math.max(totals["0_30"], totals["31_60"], totals["61_90"], totals["90_plus"], 0);
    const label = supplierChartOptions.find((option) => option.key === chartSupplierKey)?.label || "Supplier";
    return { totals, max, total, label };
  }, [scopedRows, chartSupplierKey, supplierChartOptions]);
  const total = data?.total || 0;
  const totalAmount = data?.totalAmount || 0;
  const totalPaid = data?.totalPaid || 0;
  const totalPendingPaymentApprovals =
    data?.totalPendingPaymentApprovals ?? data?.totalPending ?? 0;
  const totalPendingPurchaseApprovals = data?.totalPendingPurchaseApprovals || 0;
  const totalCredits = data?.totalCredits || 0;
  const totalRefunds = data?.totalRefunds || 0;
  const totalCreditBalance = data?.totalCreditBalance || 0;
  const totalOutstanding = data?.totalOutstanding || 0;
  const receivedApOutstanding = scopedRows
    .filter((row) => row.status === "RECEIVED" || row.status === "PARTIALLY_RECEIVED")
    .reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const orderedNotReceivedExposure = scopedRows
    .filter((row) => row.status === "ORDERED" || row.status === "APPROVED")
    .reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const netPayable = totalAmount - totalPaid - totalCredits + totalRefunds;
  const creditExcess = Math.max(0, -netPayable);
  const normalizedNet = netPayable < 0 ? 0 : netPayable;
  const selectedOutstanding = summaryBasis === "ledger_ap" ? receivedApOutstanding : totalOutstanding;
  const selectedBasisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
  const reconciliationTarget = summaryBasis === "ledger_ap" ? receivedApOutstanding : normalizedNet;
  const reconciliationDelta = Number((selectedOutstanding - reconciliationTarget).toFixed(2));
  const absThreshold = Number(deviationAbsThreshold || 0);
  const pctThreshold = Number(deviationPctThreshold || 0);
  const deltaAbsolute = Math.abs(reconciliationDelta);
  const deltaPct =
    Math.abs(reconciliationTarget) > 0.01
      ? Number(((deltaAbsolute / Math.abs(reconciliationTarget)) * 100).toFixed(2))
      : 0;
  const deviationExceedsAbsolute = Number.isFinite(absThreshold) && absThreshold > 0 && deltaAbsolute >= absThreshold;
  const deviationExceedsPct = Number.isFinite(pctThreshold) && pctThreshold > 0 && deltaPct >= pctThreshold;
  const deviationSeverity: "none" | "warn" | "critical" =
    deviationExceedsAbsolute && deviationExceedsPct
      ? "critical"
      : deviationExceedsAbsolute || deviationExceedsPct
        ? "warn"
        : "none";
  const now = new Date();
  const isScheduleDue = (() => {
    if (!scheduleConfig.enabled || scheduleConfig.frequency === "OFF") return false;
    if (!scheduleConfig.to?.trim()) return false;
    const lastSentAt = scheduleConfig.lastSentAt ? new Date(scheduleConfig.lastSentAt) : null;
    if (!lastSentAt || Number.isNaN(lastSentAt.getTime())) return true;
    const elapsedMs = now.getTime() - lastSentAt.getTime();
    if (scheduleConfig.frequency === "DAILY") {
      return elapsedMs >= 24 * 60 * 60 * 1000;
    }
    const scheduledWeekday = Number(scheduleConfig.weekday ?? 1);
    return now.getDay() === scheduledWeekday && elapsedMs >= 6 * 24 * 60 * 60 * 1000;
  })();
  const hasScopeBoundaryMismatch = Math.abs(reconciliationDelta) > 0.01 || !strictDate || status !== "all";
  const agingBuckets = useMemo(() => {
    const base = { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 } as Record<
      "0_30" | "31_60" | "61_90" | "90_plus",
      number
    >;
    for (const row of scopedRows) {
      const outstanding = Number(row.outstanding || 0);
      if (outstanding <= 0.01) continue;
      const bucket = getAgingBucket(daysBetween(row.createdAt));
      base[bucket] += outstanding;
    }
    return base;
  }, [scopedRows]);
  const nextActions = useMemo(() => {
    let overdue = 0;
    let dueToday = 0;
    let due7 = 0;
    for (const row of scopedRows) {
      const outstanding = Number(row.outstanding || 0);
      if (outstanding <= 0.01) continue;
      const diff = expectedDiffDays(row.expectedAt);
      if (diff === null) continue;
      if (diff < 0) overdue += 1;
      if (diff === 0) dueToday += 1;
      if (diff >= 0 && diff <= 7) due7 += 1;
    }
    return { overdue, dueToday, due7 };
  }, [scopedRows]);
  const pendingPayments = useMemo(
    () =>
      sortRows(((data?.pendingPayments || []) as PendingPayment[]), sortMode),
    [data?.pendingPayments, sortMode],
  );
  const pendingPurchaseApprovals = useMemo(
    () => sortRows(((data?.pendingPurchaseApprovals || []) as PendingPurchaseApproval[]), sortMode),
    [data?.pendingPurchaseApprovals, sortMode],
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const isClientFiltered = false;
  const uniqueSuppliers = Array.from(new Set(scopedRows.map((r) => r.supplierId || r.supplier)));
  const bulkSupplierName = scopedRows.find((r) => r.supplier)?.supplier || "";
  const bulkSupplierId = scopedRows.find((r) => r.supplierId)?.supplierId || "";
  const supplierScopeOnly =
    Boolean(supplierId) &&
    !month &&
    status === "all" &&
    agingFilter === "all" &&
    !outstandingOnly &&
    exposureView === "full";
  const canBulkPay =
    canManageSupplierPayments &&
    Boolean(supplierId || q.trim()) &&
    uniqueSuppliers.length === 1 &&
    totalOutstanding > 0.01;
  const canRefund =
    canManageSupplierPayments &&
    supplierScopeOnly &&
    uniqueSuppliers.length === 1 &&
    totalCreditBalance > 0.01;
  const buildApAgingHref = () => {
    const sp = new URLSearchParams();
    const supplierName =
      supplierOptions.find((s) => s.id === supplierId)?.name ||
      (q.trim() || "");
    if (supplierName) sp.set("q", supplierName);
    if (month) {
      const [yy, mm] = month.split("-").map((v) => Number(v));
      if (Number.isFinite(yy) && Number.isFinite(mm)) {
        const asOfDate = new Date(yy, mm, 0);
        const asOf = `${asOfDate.getFullYear()}-${String(asOfDate.getMonth() + 1).padStart(2, "0")}-${String(
          asOfDate.getDate(),
        ).padStart(2, "0")}`;
        sp.set("asOf", asOf);
      }
    }
    return `/admin/accounting/aging/ap${sp.toString() ? `?${sp.toString()}` : ""}`;
  };
  const toCsvValue = (value: string | number | null | undefined) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
  };
  const buildCurrentViewCsvContent = () => {
    const header = [
      "Date",
      "Supplier",
      "Product",
      "SKU",
      "Qty",
      "Unit Cost",
      "Total",
      "Paid",
      "Outstanding",
      "Operational State",
      "Payment State",
      "Expected",
      "Purchase ID",
    ];
    const lines = [header.join(",")];
    for (const row of rows) {
      lines.push(
        [
          new Date(row.createdAt).toISOString(),
          row.supplier,
          row.product?.name || "Unknown",
          row.product?.sku || "",
          row.quantity,
          row.unitCost.toFixed(2),
          row.total.toFixed(2),
          Number(row.paidAmount || 0).toFixed(2),
          Number(row.outstanding || 0).toFixed(2),
          operationalStatus(row),
          humanPaymentStatus(row.paymentStatus),
          row.expectedAt ? new Date(row.expectedAt).toISOString().slice(0, 10) : "",
          row.id,
        ]
          .map(toCsvValue)
          .join(","),
      );
    }
    return lines.join("\n");
  };
  const buildSummaryCsvContent = () => {
    const scopeLabel = exposureView === "received" ? "Received AP only" : "Full exposure";
    const basisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
    const statusLabel = status === "all" ? "All statuses" : status;
    const monthLabel = month || "All months";
    return [
      ["Metric", "Value"],
      ["Scope", scopeLabel],
      ["Summary basis", basisLabel],
      ["Status filter", statusLabel],
      ["Month filter", monthLabel],
      ["Rows in view", String(rows.length)],
      ["Total amount", totalAmount.toFixed(2)],
      ["Paid", totalPaid.toFixed(2)],
      ["Pending payment approvals", totalPendingPaymentApprovals.toFixed(2)],
      ["Pending purchase approvals", totalPendingPurchaseApprovals.toFixed(2)],
      ["Supplier credits", totalCredits.toFixed(2)],
      ["Refunds received", totalRefunds.toFixed(2)],
      ["Credit balance", totalCreditBalance.toFixed(2)],
      ["Outstanding (selected basis)", selectedOutstanding.toFixed(2)],
      ["Received AP outstanding", receivedApOutstanding.toFixed(2)],
      ["Ordered not received exposure", orderedNotReceivedExposure.toFixed(2)],
      ["Aging 0-30 days", agingBuckets["0_30"].toFixed(2)],
      ["Aging 31-60 days", agingBuckets["31_60"].toFixed(2)],
      ["Aging 61-90 days", agingBuckets["61_90"].toFixed(2)],
      ["Aging 90+ days", agingBuckets["90_plus"].toFixed(2)],
      ["Reconciliation net payable", reconciliationTarget.toFixed(2)],
      ["Reconciliation delta", reconciliationDelta.toFixed(2)],
    ]
      .map((pair) => pair.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(","))
      .join("\n");
  };
  const bulkAllocations = useMemo(() => {
    const amount = Number(bulkAmount);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const ordered = [...scopedRows]
      .filter((r) => Number(r.outstanding || 0) > 0.01)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    let remaining = amount;
    const allocations: Array<{ id: string; label: string; amount: number }> = [];
    for (const row of ordered) {
      if (remaining <= 0) break;
      const outstanding = Number(row.outstanding || 0);
      const apply = Math.min(outstanding, remaining);
      if (apply <= 0) continue;
      allocations.push({
        id: row.id,
        label: `${row.product.name}${row.product.sku ? ` (${row.product.sku})` : ""}`,
        amount: apply,
      });
      remaining -= apply;
    }
    return allocations;
  }, [bulkAmount, scopedRows]);

  const approveSupplierPayment = async (paymentId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/supplier-payments/${paymentId}/approve?sourcePage=${encodeURIComponent(SUPPLIER_PAYMENTS_SOURCE_PAGE)}`, {
        method: "POST",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to approve payment.");
      toast.success("Supplier payment approved.");
      queryClient.invalidateQueries({ queryKey: ["admin", "supplier-payments"] });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to approve payment.");
      return false;
    }
  };
  const approvePurchase = async (purchaseId: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/purchases/${purchaseId}/approve?sourcePage=${encodeURIComponent(SUPPLIER_PAYMENTS_SOURCE_PAGE)}`, {
        method: "POST",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to approve purchase.");
      toast.success("Purchase approved.");
      queryClient.invalidateQueries({ queryKey: ["admin", "supplier-payments"] });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to approve purchase.");
      return false;
    }
  };
  const openApprovePurchaseConfirm = (purchase: PendingPurchaseApproval) => {
    setConfirmState({
      kind: "purchase",
      id: purchase.id,
      supplier: purchase.supplier,
      itemLabel: purchase.product?.name || "Unknown",
      amount: purchase.total,
    });
    setConfirmOpen(true);
  };
  const openApprovePaymentConfirm = (payment: PendingPayment) => {
    setConfirmState({
      kind: "payment",
      id: payment.id,
      supplier: payment.supplier?.name || "Unknown",
      itemLabel: payment.purchase?.product?.name || payment.purchase?.id || "Supplier payment",
      amount: payment.amount,
      method: payment.method || undefined,
      reference: payment.reference || undefined,
      proofUrl: payment.proofUrl || undefined,
      note: payment.note || undefined,
    });
    setConfirmOpen(true);
  };
  const submitApprovalConfirm = async () => {
    if (!confirmState) return;
    setConfirmSubmitting(true);
    const ok =
      confirmState.kind === "purchase"
        ? await approvePurchase(confirmState.id)
        : await approveSupplierPayment(confirmState.id);
    setConfirmSubmitting(false);
    if (ok) {
      setConfirmOpen(false);
      setConfirmState(null);
    }
  };
  const pendingPurchaseAfterPreview =
    confirmState?.kind === "purchase"
      ? Math.max(0, totalPendingPurchaseApprovals - (confirmState.amount || 0))
      : totalPendingPurchaseApprovals;
  const pendingPaymentAfterPreview =
    confirmState?.kind === "payment"
      ? Math.max(0, totalPendingPaymentApprovals - (confirmState.amount || 0))
      : totalPendingPaymentApprovals;

  const resetFilters = () => {
    setQ("");
    setSupplierId("");
    setMonth("");
    setStatus("all");
    setStrictDate(true);
    setSummaryBasis("operational");
    setAgingFilter("all");
    setOutstandingOnly(false);
    setPage(1);
  };
  const saveCurrentPreset = () => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Enter a preset name.");
      return;
    }
    const next: SavedFilterPreset = {
      name,
      q,
      supplierId,
      month,
      status,
      strictDate,
      sortMode,
      exposureView,
      summaryBasis,
      agingFilter,
      pageSize,
    };
    const merged = [...savedPresets.filter((preset) => preset.name !== name), next];
    setSavedPresets(merged);
    setSelectedPresetName(name);
    setPresetName("");
    window.localStorage.setItem("supplierPayments.filterPresets.v1", JSON.stringify(merged));
    toast.success("Filter preset saved.");
  };
  const applySelectedPreset = () => {
    if (!selectedPresetName) {
      toast.error("Select a saved preset first.");
      return;
    }
    const preset = savedPresets.find((item) => item.name === selectedPresetName);
    if (!preset) {
      toast.error("Preset not found.");
      return;
    }
    setQ(preset.q);
    setSupplierId(preset.supplierId);
    setMonth(preset.month);
    setStatus(preset.status);
    setStrictDate(preset.strictDate);
    setSortMode(preset.sortMode);
    setExposureView(preset.exposureView);
    setSummaryBasis(preset.summaryBasis || "operational");
    setAgingFilter(preset.agingFilter);
    setPageSize(preset.pageSize);
    setPage(1);
    toast.success("Preset applied.");
  };
  const deleteSelectedPreset = () => {
    if (!selectedPresetName) {
      toast.error("Select a preset to delete.");
      return;
    }
    const next = savedPresets.filter((preset) => preset.name !== selectedPresetName);
    setSavedPresets(next);
    setSelectedPresetName("");
    window.localStorage.setItem("supplierPayments.filterPresets.v1", JSON.stringify(next));
    toast.success("Preset deleted.");
  };

  const openPaymentDialog = (row: Row) => {
    setPaymentRow(row);
    setPaymentAmount(String(row.outstanding || ""));
    setPaymentMethod("cash");
    setPaymentReference("");
    setPaymentProof("");
    setPaymentNote("");
    setPaymentError("");
    setPaymentOpen(true);
  };

  const openBulkDialog = () => {
    setBulkAmount(String(totalOutstanding.toFixed(2)));
    setBulkMethod("cash");
    setBulkReference("");
    setBulkProof("");
    setBulkNote("");
    setBulkError("");
    setBulkOpen(true);
  };

  const openRefundDialog = () => {
    setRefundAmount(String(totalCreditBalance.toFixed(2)));
    setRefundMethod("bank");
    setRefundReference("");
    setRefundNote("");
    setRefundError("");
    setRefundOpen(true);
  };

  const submitBulkPayment = async () => {
    if (!canManageSupplierPayments) {
      setBulkError("Only admins can record supplier payments.");
      return;
    }
    const amount = Number(bulkAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setBulkError("Enter a valid payment amount.");
      return;
    }
    if (amount > totalOutstanding + 0.01) {
      setBulkError("Amount exceeds outstanding balance.");
      return;
    }
    if (bulkProof && !isValidUrl(bulkProof)) {
      setBulkError("Proof URL must be a valid http/https URL.");
      return;
    }
    setBulkSubmitting(true);
    setBulkError("");
    try {
      const res = await fetch("/api/admin/supplier-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          supplierId: bulkSupplierId || undefined,
          supplierName: bulkSupplierName || undefined,
          purchaseIds: scopedRows.map((row) => row.id),
          amount,
          method: bulkMethod,
          reference: bulkReference || undefined,
          proofUrl: bulkProof || undefined,
          note: bulkNote || undefined,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const message = payload?.error || "Failed to record bulk payment.";
        throw new Error(message);
      }
      setBulkOpen(false);
      toast.success("Bulk supplier payment recorded.");
      queryClient.invalidateQueries({ queryKey: ["admin", "supplier-payments"] });
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Failed to record bulk payment.");
    } finally {
      setBulkSubmitting(false);
    }
  };

  const submitRefund = async () => {
    if (!canManageSupplierPayments) {
      setRefundError("Only admins can record supplier refunds.");
      return;
    }
    const amount = Number(refundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setRefundError("Enter a valid refund amount.");
      return;
    }
    if (amount > totalCreditBalance + 0.01) {
      setRefundError("Amount exceeds available supplier credit.");
      return;
    }
    setRefundSubmitting(true);
    setRefundError("");
    try {
      const res = await fetch("/api/admin/supplier-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          kind: "refund",
          supplierId: bulkSupplierId || undefined,
          supplierName: bulkSupplierName || undefined,
          amount,
          method: refundMethod,
          reference: refundReference || undefined,
          note: refundNote || undefined,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const message = payload?.error || "Failed to record supplier refund.";
        throw new Error(message);
      }
      setRefundOpen(false);
      toast.success("Supplier refund recorded.");
      queryClient.invalidateQueries({ queryKey: ["admin", "supplier-payments"] });
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : "Failed to record supplier refund.");
    } finally {
      setRefundSubmitting(false);
    }
  };

  const submitPayment = async () => {
    if (!canManageSupplierPayments) {
      setPaymentError("Only admins can record supplier payments.");
      return;
    }
    if (!paymentRow) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentError("Enter a valid payment amount.");
      return;
    }
    if (amount > paymentRow.outstanding + 0.01) {
      setPaymentError("Amount exceeds outstanding balance.");
      return;
    }
    if (paymentProof && !isValidUrl(paymentProof)) {
      setPaymentError("Proof URL must be a valid http/https URL.");
      return;
    }
    setPaymentSubmitting(true);
    setPaymentError("");
    try {
      const res = await fetch("/api/admin/supplier-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          purchaseId: paymentRow.id,
          amount,
          method: paymentMethod,
          reference: paymentReference || undefined,
          proofUrl: paymentProof || undefined,
          note: paymentNote || undefined,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const message = payload?.error || "Failed to record payment.";
        throw new Error(message);
      }
      setPaymentOpen(false);
      toast.success("Payment recorded.");
      queryClient.invalidateQueries({ queryKey: ["admin", "supplier-payments"] });
    } catch (e) {
      setPaymentError(e instanceof Error ? e.message : "Failed to record payment.");
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const buildScopeSnapshot = () =>
    [
      `Source page: ${SUPPLIER_PAYMENTS_SOURCE_PAGE}`,
      `Scope: ${exposureView === "received" ? "Received AP only" : "Full exposure"}`,
      `Summary basis: ${selectedBasisLabel}`,
      `Status: ${status === "all" ? "All statuses" : status}`,
      `Month: ${month || "All months"}`,
      `Aging: ${
        agingFilter === "all"
          ? "All aging"
          : agingFilter === "due_today"
            ? "Due today"
            : agingFilter === "due_7"
              ? "Due in 7 days"
              : agingFilter === "overdue"
                ? "Overdue"
                : agingFilter.replace("_", "-").replace("plus", "+")
      }`,
      `Page: ${page}`,
      `Rows in current page: ${rows.length}`,
      `Rows in scope: ${scopedRows.length}`,
    ].join(" | ");

  const countCsvShape = (content: string) => {
    const normalized = content.replace(/\r\n/g, "\n").trim();
    if (!normalized) return { rowCount: 0, columnCount: 0 };
    const lines = normalized.split("\n");
    const header = lines[0] || "";
    return {
      rowCount: Math.max(0, lines.length - 1),
      columnCount: header ? header.split(",").length : 0,
    };
  };

  const logExportAudit = async (payload: {
    action:
      | "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_CSV"
      | "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_PDF"
      | "SUPPLIER_PAYABLES_EXPORT_SUMMARY_CSV"
      | "SUPPLIER_PAYABLES_EXPORT_SUMMARY_PDF";
    format: "CSV" | "PDF";
    fileName: string;
    rowCount?: number;
    columnCount?: number;
    byteSize?: number;
    exportLabel: string;
  }) => {
    try {
      await fetch("/api/admin/supplier-payments/export-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          scopeSnapshot: buildScopeSnapshot(),
        }),
      });
    } catch {
      // Best-effort logging; download should still succeed.
    }
  };

  const exportCurrentViewCsv = () => {
    if (!rows.length) {
      toast.error("No rows in current view to export.");
      return;
    }
    const content = buildCurrentViewCsvContent();
    const scopeLabel = exposureView === "received" ? "received-ap-only" : "full-exposure";
    const basisLabel = summaryBasis === "ledger_ap" ? "ledger-ap" : "operational";
    const statusLabel = status === "all" ? "all-statuses" : status.toLowerCase();
    const monthLabel = month || "all-months";
    const filename = `supplier_payables_${scopeLabel}_${basisLabel}_${statusLabel}_${monthLabel}_p${page}.csv`;
    const shape = countCsvShape(content);
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void logExportAudit({
      action: "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_CSV",
      format: "CSV",
      fileName: filename,
      rowCount: shape.rowCount,
      columnCount: shape.columnCount,
      byteSize: blob.size,
      exportLabel: "Current view CSV",
    });
    toast.success("Current view exported.");
  };

  const exportCurrentViewSummaryCsv = () => {
    const content = buildSummaryCsvContent();
    const statusPart = status === "all" ? "all-statuses" : status.toLowerCase();
    const monthPart = month || "all-months";
    const scopePart = exposureView === "received" ? "received-ap-only" : "full-exposure";
    const basisPart = summaryBasis === "ledger_ap" ? "ledger-ap" : "operational";
    const filename = `supplier_payables_summary_${scopePart}_${basisPart}_${statusPart}_${monthPart}_p${page}.csv`;
    const shape = countCsvShape(content);
    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    void logExportAudit({
      action: "SUPPLIER_PAYABLES_EXPORT_SUMMARY_CSV",
      format: "CSV",
      fileName: filename,
      rowCount: shape.rowCount,
      columnCount: shape.columnCount,
      byteSize: blob.size,
      exportLabel: "Summary CSV",
    });
    toast.success("Summary CSV exported.");
  };
  const exportEmailSummaryTemplate = () => {
    const scopeLabel = exposureView === "received" ? "Received AP only" : "Full exposure";
    const basisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
    const statusLabel = status === "all" ? "All statuses" : status;
    const monthLabel = month || "All months";
    const template = [
      "Subject: Supplier payables summary - action required",
      "",
      "Hello Team,",
      "",
      "Please find the current supplier payables summary below:",
      "",
      `Scope: ${scopeLabel}`,
      `Summary basis: ${basisLabel}`,
      `Status filter: ${statusLabel}`,
      `Month filter: ${monthLabel}`,
      "",
      `Outstanding (selected basis): ${formatCurrency(selectedOutstanding)}`,
      `Received AP outstanding: ${formatCurrency(receivedApOutstanding)}`,
      `Ordered not received exposure: ${formatCurrency(orderedNotReceivedExposure)}`,
      "",
      `Overdue invoices: ${nextActions.overdue}`,
      `Due today: ${nextActions.dueToday}`,
      `Due in 7 days: ${nextActions.due7}`,
      "",
      "Aging buckets:",
      `- 0-30 days: ${formatCurrency(agingBuckets["0_30"])}`,
      `- 31-60 days: ${formatCurrency(agingBuckets["31_60"])}`,
      `- 61-90 days: ${formatCurrency(agingBuckets["61_90"])}`,
      `- 90+ days: ${formatCurrency(agingBuckets["90_plus"])}`,
      "",
      "Regards,",
      "Finance / Procurement",
    ].join("\n");
    const blob = new Blob([template], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const filename = `supplier_payables_email_summary_${new Date().toISOString().slice(0, 10)}.txt`;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Email summary template exported.");
  };
  const exportBundleZip = async () => {
    if (!rows.length) {
      toast.error("No rows in current view to bundle.");
      return;
    }
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const baseName = `supplier_payables_${stamp}_p${page}`;
      const scopeSnapshot = buildScopeSnapshot();
      const notes = [
        "Supplier Payables Bundle",
        `Generated: ${new Date().toLocaleString()}`,
        `Scope: ${exposureView === "received" ? "Received AP only" : "Full exposure"}`,
        `Summary basis: ${selectedBasisLabel}`,
        `Status: ${status === "all" ? "All statuses" : status}`,
        `Month: ${month || "All months"}`,
        "",
        "Files:",
        "- current_view.csv",
        "- summary.csv",
        "- email_summary.txt",
      ].join("\n");
      const res = await fetch("/api/admin/supplier-payments/export-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseName,
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          scopeSnapshot,
          currentViewCsv: buildCurrentViewCsvContent(),
          summaryCsv: buildSummaryCsvContent(),
          emailSummaryText: buildEmailSummaryText(),
          notesText: notes,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload?.error || "Failed to export bundle.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${baseName}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Bundle ZIP downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export bundle.");
    }
  };
  const buildEmailSummaryText = () => {
    const scopeLabel = exposureView === "received" ? "Received AP only" : "Full exposure";
    const basisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
    const statusLabel = status === "all" ? "All statuses" : status;
    const monthLabel = month || "All months";
    const agingLabel =
      agingFilter === "all"
        ? "All aging"
        : agingFilter === "due_today"
          ? "Due today"
          : agingFilter === "due_7"
            ? "Due in 7 days"
            : agingFilter === "overdue"
              ? "Overdue"
              : agingFilter.replace("_", "-").replace("plus", "+");
    return [
      "Hello Team,",
      "",
      "Please find the current supplier payables summary below:",
      "",
      `Scope: ${scopeLabel}`,
      `Summary basis: ${basisLabel}`,
      `Status filter: ${statusLabel}`,
      `Month filter: ${monthLabel}`,
      `Aging filter: ${agingLabel}`,
      "",
      `Outstanding (selected basis): ${formatCurrency(selectedOutstanding)}`,
      `Received AP outstanding: ${formatCurrency(receivedApOutstanding)}`,
      `Ordered not received exposure: ${formatCurrency(orderedNotReceivedExposure)}`,
      "",
      `Overdue invoices: ${nextActions.overdue}`,
      `Due today: ${nextActions.dueToday}`,
      `Due in 7 days: ${nextActions.due7}`,
      "",
      "Aging buckets:",
      `- 0-30 days: ${formatCurrency(agingBuckets["0_30"])}`,
      `- 31-60 days: ${formatCurrency(agingBuckets["31_60"])}`,
      `- 61-90 days: ${formatCurrency(agingBuckets["61_90"])}`,
      `- 90+ days: ${formatCurrency(agingBuckets["90_plus"])}`,
      "",
      "Regards,",
      "Finance / Procurement",
    ].join("\n");
  };
  const openSendSummaryEmail = () => {
    const now = new Date().toLocaleDateString();
    setEmailSubject(`Supplier payables summary - ${now}`);
    setEmailBody(buildEmailSummaryText());
    setEmailError("");
    setEmailOpen(true);
  };
  const sendScheduledSummaryNow = async () => {
    const to = scheduleConfig.to?.trim();
    if (!to) {
      toast.error("Set schedule recipient first.");
      return;
    }
    const cc = String(scheduleConfig.cc || "").trim();
    const subjectPrefix = String(scheduleConfig.subjectPrefix || "Supplier payables summary").trim();
    const subject = `${subjectPrefix} - ${new Date().toLocaleDateString()}`;
    try {
      const res = await fetch("/api/admin/supplier-payments/email-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          to,
          cc: cc || undefined,
          subject,
          text: buildEmailSummaryText(),
          scopeSnapshot: {
            scope: exposureView === "received" ? "received-ap-only" : "full-exposure",
            basis: summaryBasis,
            statusFilter: status === "all" ? "all-statuses" : status,
            monthFilter: month || "all-months",
            agingFilter,
          },
          summarySnapshot: {
            openExposure: Number(selectedOutstanding || 0),
            receivedApOutstanding: Number(receivedApOutstanding || 0),
            orderedNotReceivedExposure: Number(orderedNotReceivedExposure || 0),
            overdueCount: Number(nextActions.overdue || 0),
            dueTodayCount: Number(nextActions.dueToday || 0),
            due7Count: Number(nextActions.due7 || 0),
          },
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to send scheduled summary.");
      const sentAt = new Date().toISOString();
      setScheduleConfig((prev) => ({ ...prev, lastSentAt: sentAt }));
      const sendInfo = { to, cc: cc || undefined, at: sentAt };
      setLastSummaryEmailInfo(sendInfo);
      window.localStorage.setItem("supplierPayments.lastSummaryEmail.v1", JSON.stringify(sendInfo));
      toast.success("Scheduled summary sent.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send scheduled summary.");
    }
  };
  const sendCronTestNow = async () => {
    if (!canManageSupplierPayments) {
      toast.error("Only admins can run cron test sends.");
      return;
    }
    if (cronTestRemaining > 0) {
      toast.error(`Please wait ${cronTestRemaining}s before running test again.`);
      return;
    }
    setCronTestSubmitting(true);
    try {
      const res = await fetch("/api/admin/supplier-payables/summary/cron/test", {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to run cron test send.");
      const nowIso = new Date().toISOString();
      setLastCronTestAt(nowIso);
      window.localStorage.setItem(CRON_TEST_LAST_SENT_KEY, nowIso);
      toast.success(payload?.simulated ? "Cron test send simulated." : "Cron test send completed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to run cron test send.");
    } finally {
      setCronTestSubmitting(false);
    }
  };
  const submitSendSummaryEmail = async () => {
    const to = emailTo.trim();
    const cc = emailCc.trim();
    if (!to) {
      setEmailError("Recipient email is required.");
      return;
    }
    if (!emailSubject.trim()) {
      setEmailError("Subject is required.");
      return;
    }
    if (!emailBody.trim()) {
      setEmailError("Summary body is required.");
      return;
    }
    setEmailSubmitting(true);
    setEmailError("");
    try {
      const res = await fetch("/api/admin/supplier-payments/email-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: SUPPLIER_PAYMENTS_SOURCE_PAGE,
          to,
          cc: cc || undefined,
          subject: emailSubject.trim(),
          text: emailBody,
          scopeSnapshot: {
            scope: exposureView === "received" ? "received-ap-only" : "full-exposure",
            basis: summaryBasis,
            statusFilter: status === "all" ? "all-statuses" : status,
            monthFilter: month || "all-months",
            agingFilter,
          },
          summarySnapshot: {
            openExposure: Number(selectedOutstanding || 0),
            receivedApOutstanding: Number(receivedApOutstanding || 0),
            orderedNotReceivedExposure: Number(orderedNotReceivedExposure || 0),
            overdueCount: Number(nextActions.overdue || 0),
            dueTodayCount: Number(nextActions.dueToday || 0),
            due7Count: Number(nextActions.due7 || 0),
          },
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to send summary email.");
      const now = new Date().toISOString();
      const nextRecipients = [
        ...savedRecipients.filter((item) => item.email.toLowerCase() !== to.toLowerCase()),
        { email: to },
      ].slice(-8);
      setSavedRecipients(nextRecipients);
      window.localStorage.setItem("supplierPayments.summaryRecipients.v1", JSON.stringify(nextRecipients));
      const sendInfo = { to, cc: cc || undefined, at: now };
      setLastSummaryEmailInfo(sendInfo);
      window.localStorage.setItem("supplierPayments.lastSummaryEmail.v1", JSON.stringify(sendInfo));
      if (scheduleConfig.enabled && scheduleConfig.to?.trim().toLowerCase() === to.toLowerCase()) {
        setScheduleConfig((prev) => ({ ...prev, lastSentAt: now }));
      }
      setEmailOpen(false);
      toast.success("Summary email sent.");
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "Failed to send summary email.");
    } finally {
      setEmailSubmitting(false);
    }
  };
  const applySavedRecipient = (email: string) => {
    setEmailTo(email);
    setEmailError("");
  };
  const removeSavedRecipient = (email: string) => {
    const next = savedRecipients.filter((item) => item.email.toLowerCase() !== email.toLowerCase());
    setSavedRecipients(next);
    window.localStorage.setItem("supplierPayments.summaryRecipients.v1", JSON.stringify(next));
  };

  const exportCurrentViewSummaryPdf = async () => {
    try {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const pageRef = pdf.addPage([595, 842]); // A4 portrait
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const margin = 40;
      let y = 800;
      const line = 18;
      const money = (value: number) =>
        `GHS ${Number(value || 0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
    const scopeLabel = exposureView === "received" ? "Received AP only" : "Full exposure";
    const basisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
      const statusLabel = status === "all" ? "All statuses" : status;
      const monthLabel = month || "All months";
      const agingLabel =
        agingFilter === "all"
          ? "All aging"
          : agingFilter === "due_today"
            ? "Due today"
            : agingFilter === "due_7"
              ? "Due in 7 days"
              : agingFilter === "overdue"
                ? "Overdue"
                : agingFilter.replace("_", "-").replace("plus", "+");
      const rowsData: Array<[string, string]> = [
        ["Scope", scopeLabel],
        ["Summary basis", basisLabel],
        ["Status filter", statusLabel],
        ["Month filter", monthLabel],
        ["Aging filter", agingLabel],
        ["Rows in view", String(rows.length)],
        ["Total amount", money(totalAmount)],
        ["Paid", money(totalPaid)],
        ["Pending payment approvals", money(totalPendingPaymentApprovals)],
        ["Pending purchase approvals", money(totalPendingPurchaseApprovals)],
        ["Supplier credits", money(totalCredits)],
        ["Refunds received", money(totalRefunds)],
        ["Credit balance", money(totalCreditBalance)],
        ["Outstanding (selected basis)", money(selectedOutstanding)],
        ["Received AP outstanding", money(receivedApOutstanding)],
        ["Ordered not received exposure", money(orderedNotReceivedExposure)],
        ["Aging 0-30 days", money(agingBuckets["0_30"])],
        ["Aging 31-60 days", money(agingBuckets["31_60"])],
        ["Aging 61-90 days", money(agingBuckets["61_90"])],
        ["Aging 90+ days", money(agingBuckets["90_plus"])],
        ["Reconciliation net payable", money(reconciliationTarget)],
        ["Reconciliation delta", money(reconciliationDelta)],
      ];

      pageRef.drawText("Supplier Payables - Summary Snapshot", { x: margin, y, size: 16, font: bold });
      y -= 24;
      pageRef.drawText(`Generated: ${new Date().toLocaleString()}`, { x: margin, y, size: 10, font });
      y -= 20;

      for (const [label, value] of rowsData) {
        if (y < 60) break;
        pageRef.drawText(label, { x: margin, y, size: 10, font: bold });
        pageRef.drawText(value, { x: 280, y, size: 10, font });
        y -= line;
      }

      const bytes = await pdf.save();
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      const statusPart = status === "all" ? "all-statuses" : status.toLowerCase();
      const monthPart = month || "all-months";
      const scopePart = exposureView === "received" ? "received-ap-only" : "full-exposure";
      const basisPart = summaryBasis === "ledger_ap" ? "ledger-ap" : "operational";
      const filename = `supplier_payables_summary_${scopePart}_${basisPart}_${statusPart}_${monthPart}_p${page}.pdf`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await logExportAudit({
        action: "SUPPLIER_PAYABLES_EXPORT_SUMMARY_PDF",
        format: "PDF",
        fileName: filename,
        rowCount: rowsData.length,
        columnCount: 2,
        byteSize: blob.size,
        exportLabel: "Summary PDF",
      });
      toast.success("Summary PDF downloaded.");
    } catch (error) {
      console.error("Supplier-payments summary PDF export failed", error);
      toast.error("Failed to generate summary PDF.");
    }
  };
  const exportCurrentViewPdf = async () => {
    if (!rows.length) {
      toast.error("No rows in current view to export.");
      return;
    }
    try {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const mono = await pdf.embedFont(StandardFonts.Courier);

      const pageSize: [number, number] = [842, 595]; // A4 landscape points
      const margin = 28;
      const lineH = 12;
      const columns = [
        { key: "date", label: "Date", w: 54, align: "center" as const },
        { key: "supplier", label: "Supplier", w: 76, align: "center" as const },
        { key: "product", label: "Product", w: 88, align: "center" as const },
        { key: "sku", label: "SKU", w: 52, align: "center" as const },
        { key: "qty", label: "Qty", w: 32, align: "center" as const },
        { key: "unitCost", label: "Unit Cost", w: 56, align: "center" as const },
        { key: "total", label: "Total", w: 58, align: "center" as const },
        { key: "paid", label: "Paid", w: 58, align: "center" as const },
        { key: "outstanding", label: "Outstanding", w: 66, align: "center" as const },
        { key: "op", label: "Operational", w: 90, align: "center" as const },
        { key: "pay", label: "Payment", w: 54, align: "center" as const },
        { key: "expected", label: "Expected", w: 40, align: "center" as const },
      ] as const;

      const formatMoney = (value: number) =>
        `GHS ${Number(value || 0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;

      const fitText = (
        raw: string,
        maxWidth: number,
        useBold = false,
        useMono = false,
        size = 7.4,
      ) => {
        const fontToUse = useMono ? mono : useBold ? bold : font;
        const text = String(raw ?? "");
        if (!text) return "";
        if (fontToUse.widthOfTextAtSize(text, size) <= maxWidth) return text;
        let out = text;
        while (out.length > 1 && fontToUse.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
          out = out.slice(0, -1);
        }
        return `${out}...`;
      };

      const drawCell = (
        pageRef: import("pdf-lib").PDFPage,
        value: string,
        x: number,
        yPos: number,
        width: number,
        align: "left" | "right" | "center",
        opts?: { bold?: boolean; mono?: boolean; size?: number },
      ) => {
        const size = opts?.size ?? 7.4;
        const boldText = opts?.bold ?? false;
        const monoText = opts?.mono ?? false;
        const fontToUse = monoText ? mono : boldText ? bold : font;
        const text = fitText(value, width - 4, boldText, monoText, size);
        const textWidth = fontToUse.widthOfTextAtSize(text, size);
        const drawX =
          align === "right"
            ? x + width - textWidth - 2
            : align === "center"
              ? x + (width - textWidth) / 2
              : x + 2;
        pageRef.drawText(text, { x: drawX, y: yPos, size, font: fontToUse });
      };

      const summary = {
        rows: rows.length,
        total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
        paid: rows.reduce((sum, row) => sum + Number(row.paidAmount || 0), 0),
        outstanding: selectedOutstanding,
        receivedAP: rows
          .filter((row) => row.status === "RECEIVED" || row.status === "PARTIALLY_RECEIVED")
          .reduce((sum, row) => sum + Number(row.outstanding || 0), 0),
      };

      const drawHeader = (pageRef: import("pdf-lib").PDFPage, y: number) => {
        const scopeLabel = exposureView === "received" ? "Received AP only" : "Full exposure";
        const basisLabel = summaryBasis === "ledger_ap" ? "Ledger AP basis" : "Operational exposure";
        pageRef.drawText("Supplier Payables - Current View", {
          x: margin,
          y,
          size: 12,
          font: bold,
        });
        pageRef.drawText(
          `Scope: ${scopeLabel} | Basis: ${basisLabel} | Status: ${status === "all" ? "All statuses" : status} | Month: ${
            month || "All months"
          } | Sort: ${sortMode} | Generated: ${new Date().toLocaleString()}`,
          { x: margin, y: y - 15, size: 8.5, font },
        );
        pageRef.drawText(
          `Rows: ${summary.rows} | Total: ${formatMoney(summary.total)} | Paid: ${formatMoney(
            summary.paid,
          )} | Outstanding: ${formatMoney(summary.outstanding)} | Received AP: ${formatMoney(
            summary.receivedAP,
          )}`,
          { x: margin, y: y - 28, size: 8, font: bold },
        );
        let x = margin;
        const headerY = y - 44;
        for (const col of columns) {
          drawCell(pageRef, col.label, x, headerY, col.w, "center", { bold: true, size: 8 });
          x += col.w;
        }
        pageRef.drawLine({
          start: { x: margin, y: headerY - 2 },
          end: { x: pageSize[0] - margin, y: headerY - 2 },
          thickness: 0.7,
        });
        return headerY - 12;
      };

      let pdfPage = pdf.addPage(pageSize);
      let y = drawHeader(pdfPage, pageSize[1] - margin);

      for (const row of rows) {
        if (y < margin + 14) {
          pdfPage = pdf.addPage(pageSize);
          y = drawHeader(pdfPage, pageSize[1] - margin);
        }
        const values = [
          new Date(row.createdAt).toLocaleDateString("en-GB"),
          row.supplier || "-",
          row.product?.name || "Unknown",
          row.product?.sku || "-",
          String(row.quantity),
          formatMoney(row.unitCost),
          formatMoney(row.total),
          formatMoney(row.paidAmount),
          formatMoney(row.outstanding),
          operationalStatus(row),
          humanPaymentStatus(row.paymentStatus),
          row.expectedAt ? new Date(row.expectedAt).toLocaleDateString("en-GB") : "-",
        ];
        let x = margin;
        values.forEach((value, idx) => {
          const col = columns[idx]!;
          drawCell(pdfPage, value, x, y, col.w, col.align, {
            mono: col.key === "sku",
          });
          x += col.w;
        });
        y -= lineH;
      }

      const bytes = await pdf.save();
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
      const scopePart = exposureView === "received" ? "received-ap-only" : "full-exposure";
      const basisPart = summaryBasis === "ledger_ap" ? "ledger-ap" : "operational";
      const statusPart = status === "all" ? "all-statuses" : status.toLowerCase();
      const monthPart = month || "all-months";
      const filename = `supplier_payables_${scopePart}_${basisPart}_${statusPart}_${monthPart}_p${page}.pdf`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await logExportAudit({
        action: "SUPPLIER_PAYABLES_EXPORT_CURRENT_VIEW_PDF",
        format: "PDF",
        fileName: filename,
        rowCount: rows.length,
        columnCount: columns.length,
        byteSize: blob.size,
        exportLabel: "Current view PDF",
      });
      toast.success("PDF downloaded.");
    } catch (error) {
      console.error("Supplier-payments PDF export failed", error);
      toast.error("Failed to generate PDF.");
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Supplier Payments</h1>
          <p className="text-sm text-muted-foreground">
            Accounts payable view built from purchase orders (payments are assumed on receipt).
          </p>
          {fromAgingHub ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-800">
                Applied from Aging Hub
              </span>
              {outstandingOnly ? (
                <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  Outstanding only
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex w-full sm:w-auto flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/purchases">Purchases</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={buildApAgingHref()}>AP Aging</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={SUPPLIER_PAYMENTS_AUDIT_HREF}>Open audit log</Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Export ▾
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={exportCurrentViewCsv} disabled={rows.length === 0}>
                Current view — CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportCurrentViewPdf} disabled={rows.length === 0}>
                Current view — PDF
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportCurrentViewSummaryCsv}>
                Summary snapshot — CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportCurrentViewSummaryPdf}>
                Summary snapshot — PDF
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {canManageSupplierPayments ? (
                <DropdownMenuItem onClick={exportBundleZip} disabled={rows.length === 0}>
                Full bundle — ZIP
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={exportEmailSummaryTemplate}>
                Email summary template — TXT
              </DropdownMenuItem>
              {canBulkPay ? (
                <DropdownMenuItem
                  onClick={() => {
                    const params = new URLSearchParams();
                    if (bulkSupplierId) params.set("supplierId", bulkSupplierId);
                    else if (bulkSupplierName) params.set("supplier", bulkSupplierName);
                    params.set("sourcePage", SUPPLIER_PAYMENTS_SOURCE_PAGE);
                    window.open(`/api/admin/supplier-payments/statement?${params.toString()}`, "_blank");
                  }}
                >
                  Supplier statement — CSV
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {canManageSupplierPayments ? (
            <Button variant="outline" size="sm" onClick={openSendSummaryEmail}>
              Send summary email
            </Button>
          ) : null}
          {canRefund ? (
            <Button variant="outline" size="sm" onClick={openRefundDialog}>
              Record refund
            </Button>
          ) : null}
          {canBulkPay ? (
            <Button variant="default" size="sm" onClick={openBulkDialog}>
              Pay supplier balance
            </Button>
          ) : null}
        </div>
      </div>
      {canManageSupplierPayments && totalCreditBalance > 0.01 && !canRefund ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Supplier refunds are supplier-level actions. To record one safely, keep a single supplier selected and clear month, status, aging, and exposure filters.
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              value={supplierId || "ALL"}
              onValueChange={(v) => {
                setSupplierId(v === "ALL" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="All suppliers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All suppliers</SelectItem>
                {supplierOptions.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search by product"
            />
            <Input
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
              placeholder="All months"
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Purchase status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="PENDING_APPROVAL">Pending approval</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="ORDERED">Ordered</SelectItem>
                <SelectItem value="PARTIALLY_RECEIVED">Partially received</SelectItem>
                <SelectItem value="RECEIVED">Received</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Sort order" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Sort: Newest first</SelectItem>
                <SelectItem value="oldest">Sort: Oldest first</SelectItem>
                <SelectItem value="amount_desc">Sort: Amount high to low</SelectItem>
                <SelectItem value="amount_asc">Sort: Amount low to high</SelectItem>
              </SelectContent>
            </Select>
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>Summary basis</span>
                <span className="cursor-help underline decoration-dotted" title={summaryBasisHelp}>
                  ?
                </span>
              </div>
              <Select value={summaryBasis} onValueChange={(v) => setSummaryBasis(v as SummaryBasis)}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Summary basis" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="operational">Basis: Operational exposure</SelectItem>
                  <SelectItem value="ledger_ap">Basis: Ledger AP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Rows" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 rows</SelectItem>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex flex-wrap items-center gap-4 sm:col-span-2 lg:col-span-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={strictDate}
                  onChange={(e) => {
                    setStrictDate(e.target.checked);
                    setPage(1);
                  }}
                />
                Only include payments/credits within date filter
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={outstandingOnly}
                  onChange={(e) => {
                    setOutstandingOnly(e.target.checked);
                    setPage(1);
                  }}
                />
                Outstanding only
              </label>
            </div>
            <Button className="w-full sm:w-auto lg:justify-self-end" variant="outline" onClick={resetFilters}>
              Clear filters
            </Button>
          </div>
          {lastSummaryEmailInfo ? (
            <div className="rounded-md border bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
              Last summary email sent:{" "}
              <span className="font-medium text-foreground">{lastSummaryEmailInfo.to}</span>
              {lastSummaryEmailInfo.cc ? (
                <>
                  {" "}
                  | CC: <span className="font-medium text-foreground">{lastSummaryEmailInfo.cc}</span>
                </>
              ) : null}{" "}
              | {new Date(lastSummaryEmailInfo.at).toLocaleString()}
            </div>
          ) : null}
          <div className="rounded-md border bg-muted/10 p-3 space-y-2">
            <div className="text-xs text-muted-foreground">Saved filter presets</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name"
              />
              <Select value={selectedPresetName || "NONE"} onValueChange={(v) => setSelectedPresetName(v === "NONE" ? "" : v)}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Select preset</SelectItem>
                  {savedPresets.map((preset) => (
                    <SelectItem key={preset.name} value={preset.name}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={applySelectedPreset}>
                Apply preset
              </Button>
              <div className="flex gap-2">
                <Button className="flex-1" variant="outline" onClick={saveCurrentPreset}>
                  Save current
                </Button>
                <Button className="flex-1" variant="outline" onClick={deleteSelectedPreset}>
                  Delete
                </Button>
              </div>
            </div>
          </div>
          <div className="rounded-md border border-dashed bg-muted/5 px-3 py-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Basis guide:</span>{" "}
            <span className="cursor-help underline decoration-dotted" title={summaryBasisOperationalHelp}>
              Operational exposure
            </span>{" "}
            for execution,{" "}
            <span className="cursor-help underline decoration-dotted" title={summaryBasisLedgerHelp}>
              Ledger AP
            </span>{" "}
            for accounting.{" "}
            <span className="cursor-help underline decoration-dotted" title={summaryBasisCadenceHelp}>
              Check deviation regularly.
            </span>
          </div>
          <div className="hidden lg:flex sticky top-20 z-20 items-center gap-3 rounded-md border bg-background/95 px-3 py-2 text-xs backdrop-blur">
            <span className="text-muted-foreground">Quick view:</span>
            <span>
              Basis: <strong>{selectedBasisLabel}</strong>
            </span>
            <span>
              Outstanding: <strong>{formatCurrency(selectedOutstanding)}</strong>
            </span>
            <span>
              Received AP: <strong>{formatCurrency(receivedApOutstanding)}</strong>
            </span>
            <span>
              Filter:{" "}
              <strong>
                {agingFilter === "all"
                  ? "All"
                  : agingFilter === "due_today"
                    ? "Due today"
                    : agingFilter === "due_7"
                      ? "Due in 7 days"
                      : agingFilter === "overdue"
                        ? "Overdue"
                        : agingFilter.replace("_", "-").replace("plus", "+")}
              </strong>
            </span>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="mb-2 text-xs text-muted-foreground">Next actions</div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button
                size="sm"
                variant={agingFilter === "overdue" ? "default" : "outline"}
                onClick={() => {
                  setAgingFilter("overdue");
                  setPage(1);
                }}
              >
                Overdue ({nextActions.overdue})
              </Button>
              <Button
                size="sm"
                variant={agingFilter === "due_today" ? "default" : "outline"}
                onClick={() => {
                  setAgingFilter("due_today");
                  setPage(1);
                }}
              >
                Due today ({nextActions.dueToday})
              </Button>
              <Button
                size="sm"
                variant={agingFilter === "due_7" ? "default" : "outline"}
                onClick={() => {
                  setAgingFilter("due_7");
                  setPage(1);
                }}
              >
                Due in 7 days ({nextActions.due7})
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Total: {total}</span>
            <span>|</span>
            <span>Total amount: {formatCurrency(totalAmount)}</span>
            <span>|</span>
            <span>Paid: {formatCurrency(totalPaid)}</span>
            <span>|</span>
            <span>Pending payment approvals: {formatCurrency(totalPendingPaymentApprovals)}</span>
            <span>|</span>
            <span>Pending purchase approvals: {formatCurrency(totalPendingPurchaseApprovals)}</span>
            <span>|</span>
            <span>Supplier credits: {formatCurrency(totalCredits)}</span>
            <span>|</span>
            <span>Refunds received: {formatCurrency(totalRefunds)}</span>
            <span>|</span>
            <span>Credit balance: {formatCurrency(totalCreditBalance)}</span>
            <span>|</span>
            <span>Outstanding ({selectedBasisLabel}): {formatCurrency(selectedOutstanding)}</span>
            {selectedOutstanding > 0.01 ? (
              <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                You owe supplier
              </span>
            ) : totalCreditBalance > 0.01 ? (
              <span className="ml-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                Supplier owes you
              </span>
            ) : (
              <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                Settled
              </span>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Outstanding ({selectedBasisLabel})</div>
              <div className="font-medium">{formatCurrency(selectedOutstanding)}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Received AP Outstanding</div>
              <div className="font-medium">{formatCurrency(receivedApOutstanding)}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Ordered not received exposure</div>
              <div className="font-medium">{formatCurrency(orderedNotReceivedExposure)}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Aging 0–30 days</div>
              <div className="font-medium">{formatCurrency(agingBuckets["0_30"])}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Aging 31–60 days</div>
              <div className="font-medium">{formatCurrency(agingBuckets["31_60"])}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Aging 61–90 days</div>
              <div className="font-medium">{formatCurrency(agingBuckets["61_90"])}</div>
            </div>
            <div className="rounded-md border bg-muted/10 px-3 py-2">
              <div className="text-muted-foreground">Aging 90+ days</div>
              <div className="font-medium">{formatCurrency(agingBuckets["90_plus"])}</div>
            </div>
          </div>
          <div className="rounded-md border bg-muted/10 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">Supplier-specific aging mini-chart</div>
              <div className="w-full max-w-[260px]">
                <Select value={chartSupplierKey || "NONE"} onValueChange={(v) => setChartSupplierKey(v === "NONE" ? "" : v)}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">Select supplier</SelectItem>
                    {supplierChartOptions.map((option) => (
                      <SelectItem key={option.key} value={option.key}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {supplierAgingChart.total > 0.01 ? (
              <div className="space-y-2">
                <div className="text-xs">
                  <span className="text-muted-foreground">Supplier: </span>
                  <span className="font-medium">{supplierAgingChart.label}</span>
                  <span className="text-muted-foreground"> | Total: </span>
                  <span className="font-medium">{formatCurrency(supplierAgingChart.total)}</span>
                </div>
                {([
                  ["0-30", supplierAgingChart.totals["0_30"], "bg-emerald-500"],
                  ["31-60", supplierAgingChart.totals["31_60"], "bg-amber-500"],
                  ["61-90", supplierAgingChart.totals["61_90"], "bg-orange-500"],
                  ["90+", supplierAgingChart.totals["90_plus"], "bg-rose-500"],
                ] as Array<[string, number, string]>).map(([label, value, tone]) => (
                  <div key={label} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span>{label}</span>
                      <span className="font-medium">{formatCurrency(value)}</span>
                    </div>
                    <div className="h-2 rounded bg-muted/40 overflow-hidden">
                      <div
                        className={`h-2 ${tone}`}
                        style={{
                          width: `${
                            supplierAgingChart.max > 0 && value > 0
                              ? Math.max(4, (value / supplierAgingChart.max) * 100)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                No outstanding balance rows for the selected supplier in the current scope.
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">View scope:</span>
            <Button
              size="sm"
              variant={exposureView === "received" ? "default" : "outline"}
              onClick={() => {
                setExposureView("received");
                setPage(1);
              }}
            >
              Received AP only
            </Button>
            <Button
              size="sm"
              variant={exposureView === "full" ? "default" : "outline"}
              onClick={() => {
                setExposureView("full");
                setPage(1);
              }}
            >
              Full exposure
            </Button>
            <span className="ml-2 text-muted-foreground">Aging:</span>
            <Button
              size="sm"
              variant={agingFilter === "all" ? "default" : "outline"}
              onClick={() => {
                setAgingFilter("all");
                setPage(1);
              }}
            >
              All
            </Button>
            <Button
              size="sm"
              variant={agingFilter === "0_30" ? "default" : "outline"}
              onClick={() => {
                setAgingFilter("0_30");
                setPage(1);
              }}
            >
              0–30d
            </Button>
            <Button
              size="sm"
              variant={agingFilter === "31_60" ? "default" : "outline"}
              onClick={() => {
                setAgingFilter("31_60");
                setPage(1);
              }}
            >
              31–60d
            </Button>
            <Button
              size="sm"
              variant={agingFilter === "61_90" ? "default" : "outline"}
              onClick={() => {
                setAgingFilter("61_90");
                setPage(1);
              }}
            >
              61–90d
            </Button>
            <Button
              size="sm"
              variant={agingFilter === "90_plus" ? "default" : "outline"}
              onClick={() => {
                setAgingFilter("90_plus");
                setPage(1);
              }}
            >
              90d+
            </Button>
          </div>
          <div className="mt-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span>Reconciliation:</span>
              <span>
                {formatCurrency(totalAmount)} - {formatCurrency(totalPaid)} - {formatCurrency(totalCredits)} +{" "}
                {formatCurrency(totalRefunds)} = {formatCurrency(reconciliationTarget)}
              </span>
            </div>
            <div className="mt-1">
              Summary basis: <span className="font-medium">{selectedBasisLabel}</span>
            </div>
            <div className="mt-1 text-[11px]">
              <span className="font-medium">How to use:</span>{" "}
              Compare basis views; if delta persists after posting cycles, investigate missing receipts/payments, status mismatches, or date-filter scope.
            </div>
            <div className="mt-1">
              AP aging includes received liabilities only. Ordered/not-received exposure is shown separately above.
            </div>
            {!supplierId && !q.trim() ? (
              <div className="mt-1">
                Credits are supplier-specific and are not applied across different suppliers in the All view.
              </div>
            ) : null}
            {creditExcess > 0.01 ? (
              <div className="mt-1 text-emerald-700">
                Excess credits: {formatCurrency(creditExcess)} (carried forward).
              </div>
            ) : null}
            {Math.abs(reconciliationDelta) > 0.01 ? (
              <div className="mt-1">
                <span className="text-amber-600">
                  Difference: {formatCurrency(reconciliationDelta)}
                </span>{" "}
                <span>
                  (usually credits/refunds outside the filtered month or credits not tied to a purchase)
                </span>
              </div>
            ) : (
              <div className="mt-1 text-emerald-600">Summary matches outstanding.</div>
            )}
            {deviationSeverity !== "none" ? (
              <div
                className={`mt-2 rounded border px-2 py-1 text-[11px] ${
                  deviationSeverity === "critical"
                    ? "border-rose-300 bg-rose-50 text-rose-800"
                    : "border-amber-300 bg-amber-50 text-amber-800"
                }`}
              >
                {deviationSeverity === "critical" ? "Critical" : "Warning"} deviation threshold exceeded:{" "}
                {formatCurrency(deltaAbsolute)} ({deltaPct.toFixed(2)}%).
              </div>
            ) : null}
            {hasScopeBoundaryMismatch ? (
              <div className="mt-1 text-[11px] text-amber-700">
                Scope note: summary and table may differ when date/status filters exclude credits, refunds, or pending rows.
              </div>
            ) : null}
            <div className="mt-3 border-t pt-2">
              <div className="mb-1 text-[11px] font-medium text-foreground">Deviation alert thresholds</div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">Alert if absolute delta ≥ (GHS)</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={deviationAbsThreshold}
                    onChange={(e) => setDeviationAbsThreshold(e.target.value)}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">Alert if percent delta ≥ (%)</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={deviationPctThreshold}
                    onChange={(e) => setDeviationPctThreshold(e.target.value)}
                    className="h-7 text-xs"
                  />
                </div>
                <div className="text-[11px] text-muted-foreground flex items-end pb-1">
                  Current: {formatCurrency(deltaAbsolute)} ({deltaPct.toFixed(2)}%)
                </div>
              </div>
            </div>
            <details className="mt-2 rounded border bg-background/70 p-2 text-[11px]">
              <summary className="cursor-pointer font-medium">Why this difference? (drilldown)</summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                <div>
                  Ordered not received exposure: <span className="font-medium text-foreground">{formatCurrency(orderedNotReceivedExposure)}</span>
                </div>
                <div>
                  Pending purchase approvals: <span className="font-medium text-foreground">{formatCurrency(totalPendingPurchaseApprovals)}</span>
                </div>
                <div>
                  Pending payment approvals: <span className="font-medium text-foreground">{formatCurrency(totalPendingPaymentApprovals)}</span>
                </div>
                <div>
                  Supplier credits: <span className="font-medium text-foreground">{formatCurrency(totalCredits)}</span>
                </div>
                <div>
                  Refunds received: <span className="font-medium text-foreground">{formatCurrency(totalRefunds)}</span>
                </div>
                <div>
                  Strict date filter: <span className="font-medium text-foreground">{strictDate ? "On" : "Off"}</span>
                </div>
              </div>
            </details>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Summary email schedule</CardTitle>
            {isScheduleDue ? (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
                Send due
              </span>
            ) : scheduleConfig.enabled ? (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
                Scheduled
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Configure a reminder schedule for the supplier payables summary email.{" "}
            <span className="font-medium text-foreground">
              Note: this is a manual-send reminder — the page will show a &quot;Send due&quot; badge when it is time. For fully automatic delivery, set up a server-side cron job that calls the summary send endpoint.
            </span>
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              value={scheduleConfig.frequency}
              onValueChange={(v) =>
                setScheduleConfig((prev) => ({
                  ...prev,
                  frequency: v as SummaryScheduleFrequency,
                  enabled: v !== "OFF",
                }))
              }
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF">Off</SelectItem>
                <SelectItem value="DAILY">Daily reminder</SelectItem>
                <SelectItem value="WEEKLY">Weekly reminder</SelectItem>
              </SelectContent>
            </Select>
            {scheduleConfig.frequency === "WEEKLY" ? (
              <Select
                value={String(scheduleConfig.weekday ?? 1)}
                onValueChange={(v) => setScheduleConfig((prev) => ({ ...prev, weekday: Number(v) }))}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Weekday" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Monday</SelectItem>
                  <SelectItem value="2">Tuesday</SelectItem>
                  <SelectItem value="3">Wednesday</SelectItem>
                  <SelectItem value="4">Thursday</SelectItem>
                  <SelectItem value="5">Friday</SelectItem>
                  <SelectItem value="6">Saturday</SelectItem>
                  <SelectItem value="0">Sunday</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div />
            )}
            <Input
              type="email"
              placeholder="To email"
              value={scheduleConfig.to || ""}
              onChange={(e) => setScheduleConfig((prev) => ({ ...prev, to: e.target.value }))}
            />
            <Input
              type="email"
              placeholder="CC (optional)"
              value={scheduleConfig.cc || ""}
              onChange={(e) => setScheduleConfig((prev) => ({ ...prev, cc: e.target.value }))}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              placeholder="Subject prefix"
              value={scheduleConfig.subjectPrefix || ""}
              onChange={(e) => setScheduleConfig((prev) => ({ ...prev, subjectPrefix: e.target.value }))}
            />
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <span>
                {scheduleConfig.lastSentAt
                  ? `Last sent: ${new Date(scheduleConfig.lastSentAt).toLocaleString()}`
                  : "No scheduled send yet."}
              </span>
              <span>|</span>
              <span>
                {lastCronTestAt
                  ? `Last test run: ${new Date(lastCronTestAt).toLocaleString()}`
                  : "No test run yet."}
              </span>
            </div>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={sendScheduledSummaryNow} disabled={!canManageSupplierPayments}>
                Send now
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={sendCronTestNow}
                disabled={cronTestSubmitting || !canManageSupplierPayments || cronTestRemaining > 0}
              >
                {cronTestSubmitting
                  ? "Running..."
                  : cronTestRemaining > 0
                    ? `Wait ${cronTestRemaining}s`
                    : "Test cron send"}
              </Button>
            </div>
          </div>
          <div className="rounded-md border bg-muted/10 p-2 text-[11px] text-muted-foreground space-y-1">
            <div>
              <span className="font-medium text-foreground">Cron test behavior:</span> Test cron send uses server env recipients (not the fields above).
            </div>
            <div>
              To:{" "}
              {cronRecipientPreview.to.length
                ? cronRecipientPreview.to.join(", ")
                : "Not configured (set SUPPLIER_PAYABLES_SUMMARY_TO)"}
            </div>
            {cronRecipientPreview.cc.length ? (
              <div>CC: {cronRecipientPreview.cc.join(", ")}</div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Send supplier payables summary</DialogTitle>
            <DialogDescription>
              Review the recipients and message before sending a scoped supplier payables summary.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <label className="text-xs text-muted-foreground">To *</label>
              <Input
                type="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="finance@example.com"
              />
            </div>
            {savedRecipients.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Quick recipients</div>
                <div className="flex flex-wrap gap-2">
                  {savedRecipients.map((item) => (
                    <div key={item.email} className="inline-flex items-center rounded-full border bg-muted/30 pl-2 pr-1 py-1 text-xs">
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        onClick={() => applySavedRecipient(item.email)}
                      >
                        {item.label || item.email}
                      </button>
                      <button
                        type="button"
                        className="ml-1 rounded px-1 text-muted-foreground hover:bg-muted"
                        onClick={() => removeSavedRecipient(item.email)}
                        aria-label={`Remove ${item.email}`}
                        title="Remove"
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <label className="text-xs text-muted-foreground">CC (optional)</label>
              <Input
                type="email"
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
                placeholder="manager@example.com"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Subject *</label>
              <Input
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Message *</label>
              <textarea
                className="w-full min-h-[260px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
              />
            </div>
            {emailError ? <p className="text-xs text-red-600">{emailError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailOpen(false)} disabled={emailSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitSendSummaryEmail} disabled={emailSubmitting}>
              {emailSubmitting ? "Sending..." : "Send email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pending Purchase Approvals</CardTitle>
        </CardHeader>
        <CardContent>
          {pendingPurchaseApprovals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending purchase approvals.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Created</th>
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Qty</th>
                    <th className="py-2 pr-3 text-right">Unit Cost</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="py-2 pr-3">Expected</th>
                    <th className="py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPurchaseApprovals.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="py-2 pr-3">{new Date(p.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-3">{p.supplier}</td>
                      <td className="py-2 pr-3">
                        {p.product?.name || "Unknown"}
                        {p.product?.sku ? ` - ${p.product.sku}` : ""}
                      </td>
                      <td className="py-2 pr-3 text-right">{p.quantity}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(p.unitCost)}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(p.total)}</td>
                      <td className="py-2 pr-3">
                        {p.expectedAt ? new Date(p.expectedAt).toLocaleDateString() : "-"}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openApprovePurchaseConfirm(p)}
                            disabled={!canManageSupplierPayments}
                          >
                            Approve purchase
                          </Button>
                          <Link className="underline text-xs" href={`/admin/purchases?purchaseId=${p.id}`}>
                            View
                          </Link>
                          <Link
                            className="underline text-xs"
                            href={`/admin/audit?entityType=PURCHASE&entityId=${encodeURIComponent(p.id)}&sourcePage=admin%2Fsupplier-payments`}
                          >
                            Audit
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pending payment approvals</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            These are supplier payments waiting for approval (not purchase approvals).
          </p>
          {pendingPayments.length === 0 ? (
            <div className="text-muted-foreground">No pending supplier payments.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">Purchase</th>
                    <th className="py-2 pr-3">Amount</th>
                    <th className="py-2 pr-3">Method</th>
                    <th className="py-2 pr-3">Reference</th>
                    <th className="py-2 pr-3">Proof</th>
                    <th className="py-2 pr-3">Created</th>
                    <th className="py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPayments.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-b last:border-0 ${focusedPaymentId && focusedPaymentId === p.id ? "bg-amber-50" : ""}`}
                    >
                      <td className="py-2 pr-3">{p.supplier?.name || "Unknown"}</td>
                      <td className="py-2 pr-3">
                        {p.purchase?.id ? (
                          <a
                            className="underline"
                            href={`/admin/purchases?purchaseId=${p.purchase.id}`}
                          >
                            {p.purchase.product?.name || p.purchase.id.slice(0, 8)}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-2 pr-3">{formatCurrency(p.amount)}</td>
                      <td className="py-2 pr-3">{p.method || "-"}</td>
                      <td className="py-2 pr-3">{p.reference || "-"}</td>
                      <td className="py-2 pr-3">
                        {p.proofUrl ? (
                          <a className="underline" href={p.proofUrl} target="_blank" rel="noreferrer">
                            View
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-2 pr-3">{new Date(p.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-3">
                        {canManageSupplierPayments ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => openApprovePaymentConfirm(p)}>
                              Approve
                            </Button>
                            <Link
                              className="underline text-xs"
                              href={`/admin/audit?entityType=SUPPLIER_PAYMENT&entityId=${encodeURIComponent(p.id)}&sourcePage=admin%2Fsupplier-payments`}
                            >
                              Audit
                            </Link>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Admin only</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pay supplier balance</DialogTitle>
            <DialogDescription>
              Record a payment that will allocate only across the supplier purchases in the current scope.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Supplier</div>
              <div className="font-medium">{bulkSupplierName || "Supplier"}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total outstanding</div>
              <div className="font-medium">{formatCurrency(totalOutstanding)}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Scope rows: {scopedRows.length}. Payment will only allocate across the current supplier scope.
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Amount to pay</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bulkAmount}
                onChange={(e) => setBulkAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Method</label>
              <Select value={bulkMethod} onValueChange={setBulkMethod}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Reference</label>
              <Input
                value={bulkReference}
                onChange={(e) => setBulkReference(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Proof URL (optional)</label>
              <Input
                value={bulkProof}
                onChange={(e) => setBulkProof(e.target.value)}
                placeholder="https://..."
                type="url"
              />
              {bulkProof && !isValidUrl(bulkProof) ? (
                <p className="mt-0.5 text-[11px] text-red-600">Must be a valid http/https URL.</p>
              ) : null}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Note</label>
              <Input
                value={bulkNote}
                onChange={(e) => setBulkNote(e.target.value)}
              />
            </div>
            {bulkError ? <p className="text-xs text-red-600">{bulkError}</p> : null}
            <p className="text-xs text-muted-foreground">
              Payments will be applied to the oldest outstanding purchases first within the current supplier scope.
            </p>
            {bulkAllocations.length > 0 ? (
              <div className="rounded-md border p-3 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Allocation preview</div>
                <div className="space-y-1 text-xs">
                  {bulkAllocations.map((alloc) => (
                    <div key={alloc.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{alloc.label}</span>
                      <span className="font-medium">{formatCurrency(alloc.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitBulkPayment} disabled={bulkSubmitting}>
              {bulkSubmitting ? "Paying..." : "Submit payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record supplier refund</DialogTitle>
            <DialogDescription>
              Record cash or bank refunds received back from the currently scoped supplier credit balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              Use this when a supplier refunds part of your credit balance (cash or bank transfer).
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Amount</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Method</label>
              <Select value={refundMethod} onValueChange={setRefundMethod}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Reference (optional)</label>
              <Input value={refundReference} onChange={(e) => setRefundReference(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Note (optional)</label>
              <Input value={refundNote} onChange={(e) => setRefundNote(e.target.value)} />
            </div>
            {refundError ? (
              <p className="text-xs text-red-600">{refundError}</p>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRefundOpen(false)} disabled={refundSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitRefund} disabled={refundSubmitting}>
              Record refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Payables Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2" aria-label="Loading payables">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-8 flex-1" />
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-8 w-20" />
                </div>
              ))}
            </div>
          ) : error ? (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load supplier payments."}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No supplier payables found.</p>
          ) : (
            <>
              <div className="space-y-3 lg:hidden">
                {rows.map((row) => (
                  <div key={row.id} className={`rounded-md border p-3 text-sm space-y-2 ${rowUrgencyClass(row)}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {row.product?.name || "Unknown"}
                          {row.product?.sku ? ` - ${row.product.sku}` : ""}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.supplierId ? (
                            <Link
                              className="underline"
                              href={`/admin/suppliers?focus=${encodeURIComponent(row.supplierId)}`}
                            >
                              {row.supplier}
                            </Link>
                          ) : (
                            row.supplier
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Outstanding</div>
                        <div className="font-semibold">{formatCurrency(row.outstanding)}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <div className="text-muted-foreground">Date</div>
                        <div>{new Date(row.createdAt).toLocaleDateString()}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Expected</div>
                        <div className="flex items-center gap-2">
                          <span>{row.expectedAt ? new Date(row.expectedAt).toLocaleDateString() : "-"}</span>
                          {row.outstanding > 0.01 ? (
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass(
                                expectedStatus(row.expectedAt).tone,
                              )}`}
                            >
                              {expectedStatus(row.expectedAt).label}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Total</div>
                        <div>{formatCurrency(row.total)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground">Paid</div>
                        <div>{formatCurrency(row.paidAmount)}</div>
                      </div>
                    </div>
                    <div className="rounded-sm bg-muted/30 px-2 py-1 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 font-medium ${statusChipClass(
                            row.status === "PENDING_APPROVAL" ? "warn" : "info",
                          )}`}
                        >
                          {operationalStatus(row)}
                        </span>
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 font-medium ${statusChipClass(
                            paymentChipTone(row.paymentStatus),
                          )}`}
                        >
                          {humanPaymentStatus(row.paymentStatus)}
                        </span>
                      </div>
                    </div>
                    <div className="sticky bottom-0 -mx-3 mt-1 border-t bg-background px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link className="underline text-xs" href={`/admin/purchases?purchaseId=${row.id}`}>
                          View purchase
                        </Link>
                        <Link
                          className="underline text-xs"
                          href={`/admin/audit?entityType=PURCHASE&entityId=${encodeURIComponent(row.id)}&sourcePage=admin%2Fsupplier-payments`}
                        >
                          Audit
                        </Link>
                        {row.outstanding > 0.01 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openPaymentDialog(row)}
                            disabled={!canManageSupplierPayments || !paymentEligibleStatuses.has(row.status)}
                          >
                            Record payment
                          </Button>
                        ) : null}
                        {!canManageSupplierPayments ? (
                          <span className="text-xs text-muted-foreground">Admin only</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:block">
                <table className="min-w-full text-sm whitespace-nowrap">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-2 pr-4">Date</th>
                      <th className="text-left py-2 pr-4">Supplier</th>
                      <th className="text-left py-2 pr-4">Product</th>
                      <th className="text-right py-2 pr-4">Qty</th>
                      <th className="text-right py-2 pr-4">Unit Cost</th>
                      <th className="text-right py-2 pr-4">Total</th>
                      <th className="text-right py-2 pr-4">Paid</th>
                      <th className="text-right py-2 pr-4">Outstanding</th>
                      <th className="text-left py-2 pr-4">Operational state</th>
                      <th className="text-left py-2 pr-4">Payment state</th>
                      <th className="text-left py-2 pr-4">Expected</th>
                      <th className="text-left py-2 pr-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className={`border-t ${rowUrgencyClass(row)}`}>
                        <td className="py-2 pr-4">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="py-2 pr-4">
                          {row.supplierId ? (
                            <Link
                              className="underline"
                              href={`/admin/suppliers?focus=${encodeURIComponent(row.supplierId)}`}
                            >
                              {row.supplier}
                            </Link>
                          ) : (
                            row.supplier
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {row.product?.id ? (
                            <Link
                              className="underline"
                              href={`/admin/products?q=${encodeURIComponent(row.product.sku || row.product.name)}`}
                            >
                              {row.product.name}
                            </Link>
                          ) : (
                            row.product?.name || "Unknown"
                          )}
                          {row.product?.sku ? ` - ${row.product.sku}` : ""}
                        </td>
                        <td className="py-2 pr-4 text-right">{row.quantity}</td>
                        <td className="py-2 pr-4 text-right">{formatCurrency(row.unitCost)}</td>
                        <td className="py-2 pr-4 text-right">{formatCurrency(row.total)}</td>
                        <td className="py-2 pr-4 text-right">{formatCurrency(row.paidAmount)}</td>
                        <td className="py-2 pr-4 text-right">{formatCurrency(row.outstanding)}</td>
                        <td className="py-2 pr-4">
                          <div
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusChipClass(
                              row.status === "PENDING_APPROVAL" ? "warn" : "info",
                            )}`}
                          >
                            {operationalStatus(row)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Purchase status: {humanPurchaseStatus(row.status)}
                          </div>
                        </td>
                        <td className="py-2 pr-4">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusChipClass(
                              paymentChipTone(row.paymentStatus),
                            )}`}
                          >
                            {humanPaymentStatus(row.paymentStatus)}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-col gap-1">
                            <span>{row.expectedAt ? new Date(row.expectedAt).toLocaleDateString() : "-"}</span>
                            {row.outstanding > 0.01 ? (
                              <span
                                className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass(
                                  expectedStatus(row.expectedAt).tone,
                                )}`}
                              >
                                {expectedStatus(row.expectedAt).label}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex min-w-[140px] flex-col gap-1">
                            <Link className="underline" href={`/admin/purchases?purchaseId=${row.id}`}>
                              View purchase
                            </Link>
                            <Link
                              className="underline text-xs"
                              href={`/admin/audit?entityType=PURCHASE&entityId=${encodeURIComponent(row.id)}&sourcePage=admin%2Fsupplier-payments`}
                            >
                              Audit
                            </Link>
                            {row.outstanding > 0.01 ? (
                              <span
                                className="inline-flex"
                                title={
                                  paymentEligibleStatuses.has(row.status)
                                    ? ""
                                    : "Payment is available after approval."
                                }
                              >
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openPaymentDialog(row)}
                                  disabled={!canManageSupplierPayments || !paymentEligibleStatuses.has(row.status)}
                                >
                                  Record payment
                                </Button>
                              </span>
                            ) : null}
                            {!canManageSupplierPayments ? (
                              <span className="text-xs text-muted-foreground">Admin only</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(1)}
            >
              ««
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹ Prev
            </Button>
            <span className="text-muted-foreground">
              Page {page} of {totalPages}
              {isClientFiltered ? (
                <span className="ml-1 text-xs text-amber-700" title="Filter applied client-side — pagination reflects current page only">
                  (filtered view)
                </span>
              ) : null}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next ›
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
            >
              »»
            </Button>
            {totalPages > 2 ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">Go to:</span>
                <Input
                  type="number"
                  min={1}
                  max={totalPages}
                  className="h-7 w-16 text-xs"
                  placeholder={String(page)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const v = Number((e.target as HTMLInputElement).value);
                      if (Number.isFinite(v) && v >= 1 && v <= totalPages) {
                        setPage(v);
                        (e.target as HTMLInputElement).value = "";
                      }
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record supplier payment</DialogTitle>
            <DialogDescription>
              Enter a payment against this supplier purchase and attach reference details when available.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-muted-foreground">Purchase</div>
              <div className="font-medium">{paymentRow?.product?.name || "Supplier purchase"}</div>
              <div className="text-xs text-muted-foreground">
                Outstanding: {paymentRow ? formatCurrency(paymentRow.outstanding) : "-"}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Amount</label>
              <Input
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                type="number"
                step="0.01"
                min="0"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Method</label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Reference</label>
              <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Proof URL (optional)</label>
              <Input
                value={paymentProof}
                onChange={(e) => setPaymentProof(e.target.value)}
                placeholder="https://..."
                type="url"
              />
              {paymentProof && !isValidUrl(paymentProof) ? (
                <p className="mt-0.5 text-[11px] text-red-600">Must be a valid http/https URL.</p>
              ) : null}
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Note</label>
              <Input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} />
            </div>
            {paymentError ? (
              <div className="text-xs text-red-600">{paymentError}</div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaymentOpen(false)} disabled={paymentSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitPayment} disabled={paymentSubmitting}>
              {paymentSubmitting ? "Saving..." : "Save payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (confirmSubmitting) return;
          setConfirmOpen(open);
          if (!open) setConfirmState(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmState?.kind === "purchase" ? "Confirm Purchase Approval" : "Confirm Payment Approval"}
            </DialogTitle>
            <DialogDescription>
              Confirm this approval after reviewing the supplier, amount, and resulting workflow impact.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {confirmState?.kind === "purchase"
                ? "Approve this purchase now?"
                : "Approve this supplier payment now?"}
            </p>
            <div className="rounded-md border p-3 space-y-1 text-sm">
              <div>
                <span className="text-muted-foreground">Supplier: </span>
                <span className="font-medium">{confirmState?.supplier || "-"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {confirmState?.kind === "purchase" ? "Product: " : "Purchase: "}
                </span>
                <span className="font-medium">{confirmState?.itemLabel || "-"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Amount: </span>
                <span className="font-medium">{formatCurrency(confirmState?.amount || 0)}</span>
              </div>
              {confirmState?.kind === "payment" && (
                <>
                  {confirmState.method ? (
                    <div>
                      <span className="text-muted-foreground">Method: </span>
                      <span className="font-medium capitalize">{confirmState.method}</span>
                    </div>
                  ) : null}
                  {confirmState.reference ? (
                    <div>
                      <span className="text-muted-foreground">Reference: </span>
                      <span className="font-medium">{confirmState.reference}</span>
                    </div>
                  ) : null}
                  {confirmState.proofUrl ? (
                    <div>
                      <span className="text-muted-foreground">Proof: </span>
                      <a
                        href={confirmState.proofUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline text-sky-700 break-all"
                      >
                        View proof document
                      </a>
                    </div>
                  ) : (
                    <div className="text-xs text-amber-700">No proof document attached.</div>
                  )}
                  {confirmState.note ? (
                    <div>
                      <span className="text-muted-foreground">Note: </span>
                      <span>{confirmState.note}</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">Impact preview</div>
              {confirmState?.kind === "purchase" ? (
                <>
                  <div>Will move to payables ledger as approved purchase.</div>
                  <div>
                    Pending purchase approvals: {formatCurrency(totalPendingPurchaseApprovals)} {"->"}{" "}
                    {formatCurrency(pendingPurchaseAfterPreview)}
                  </div>
                </>
              ) : (
                <>
                  <div>Will post supplier payment and reduce pending payment approvals.</div>
                  <div>
                    Pending payment approvals: {formatCurrency(totalPendingPaymentApprovals)} {"->"}{" "}
                    {formatCurrency(pendingPaymentAfterPreview)}
                  </div>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (confirmSubmitting) return;
                setConfirmOpen(false);
                setConfirmState(null);
              }}
              disabled={confirmSubmitting}
            >
              Cancel
            </Button>
            <Button onClick={submitApprovalConfirm} disabled={confirmSubmitting || !confirmState}>
              {confirmSubmitting ? "Approving..." : "Yes, approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

