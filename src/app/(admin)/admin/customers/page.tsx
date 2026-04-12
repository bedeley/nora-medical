"use client";

export const dynamic = "force-dynamic";
import { Suspense, useEffect, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { chipToneClass } from "@/lib/status-chips";
import { RefreshCcw, HelpCircle, MoreVertical, Search, X, Eye, CreditCard } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import Link from "next/link";
import { Tooltip } from "@/components/ui/tooltip";
import { formatIdReadable } from "@/lib/utils";
import { useSearchParams } from "next/navigation";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { getCustomerActionPermissions } from "./customer-actions";
import { Badge } from "@/components/ui/badge";

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
};

export type CustomerRow = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    role?: string | null;
    phone?: string | null;
    archived?: boolean;
  };
  phoneVerified?: boolean;
  whatsappReady?: boolean;
  ordersTotal?: number;
  paidTotal?: number;
  paymentsTotal?: number;
  storeCredit?: number;
  refundedCash?: number;
  creditLimit?: number;
  lastOrderAt?: string | null;
  cart?: {
    total?: number;
    totalItems?: number;
    items?: Array<{
      id: string;
      productName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    updatedAt?: string | Date | null;
  } | null;
  delivery?: {
    delivered?: number;
    partial?: number;
    pending?: number;
  };
};

type CartItem = NonNullable<NonNullable<CustomerRow["cart"]>["items"]>[number];

type PaymentApplied = {
  orderId: string;
  applied: number;
};

type PaymentRow = {
  id: string;
  amount: number;
  orderId: string | null;
  createdAt: string;
  applied: PaymentApplied[];
  meta?: {
    status?: string;
    refundDisposition?: string;
    method?: string;
    reference?: string;
    location?: string;
  } | null;
  status: string | null;
  refundDisposition: string | null;
};

type AppliedBreakdownDisplay = {
  entries: PaymentApplied[];
  linkedTotal: number;
  unallocated: number;
  overLinked: number;
  hasMismatch: boolean;
};

type CustomerOrderPreview = {
  id: string;
  status: string;
  createdAt: string;
  total: number;
  amountPaid: number;
  balance: number;
};

type CustomerProfileType = "B2B" | "B2C";

function isEmployeeCustomer(row: CustomerRow) {
  return Boolean(row.user.role && row.user.role !== "CUSTOMER");
}

function customerRoleLabel(role?: string | null) {
  if (!role || role === "CUSTOMER") return "";
  return `${role.charAt(0)}${role.slice(1).toLowerCase()} customer`;
}

function buildAppliedBreakdownDisplay(
  payment: PaymentRow,
): AppliedBreakdownDisplay {
  const amount = Math.abs(Number(payment.amount || 0));
  const source = Array.isArray(payment.applied) ? payment.applied : [];
  const valid = source
    .map((a) => ({
      orderId: String(a?.orderId || ""),
      applied: Number(a?.applied || 0),
    }))
    .filter((a) => a.orderId && a.applied > 0);

  if (valid.length === 0 && payment.orderId && amount > 0) {
    return {
      entries: [{ orderId: String(payment.orderId), applied: amount }],
      linkedTotal: amount,
      unallocated: 0,
      overLinked: 0,
      hasMismatch: false,
    };
  }

  let remaining = amount;
  const entries: PaymentApplied[] = [];
  for (const entry of valid) {
    if (remaining <= 0.0001) break;
    const take = Math.min(entry.applied, remaining);
    if (take > 0) entries.push({ orderId: entry.orderId, applied: take });
    remaining -= take;
  }

  const rawTotal = valid.reduce((sum, entry) => sum + entry.applied, 0);
  const linkedTotal = entries.reduce((sum, entry) => sum + entry.applied, 0);
  const unallocated = Math.max(0, amount - linkedTotal);
  const overLinked = Math.max(0, rawTotal - amount);
  const hasMismatch = Math.abs(rawTotal - amount) > 0.01;

  return { entries, linkedTotal, unallocated, overLinked, hasMismatch };
}

function AdminCustomersContent() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const currentRole = (session?.user as { role?: string } | undefined)?.role;
  const actionPermissions = useMemo(
    () => getCustomerActionPermissions(currentRole),
    [currentRole],
  );
  const [confirmClear, setConfirmClear] = useState<{ id: string; email?: string|null } | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const [balanceFilter, setBalanceFilter] = useState<"all" | "due">("all");
  const [customerSort, setCustomerSort] = useState<"balance_desc" | "balance_asc" | "name_asc">("balance_desc");
  const [creditFilter, setCreditFilter] = useState<"all" | "credit">("all");
  const [limitFilter, setLimitFilter] = useState<"all" | "over">("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const customerListUrl = useMemo(() => {
    const params = new URLSearchParams({
      scope: "customer-ledger",
      page: String(page),
      pageSize: String(pageSize),
    });
    if (includeArchived) params.set("includeArchived", "1");
    const q = searchQuery.trim();
    if (q) params.set("q", q);
    return `/api/admin/customers?${params.toString()}`;
  }, [includeArchived, page, searchQuery]);
  const { data, error, isFetching: isValidating } = useClientQuery({
    queryKey: ["admin", "customers", { page, pageSize, q: searchQuery.trim(), includeArchived }],
    queryFn: () => fetcher(customerListUrl),
    refetchInterval: 8000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [explain, setExplain] = useState<{
    userId: string;
    email: string;
    paymentsTotal: number;
    paidTotal: number;
    ordersTotal: number;
    storeCredit: number;
    refundedCash: number;
    balance: number;
  } | null>(null);
  const [exportMonth, setExportMonth] = useState(() => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });
  const [exportMethod, setExportMethod] = useState<string>("");
  const [exportStatus, setExportStatus] = useState<string>("");
  const [refundCredit, setRefundCredit] = useState<{ userId: string; email: string; credit: number } | null>(null);
  const [refundAmount, setRefundAmount] = useState<string>("");
  const [refundAll, setRefundAll] = useState<boolean>(true);
  const [refundMethod, setRefundMethod] = useState<"cash" | "transfer">("cash");
  const [refundRef, setRefundRef] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundErrors, setRefundErrors] = useState<{ amount?: string; note?: string }>({});
  const [viewCart, setViewCart] = useState<{ user: CustomerRow["user"]; cart: CustomerRow["cart"] } | null>(null);
  const [addPaymentFor, setAddPaymentFor] = useState<{ userId: string; email: string | null } | null>(null);
  const [addPaymentAmount, setAddPaymentAmount] = useState<string>("");
  const [addPaymentMethod, setAddPaymentMethod] = useState<"" | "cash" | "transfer">("");
  const [addPaymentNote, setAddPaymentNote] = useState<string>("");
  const [addPaymentSubmitting, setAddPaymentSubmitting] = useState(false);
  const [addPaymentErrors, setAddPaymentErrors] = useState<{ amount?: string; method?: string }>({});
  const [addPaymentOpenOrders, setAddPaymentOpenOrders] = useState<CustomerOrderPreview[]>([]);
  const [addPaymentOrdersLoading, setAddPaymentOrdersLoading] = useState(false);
  const [addPaymentOrdersError, setAddPaymentOrdersError] = useState("");
  const [adjustFor, setAdjustFor] = useState<{ userId: string; email: string | null } | null>(null);
  const [adjustAmount, setAdjustAmount] = useState<string>("");
  const [adjustNote, setAdjustNote] = useState<string>("");
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const [adjustErrors, setAdjustErrors] = useState<{ amount?: string; note?: string }>({});
  const [creditLimitFor, setCreditLimitFor] = useState<{ userId: string; email: string | null; creditLimit: number } | null>(null);
  const [creditLimitValue, setCreditLimitValue] = useState<string>("");
  const [creditLimitSubmitting, setCreditLimitSubmitting] = useState(false);
  const [creditLimitError, setCreditLimitError] = useState<string>("");
  const [profileFor, setProfileFor] = useState<{ userId: string; email: string | null; profile: CustomerProfileType } | null>(null);
  const [profileValue, setProfileValue] = useState<CustomerProfileType>("B2B");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [archiveFor, setArchiveFor] = useState<{ userId: string; email: string | null; archived: boolean } | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveSubmitting, setArchiveSubmitting] = useState(false);
  const [closeFor, setCloseFor] = useState<{ userId: string; email: string | null } | null>(null);
  const [closeConfirmText, setCloseConfirmText] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [closeReasonDetail, setCloseReasonDetail] = useState("");
  const [closeSubmitting, setCloseSubmitting] = useState(false);
  const [closeErrors, setCloseErrors] = useState<{ confirmText?: string; reason?: string }>({});
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus") || "";
  const sortParam = searchParams.get("sort") || "";
  const balanceParam = searchParams.get("balance") || "";
  // Only show the "Applied from Aging Hub" banner when actually navigated from the hub
  // (balance=due is the hub signal; non-default sorts only count when balance=due is also present)
  const fromAgingHub = balanceParam === "due";

  const addPaymentUserId = addPaymentFor?.userId || "";

  useEffect(() => {
    if (balanceParam === "due") setBalanceFilter("due");
    if (sortParam === "balance_desc" || sortParam === "balance_asc" || sortParam === "name_asc") {
      setCustomerSort(sortParam);
    }
  }, [balanceParam, sortParam]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, deliveryFilter, balanceFilter, creditFilter, limitFilter, customerSort, includeArchived]);

  useEffect(() => {
    if (!addPaymentUserId) {
      setAddPaymentOpenOrders([]);
      setAddPaymentOrdersLoading(false);
      setAddPaymentOrdersError("");
      return;
    }
    let cancelled = false;
    async function loadOrders() {
      setAddPaymentOrdersLoading(true);
      setAddPaymentOrdersError("");
      try {
        const res = await fetch(`/api/admin/orders/user/${addPaymentUserId}/list`);
        const body = (await res.json().catch(() => ({}))) as {
          orders?: Array<{
            id: string;
            status: string;
            createdAt: string;
            total: number;
            amountPaid: number;
            balance: number;
          }>;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(body?.error || "Failed to load customer orders");
        }
        const openOrders = (body.orders || [])
          .map((o) => ({
            id: o.id,
            status: String(o.status || ""),
            createdAt: String(o.createdAt || ""),
            total: Number(o.total || 0),
            amountPaid: Number(o.amountPaid || 0),
            balance: Math.max(0, Number(o.balance || 0)),
          }))
          .filter(
            (o) =>
              o.balance > 0.005 &&
              ["UNPAID", "PARTIALLY_PAID", "PENDING_PAYMENT"].includes(o.status),
          )
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        if (!cancelled) setAddPaymentOpenOrders(openOrders);
      } catch (e: unknown) {
        if (!cancelled) {
          setAddPaymentOrdersError(
            e instanceof Error ? e.message : "Failed to load customer orders",
          );
          setAddPaymentOpenOrders([]);
        }
      } finally {
        if (!cancelled) setAddPaymentOrdersLoading(false);
      }
    }
    loadOrders();
    return () => {
      cancelled = true;
    };
  }, [addPaymentUserId]);

  const addPaymentAllocationPreview = useMemo(() => {
    const amount = Number(addPaymentAmount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { allocations: [] as Array<{ orderId: string; apply: number; remainingAfter: number; previousBalance: number }>, unallocated: 0 };
    }
    let remaining = amount;
    const allocations: Array<{ orderId: string; apply: number; remainingAfter: number; previousBalance: number }> = [];
    for (const order of addPaymentOpenOrders) {
      if (remaining <= 0.0001) break;
      const previousBalance = Math.max(0, Number(order.balance || 0));
      const apply = Math.min(previousBalance, remaining);
      const remainingAfter = Math.max(0, previousBalance - apply);
      allocations.push({ orderId: order.id, apply, remainingAfter, previousBalance });
      remaining -= apply;
    }
    return {
      allocations,
      unallocated: Math.max(0, remaining),
    };
  }, [addPaymentAmount, addPaymentOpenOrders]);

  // Payments summary for current export filters
  const summaryParams = new URLSearchParams({ month: exportMonth });
  if (exportMethod) summaryParams.set("method", exportMethod);
  if (exportStatus) summaryParams.set("status", exportStatus);
  const { data: paymentsSummary, isFetching: isValidatingSummary } = useClientQuery({
    queryKey: ["admin", "payments", "summary", exportMonth, exportMethod, exportStatus],
    queryFn: () => fetcher(`/api/admin/payments/summary?${summaryParams.toString()}`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refreshing = isValidating || isValidatingSummary;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const rows: CustomerRow[] = useMemo(
    () => (data?.rows || []) as CustomerRow[],
    [data],
  );
  const getCustomerBalance = (r: CustomerRow) =>
    Number(r.ordersTotal || 0) - Number(r.paidTotal || 0);
  const getCustomerCredit = (r: CustomerRow) => {
    const direct = Number(r.storeCredit ?? NaN);
    if (Number.isFinite(direct)) return Math.max(0, direct);
    const payments = Number(r.paymentsTotal || 0);
    const paid = Number(r.paidTotal || 0);
    return Math.max(0, payments - paid);
  };
  const getCloseBlockers = (r: CustomerRow) => {
    const blockers: string[] = [];
    if (isEmployeeCustomer(r)) blockers.push("employee role");
    if (Number(r.ordersTotal || 0) > 0.005) blockers.push("orders");
    if (Number(r.paymentsTotal || 0) > 0.005) blockers.push("payments");
    if (getCustomerCredit(r) > 0.005) blockers.push("store credit");
    if (Number(r.creditLimit || 0) > 0.005) blockers.push("credit limit");
    if (r.cart) blockers.push("cart");
    return blockers;
  };

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const base = rows
      .filter((r) => {
        if (!q) return true;
        const name = (r.user.name || "").toLowerCase();
        const email = (r.user.email || "").toLowerCase();
        const phone = (r.user.phone || "").replace(/\D/g, "");
        const phoneQ = q.replace(/\D/g, "");
        return (
          name.includes(q) ||
          email.includes(q) ||
          (phoneQ.length >= 4 && phone.includes(phoneQ))
        );
      })
      .filter((r) => {
        const d = r.delivery || { delivered: 0, partial: 0, pending: 0 };
        if (deliveryFilter === "pending") return (d.pending || 0) > 0;
        if (deliveryFilter === "partial") return (d.partial || 0) > 0;
        if (deliveryFilter === "delivered") return (d.delivered || 0) > 0;
        return true;
      })
      .filter((r) => {
        if (balanceFilter === "due") {
          const balance = getCustomerBalance(r);
          if (balance <= 0.005) return false;
        }
        if (creditFilter === "credit") {
          const credit = getCustomerCredit(r);
          if (credit <= 0.005) return false;
        }
        if (limitFilter === "over") {
          const balance = getCustomerBalance(r);
          const limit = Number(r.creditLimit || 0);
          if (limit <= 0.005 || balance <= limit + 0.005) return false;
        }
        return true;
      });
    if (customerSort === "name_asc") {
      return [...base].sort((a, b) =>
        String(a.user.name || a.user.email || "").localeCompare(
          String(b.user.name || b.user.email || ""),
          undefined,
          { sensitivity: "base" },
        ),
      );
    }
    if (customerSort === "balance_asc") {
      return [...base].sort((a, b) => getCustomerBalance(a) - getCustomerBalance(b));
    }
    return [...base].sort((a, b) => getCustomerBalance(b) - getCustomerBalance(a));
  }, [rows, searchQuery, deliveryFilter, balanceFilter, creditFilter, limitFilter, customerSort]);
  const visibleIds = filteredRows.map((r) => r.user.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;
  const totalRows = Number(data?.total ?? rows.length);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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

  const exportSelected = () => {
    const selected = filteredRows.filter((r) => selectedIds.has(r.user.id));
    if (selected.length === 0) {
      toast.error("Select at least one customer to export.");
      return;
    }
    const header = ["CustomerId", "Name", "Email", "OrdersTotal", "PaidTotal", "StoreCredit", "Balance"];
    const lines = [header.join(",")];
    for (const r of selected) {
      const balance = Number(r.ordersTotal || 0) - Number(r.paidTotal || 0);
      const credit = Math.max(
        0,
        r.storeCredit ?? Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0)),
      );
      lines.push([
        JSON.stringify(r.user.id),
        JSON.stringify(r.user.name || ""),
        JSON.stringify(r.user.email || ""),
        String(Number(r.ordersTotal || 0)),
        String(Number(r.paidTotal || 0)),
        String(Number(credit || 0)),
        String(Number(balance || 0)),
      ].join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `customers_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "customers",
      format: "CSV",
      fileName: filename,
      rowCount: selected.length,
      columnCount: header.length,
      byteSize: blob.size,
      scopeSnapshot: "Selected customers export",
    });
  };

  async function createUserPayment(params: {
    userId: string;
    amount: number;
    method: "cash" | "transfer" | "adjustment";
    note?: string;
    location: string;
    refundDisposition?: "cash" | "credit";
  }) {
    const { userId, amount, method, note, location, refundDisposition } = params;
    const res = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        amount,
        method,
        status: "normal",
        refundDisposition: refundDisposition || undefined,
        note: note || undefined,
        location,
      }),
    });
    if (!res.ok) {
      const msg =
        (
          await res.json().catch(async () => ({
            error: await res.text().catch(() => ""),
          }))
        ).error || "Failed to record payment";
      throw new Error(msg);
    }
    return res.json();
  }

  const renderActionsMenu = (r: CustomerRow, buttonClass = "") => {
    const canManageEmployeeFinancialActions =
      !isEmployeeCustomer(r) || currentRole === "ADMIN";
    const canManageCreditForRow =
      actionPermissions.canManageCredit && canManageEmployeeFinancialActions;
    const closeBlockers = getCloseBlockers(r);

    return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={`h-9 w-9 ${buttonClass}`}
          aria-label="Customer actions"
          title="Customer actions"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actionPermissions.canManagePayments && (
          <DropdownMenuItem
            onClick={() => {
              const outstanding = Math.max(
                0,
                Number(r.ordersTotal || 0) - Number(r.paidTotal || 0),
              );
              setAddPaymentFor({ userId: r.user.id, email: r.user.email });
              setAddPaymentAmount(
                outstanding > 0 ? outstanding.toFixed(2) : "",
              );
              setAddPaymentMethod("");
              setAddPaymentNote("");
            }}
          >
            Add Payment
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => {
            setExplain({
              userId: r.user.id,
              email: r.user.email,
              paymentsTotal: Number(r.paymentsTotal || 0),
              paidTotal: Number(r.paidTotal || 0),
              ordersTotal: Number(r.ordersTotal || 0),
              storeCredit: Number(r.storeCredit || 0),
              refundedCash: Number(r.refundedCash || 0),
              balance: Math.max(
                0,
                Number(r.ordersTotal || 0) - Number(r.paidTotal || 0),
              ),
            });
          }}
        >
          Explain totals
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            window.open(`/api/admin/customers/${r.user.id}/statement?format=csv`, "_blank");
          }}
        >
          Download statement (CSV)
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            window.open(`/api/admin/customers/${r.user.id}/statement?format=pdf`, "_blank");
          }}
        >
          Download statement (PDF)
        </DropdownMenuItem>
        {actionPermissions.canSendAccountEmails && (
          <>
            <DropdownMenuItem
              onClick={async () => {
                try {
                  const res = await fetch(
                    `/api/admin/customers/${r.user.id}/statement/email`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId: r.user.id }),
                    },
                  );
                  const j = await res.json().catch(() => ({} as { error?: string }));
                  if (!res.ok) {
                    throw new Error(j?.error || "Failed to email statement");
                  }
                  toast.success("Statement emailed to customer.");
                } catch (e: unknown) {
                  const message =
                    e instanceof Error ? e.message : "Failed to email statement";
                  toast.error(message);
                }
              }}
            >
              Email statement
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                try {
                  const res = await fetch(
                    `/api/admin/customers/${r.user.id}/reminder/email`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId: r.user.id }),
                    },
                  );
                  const j = await res.json().catch(() => ({} as { error?: string }));
                  if (!res.ok) {
                    throw new Error(j?.error || "Failed to send reminder");
                  }
                  toast.success("Payment reminder sent.");
                } catch (e: unknown) {
                  const message =
                    e instanceof Error ? e.message : "Failed to send reminder";
                  toast.error(message);
                }
              }}
            >
              Send payment reminder
            </DropdownMenuItem>
          </>
        )}
        {actionPermissions.canManageCreditLimit && (
          <DropdownMenuItem
            onClick={() => {
              const limit = Number(r.creditLimit ?? 0);
              setCreditLimitFor({ userId: r.user.id, email: r.user.email, creditLimit: limit });
              setCreditLimitValue(limit > 0 ? limit.toFixed(2) : "");
              setCreditLimitError("");
            }}
          >
            Set credit limit
          </DropdownMenuItem>
        )}
        {actionPermissions.canManageProfile && (
          <DropdownMenuItem
            onClick={async () => {
              setProfileFor({ userId: r.user.id, email: r.user.email, profile: "B2B" });
              setProfileValue("B2B");
              setProfileLoading(true);
              try {
                const res = await fetch(`/api/admin/customers/${r.user.id}/profile`);
                const body = (await res.json().catch(() => ({}))) as { profile?: CustomerProfileType; error?: string };
                if (!res.ok) throw new Error(body.error || "Failed to load customer profile");
                const profile = body.profile === "B2C" ? "B2C" : "B2B";
                setProfileFor({ userId: r.user.id, email: r.user.email, profile });
                setProfileValue(profile);
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : "Failed to load customer profile";
                toast.error(message);
              } finally {
                setProfileLoading(false);
              }
            }}
          >
            Set commerce profile
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={`/admin/customers/${r.user.id}/view`}>
            View as customer (read-only)
          </Link>
        </DropdownMenuItem>
        {Math.max(
          0,
          r.storeCredit ??
            Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0)),
        ) > 0.005 && canManageCreditForRow && (
          <DropdownMenuItem
            onClick={async () => {
              const unapplied = Math.max(
                0,
                r.storeCredit ??
                  Math.max(
                    0,
                    (r.paymentsTotal ?? 0) - (r.paidTotal || 0),
                  ),
              );
              const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
              const EPSILON = 0.005;

              if (outstanding <= EPSILON) {
                toast.info("No outstanding balance to apply this payment to.");
                return;
              }
              if (unapplied <= EPSILON) {
                toast.info("No unapplied funds to apply.");
                return;
              }

              const amount = Math.min(unapplied, outstanding);
              const res = await fetch(`/api/admin/customers/${r.user.id}/credit/apply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
              });
              if (!res.ok) {
                const msg =
                  (
                    await res.json().catch(async () => ({ error: await res.text().catch(() => "") }))
                  ).error || "Failed to apply remaining";
                toast.error(msg);
              } else {
                const payload = await res.json().catch(() => ({ applied: amount }));
                toast.success(`Store credit applied: ${formatCurrency(Number(payload.applied || amount))}.`);
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              }
            }}
          >
            Apply to Balance
          </DropdownMenuItem>
        )}
        {canManageCreditForRow && (
          <DropdownMenuItem
            onClick={() => {
              const outstanding = Math.max(
                0,
                Number(r.ordersTotal || 0) - Number(r.paidTotal || 0),
              );
              setAdjustFor({ userId: r.user.id, email: r.user.email });
              setAdjustAmount(outstanding > 0 ? outstanding.toFixed(2) : "");
              setAdjustNote("");
            }}
          >
            Issue store credit
          </DropdownMenuItem>
        )}
        {(() => {
          const credit = Math.max(
            0,
            r.storeCredit ??
              Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0)),
          );
          if (credit <= 0.005 || !canManageCreditForRow) return null;
          return (
            <DropdownMenuItem
              onClick={() => {
                setRefundCredit({
                  userId: r.user.id,
                  email: r.user.email,
                  credit,
                });
                setRefundAmount(credit.toFixed(2));
                setRefundAll(true);
                setRefundMethod("cash");
                setRefundRef("");
                setRefundNote("");
              }}
            >
              Refund credit
            </DropdownMenuItem>
          );
        })()}
        {r.cart?.items?.length ? (
          <DropdownMenuItem
            onClick={() => {
              setViewCart({ user: r.user, cart: r.cart });
            }}
          >
            View Cart ({r.cart.totalItems ?? r.cart.items.length})
          </DropdownMenuItem>
        ) : null}
        {(() => {
          if (!r.cart || !actionPermissions.canManageCart) return null;
          const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
          const deliveredAll = (r.delivery?.pending || 0) === 0 && (r.delivery?.partial || 0) === 0;
          const canDeleteCart = outstanding <= 0.0001 && deliveredAll;
          return (
            <DropdownMenuItem
              disabled={!canDeleteCart}
              onClick={() => {
                if (!canDeleteCart) {
                  toast.info("Cart can be deleted only after full payment and delivery");
                  return;
                }
                setConfirmClear({ id: r.user.id, email: r.user.email });
              }}
            >
              Delete Cart
            </DropdownMenuItem>
          );
        })()}
        {actionPermissions.canManageLifecycle && (
          <>
            <DropdownMenuItem
              onClick={() => {
                setArchiveFor({
                  userId: r.user.id,
                  email: r.user.email,
                  archived: Boolean(r.user.archived),
                });
                setArchiveReason("");
              }}
            >
              {r.user.archived ? "Unarchive account" : "Archive account"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={closeBlockers.length > 0}
              onClick={() => {
                if (closeBlockers.length > 0) {
                  toast.info(`Archive instead. Close is blocked by ${closeBlockers.join(", ")}.`);
                  return;
                }
                setCloseFor({ userId: r.user.id, email: r.user.email });
                setCloseConfirmText("");
                setCloseReason("");
                setCloseReasonDetail("");
                setCloseErrors({});
              }}
            >
              Close account
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    );
  };

  // Legacy per-order payment card removed in favor of Actions-based flows.

  if (error) {
    const msg = String((error as Error)?.message || "Error");
    const unauthorized = /unauthorized/i.test(msg);
    return (
      <div className="container mx-auto py-8 max-w-3xl">
        <h1 className="text-2xl font-semibold mb-4">Customers</h1>
        <div className="rounded-md border p-6 text-sm">
          {unauthorized ? (
            <p>Admin access required. Please sign in with an admin account.</p>
          ) : (
            <p>Failed to load customers: {msg}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
    <section className="container mx-auto py-8 space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="text-sm text-muted-foreground">
            Monitor balances, credits, and delivery status.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {fromAgingHub ? (
              <div className="inline-flex items-center rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-800">
                Applied from Aging Hub
              </div>
            ) : null}
            <Link
              href="/admin/audit?sourcePage=admin%2Fcustomers"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              title="View audit trail for customer actions"
            >
              <HelpCircle className="h-3 w-3" />
              Audit trail
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="h-9 w-full sm:w-auto"
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams({ month: exportMonth });
              if (exportMethod) params.set("method", exportMethod);
              if (exportStatus) params.set("status", exportStatus);
              if (deliveryFilter && deliveryFilter !== "all") {
                const d = deliveryFilter === "pending" ? "not-delivered" : deliveryFilter;
                params.set("delivery", d);
              }
              window.open(`/api/admin/payments/export?${params.toString()}`, "_blank");
            }}
          >
            Export Payments CSV
          </Button>
          <Button
            className="h-9 w-full sm:w-auto"
            variant="outline"
            size="sm"
            onClick={() => {
              const params = new URLSearchParams({ month: exportMonth });
              if (exportMethod) params.set("method", exportMethod);
              if (exportStatus) params.set("status", exportStatus);
              if (deliveryFilter && deliveryFilter !== "all") {
                const d = deliveryFilter === "pending" ? "not-delivered" : deliveryFilter;
                params.set("delivery", d);
              }
              window.open(`/admin/payments/export/print?${params.toString()}`, "_blank");
            }}
          >
            Export Payments PDF
          </Button>
          <Button
            className="h-9 w-full sm:w-9"
            variant="outline"
            size="icon"
            onClick={async () => {
              queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              queryClient.invalidateQueries({ queryKey: ["admin", "payments", "summary"] });
            }}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCcw className={`h-4 w-4 ${mounted && refreshing ? "animate-spin" : ""}`} />
          </Button>
          {paymentsSummary && (
            <div className="w-full sm:w-auto">
              <PaymentsSummaryButton
                month={exportMonth}
                method={exportMethod}
                status={exportStatus}
                total={Number(paymentsSummary.total || 0)}
                count={Number(paymentsSummary.count || 0)}
              />
            </div>
          )}
        </div>
      </div>

      <Card className="shadow-md !border-none mb-6 w-full">
        <CardHeader className="flex items-center justify-between space-y-0 py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              placeholder="Search by name, email or phone…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-8 h-9"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <Button
              size="sm"
              variant={balanceFilter === "all" ? "default" : "outline"}
              onClick={() => {
                setBalanceFilter("all");
                setCreditFilter("all");
                setLimitFilter("all");
              }}
            >
              All customers
            </Button>
            <Button
              size="sm"
              variant={balanceFilter === "due" ? "default" : "outline"}
              onClick={() => {
                setBalanceFilter("due");
                setCreditFilter("all");
                setLimitFilter("all");
              }}
            >
              Balance due
            </Button>
            <Button
              size="sm"
              variant={creditFilter === "all" ? "default" : "outline"}
              onClick={() => {
                setCreditFilter("all");
                setLimitFilter("all");
              }}
            >
              All credits
            </Button>
            <Button
              size="sm"
              variant={creditFilter === "credit" ? "default" : "outline"}
              onClick={() => {
                setCreditFilter("credit");
                setBalanceFilter("all");
                setLimitFilter("all");
              }}
            >
              Has store credit
            </Button>
            <Button
              size="sm"
              variant={limitFilter === "over" ? "default" : "outline"}
              onClick={() => {
                setLimitFilter("over");
                setBalanceFilter("all");
                setCreditFilter("all");
              }}
            >
              Over credit limit
            </Button>
            <label className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Include archived
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Sort</label>
              <Select value={customerSort} onValueChange={(v) => setCustomerSort(v as typeof customerSort)}>
                <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="balance_desc">Balance (highest first)</SelectItem>
                  <SelectItem value="balance_asc">Balance (lowest first)</SelectItem>
                  <SelectItem value="name_asc">Name (A–Z)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Delivery</label>
              <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
                <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All deliveries" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Not Delivered</SelectItem>
                  <SelectItem value="partial">Partially Delivered</SelectItem>
                  <SelectItem value="delivered">Delivered</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <details className="mt-4 group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 select-none list-none">
              <span className="group-open:hidden">▶</span>
              <span className="hidden group-open:inline">▼</span>
              Payment Export Options (month, method, status)
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Month</label>
                <input
                  type="month"
                  className="h-9 rounded-md border px-2 text-sm w-full"
                  value={exportMonth}
                  onChange={(e) => setExportMonth(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Method</label>
                <Select value={exportMethod || "all"} onValueChange={(v) => setExportMethod(v === "all" ? "" : v)}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="adjustment">Adjustment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Status</label>
                <Select value={exportStatus || "all"} onValueChange={(v) => setExportStatus(v === "all" ? "" : v)}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="refund">Refund</SelectItem>
                    <SelectItem value="void">Void</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* KPI summary strip */}
      {filteredRows.length > 0 && (() => {
        const totalOutstanding = filteredRows.reduce((s, r) => s + Math.max(0, getCustomerBalance(r)), 0);
        const totalCredit = filteredRows.reduce((s, r) => s + Math.max(0, getCustomerCredit(r)), 0);
        const overLimitCount = filteredRows.filter((r) => {
          const balance = getCustomerBalance(r);
          const limit = Number(r.creditLimit || 0);
          return limit > 0.005 && balance > limit + 0.005;
        }).length;
        const withBalanceCount = filteredRows.filter((r) => getCustomerBalance(r) > 0.005).length;
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">Showing</p>
              <p className="text-lg font-semibold tabular-nums">{filteredRows.length}</p>
              <p className="text-xs text-muted-foreground">{withBalanceCount} with balance due</p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">Total Outstanding</p>
              <p className="text-lg font-semibold tabular-nums text-red-700">{formatCurrency(totalOutstanding)}</p>
              <p className="text-xs text-muted-foreground">across shown customers</p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs text-muted-foreground">Total Store Credit</p>
              <p className="text-lg font-semibold tabular-nums text-amber-700">{formatCurrency(totalCredit)}</p>
              <p className="text-xs text-muted-foreground">held across shown customers</p>
            </div>
            <div className={`rounded-lg border px-4 py-3 ${overLimitCount > 0 ? "bg-orange-50 border-orange-200" : "bg-card"}`}>
              <p className="text-xs text-muted-foreground">Over Credit Limit</p>
              <p className={`text-lg font-semibold tabular-nums ${overLimitCount > 0 ? "text-orange-700" : "text-muted-foreground"}`}>{overLimitCount}</p>
              <p className="text-xs text-muted-foreground">customer{overLimitCount === 1 ? "" : "s"}</p>
            </div>
          </div>
        );
      })()}

      <div className="grid gap-4">
        {/* Record Payment card removed in favor of Actions-based Add Payment & Adjustment */}
        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{selectedCount} selected</span>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={exportSelected}>
                Export CSV ({selectedCount})
              </Button>
            </div>
          </div>
        )}
        <Card className="shadow-md !border-none w-full min-w-0">
          <CardHeader className="flex items-center justify-between py-3">
            <CardTitle className="text-base font-semibold">Customers</CardTitle>
            <span className="text-xs text-muted-foreground">
              {filteredRows.length} shown on page {page} of {totalPages}
            </span>
          </CardHeader>
          <CardContent className="p-0 overflow-x-hidden">
            {isValidating && rows.length === 0 && (
              <div className="hidden lg:flex flex-col gap-0">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-3 border-b last:border-0 animate-pulse">
                    <div className="h-4 w-4 rounded bg-muted shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 w-36 rounded bg-muted" />
                      <div className="h-2.5 w-24 rounded bg-muted opacity-60" />
                    </div>
                    <div className="h-3.5 w-16 rounded bg-muted" />
                    <div className="h-3.5 w-16 rounded bg-muted" />
                    <div className="h-3.5 w-16 rounded bg-muted" />
                    <div className="h-3.5 w-16 rounded bg-muted" />
                    <div className="h-3.5 w-20 rounded bg-muted" />
                    <div className="h-6 w-20 rounded bg-muted" />
                  </div>
                ))}
              </div>
            )}
            <div className="hidden lg:block min-w-0 overflow-x-auto">
              <Table className="w-full table-auto admin-customers-table border-collapse">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[36px] text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        aria-label="Select all visible customers"
                      />
                    </TableHead>
                    <TableHead className="w-[260px] text-left">User</TableHead>
                    <TableHead className="w-[140px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Orders</span>
                        <Tooltip content="Total value of all orders">
                          <HelpCircle
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-label="Orders total"
                          />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[160px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Paid</span>
                        <Tooltip content="Payments applied to orders (sum of amountPaid across non-cancelled orders)">
                          <HelpCircle
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-label="Paid total"
                          />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[160px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Store Credit</span>
                        <Tooltip content="Store credit held for this customer (credit from returns and adjustments not yet applied or refunded). Use 'Explain totals' for full breakdown.">
                          <HelpCircle
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-label="Store credit"
                          />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[140px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Balance</span>
                        <Tooltip content="Outstanding = Orders - Paid. Red = amount owed. Use 'Explain totals' from Actions for full payment breakdown.">
                          <HelpCircle
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-label="Balance"
                          />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[140px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Credit Limit</span>
                        <Tooltip content="Maximum outstanding balance allowed. Orange badge = over limit.">
                          <HelpCircle
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-label="Credit limit"
                          />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[130px] text-right">
                      <div className="inline-flex items-center justify-end gap-1 w-full">
                        <span>Last Order</span>
                        <Tooltip content="Date of the most recent order placed by this customer.">
                          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Last order date" />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[160px] text-center">
                      <div className="inline-flex items-center justify-center gap-1">
                        <span>Cart</span>
                        <Tooltip content="Live cart total and items currently in their basket">
                          <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Cart totals" />
                        </Tooltip>
                      </div>
                    </TableHead>
                    <TableHead className="w-[200px] text-center">Delivery</TableHead>
                    <TableHead className="w-[180px] text-center">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((r: CustomerRow) => {
                    const isFocused =
                      focusId && String(r.user.id) === String(focusId);
                    const displayLabel =
                      (r.user.name && r.user.name.trim()) ||
                      (r.user.email && r.user.email.trim()) ||
                      formatIdReadable(r.user.id) ||
                      "Unnamed customer";
                    return (
                        <TableRow
                          key={r.user.id}
                          className={
                            isFocused
                              ? "bg-amber-50 hover:bg-amber-100"
                              : r.user.archived
                                ? "bg-muted/30"
                                : undefined
                          }
                        >
                        <TableCell className="text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selectedIds.has(r.user.id)}
                            onChange={() => toggleSelected(r.user.id)}
                            aria-label={`Select ${r.user.email}`}
                          />
                        </TableCell>
                        <TableCell className="max-w-[320px] text-left">
                          <div className="space-y-0.5">
                            <Link
                              href={`/admin/customers/${r.user.id}/view`}
                              className="truncate font-medium underline-offset-2 hover:underline"
                            >
                              {displayLabel}
                            </Link>
                            {isEmployeeCustomer(r) && (
                              <Badge variant="outline" className="ml-2 align-middle text-[10px]">
                                {customerRoleLabel(r.user.role)}
                              </Badge>
                            )}
                            {r.user.archived && (
                              <Badge variant="secondary" className="ml-2 align-middle text-[10px]">
                                Archived
                              </Badge>
                            )}
                            <div className="text-xs text-muted-foreground">
                              {r.user.phone || r.user.email || ""}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums font-mono px-2">{formatCurrency(r.ordersTotal || 0)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums font-mono px-2">{formatCurrency(r.paidTotal || 0)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums font-mono px-2">
                          {(() => {
                            const delta = getCustomerCredit(r);
                            const cls = delta > 0.005 ? "text-amber-700" : "text-muted-foreground";
                            return <span className={cls}>{formatCurrency(delta)}</span>;
                          })()}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums font-mono px-2">
                          {(() => {
                            const balance = getCustomerBalance(r);
                            const limit = Number(r.creditLimit || 0);
                            const overLimit = limit > 0.005 && balance > limit + 0.005;
                            return (
                              <div className="inline-flex flex-col items-end gap-0.5">
                                <span className={balance > 0.005 ? "text-red-700" : "text-muted-foreground"}>{formatCurrency(balance)}</span>
                                {overLimit && (
                                  <span className="text-[10px] font-semibold rounded px-1 py-0 bg-orange-100 text-orange-700 leading-tight">Over limit</span>
                                )}
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap tabular-nums font-mono px-2">
                          {Number(r.creditLimit || 0) > 0
                            ? formatCurrency(Number(r.creditLimit || 0))
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap px-2 text-xs text-muted-foreground">
                          {r.lastOrderAt
                            ? new Date(r.lastOrderAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-center whitespace-nowrap px-2 text-sm">
                          {r.cart?.totalItems ? (
                            <div className="flex flex-col leading-tight">
                              <span className="font-medium">{formatCurrency(r.cart.total || 0)}</span>
                              <span className="text-xs text-muted-foreground">{r.cart.totalItems} item{r.cart.totalItems === 1 ? "" : "s"}</span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">Empty</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center whitespace-nowrap">
                          {(() => {
                            const d = r.delivery || { delivered: 0, partial: 0, pending: 0 };
                            const chips = [];
                            if ((d.delivered || 0) > 0) chips.push(
                              <span key="d" className={`${chipToneClass("success")} rounded px-1.5 py-0.5`}>Full {d.delivered}</span>
                            );
                            if ((d.partial || 0) > 0) chips.push(
                              <span key="p" className={`${chipToneClass("warning")} rounded px-1.5 py-0.5`}>Partial {d.partial}</span>
                            );
                            if ((d.pending || 0) > 0) chips.push(
                              <span key="n" className={`${chipToneClass("neutral")} rounded px-1.5 py-0.5`}>Pending {d.pending}</span>
                            );
                            return chips.length > 0
                              ? <span className="text-xs flex flex-wrap gap-1 justify-center">{chips}</span>
                              : <span className="text-xs text-muted-foreground">—</span>;
                          })()}
                        </TableCell>
                        <TableCell className="text-center w-[180px] min-w-[160px] overflow-visible whitespace-normal">
                          <div className="flex w-full justify-center items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              asChild
                              title="View customer (read-only)"
                            >
                              <Link href={`/admin/customers/${r.user.id}/view`}>
                                <Eye className="h-4 w-4" />
                              </Link>
                            </Button>
                            {actionPermissions.canManagePayments && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                title="Add payment"
                                onClick={() => {
                                  const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
                                  setAddPaymentFor({ userId: r.user.id, email: r.user.email });
                                  setAddPaymentAmount(outstanding > 0 ? outstanding.toFixed(2) : "");
                                  setAddPaymentMethod("");
                                  setAddPaymentNote("");
                                }}
                              >
                                <CreditCard className="h-4 w-4" />
                              </Button>
                            )}
                            {renderActionsMenu(r)}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-6">
                        <div className="flex flex-col items-center gap-3">
                          <span>No customers found for the current filters.</span>
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSearchQuery("");
                                setDeliveryFilter("all");
                                setBalanceFilter("all");
                                setCreditFilter("all");
                                setLimitFilter("all");
                                setIncludeArchived(false);
                              }}
                            >
                              Clear filters
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                              }}
                            >
                              Refresh
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="lg:hidden space-y-4 border-t p-4">
              {filteredRows.map((r: CustomerRow) => {
            const outstanding = Math.max(0, getCustomerBalance(r));
            const credit = Math.max(0, getCustomerCredit(r));
                const delivery = r.delivery || { delivered: 0, partial: 0, pending: 0 };
                return (
                  <div key={r.user.id} className={`rounded-lg !border-0 shadow-md p-4 space-y-3 text-sm ${r.user.archived ? "bg-muted/30" : ""}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 mt-1"
                        checked={selectedIds.has(r.user.id)}
                        onChange={() => toggleSelected(r.user.id)}
                        aria-label={`Select ${r.user.email}`}
                      />
                      <div className="min-w-0">
                        <p className="font-semibold break-all">
                          <Link
                            href={`/admin/customers/${r.user.id}/view`}
                            className="underline-offset-2 hover:underline"
                          >
                            {r.user.name || r.user.email || "Customer"}
                          </Link>
                        </p>
                        {isEmployeeCustomer(r) && (
                          <Badge variant="outline" className="mt-1 text-[10px]">
                            {customerRoleLabel(r.user.role)}
                          </Badge>
                        )}
                        {r.user.archived && (
                          <Badge variant="secondary" className="ml-1 mt-1 text-[10px]">
                            Archived
                          </Badge>
                        )}
                        <p className="text-xs text-muted-foreground">{r.user.phone || r.user.email || ""}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Orders</p>
                        <p className="font-mono">{formatCurrency(r.ordersTotal || 0)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Paid</p>
                        <p className="font-mono">{formatCurrency(r.paidTotal || 0)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Store Credit</p>
                        <p className="font-mono text-amber-700">{formatCurrency(Math.max(0, credit))}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Balance</p>
                        <p className={`font-mono ${outstanding > 0.005 ? "text-red-700" : "text-muted-foreground"}`}>
                          {formatCurrency(outstanding)}
                        </p>
                        {(() => {
                          const limit = Number(r.creditLimit || 0);
                          return limit > 0.005 && outstanding > limit + 0.005
                            ? <span className="text-[10px] font-semibold rounded px-1 py-0 bg-orange-100 text-orange-700 leading-tight">Over limit</span>
                            : null;
                        })()}
                      </div>
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Credit Limit</p>
                        <p className="font-mono">
                          {Number(r.creditLimit || 0) > 0 ? formatCurrency(Number(r.creditLimit || 0)) : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase text-muted-foreground">Last Order</p>
                        <p className="text-xs text-muted-foreground">
                          {r.lastOrderAt
                            ? new Date(r.lastOrderAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                            : "—"}
                        </p>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.cart?.totalItems ? (
                        <>Cart: {r.cart.totalItems} item{r.cart.totalItems === 1 ? "" : "s"} · {formatCurrency(r.cart.total || 0)}</>
                      ) : (
                        <>Cart empty</>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {(delivery.delivered || 0) > 0 && (
                        <span className={`${chipToneClass("success")} rounded px-1.5 py-0.5`}>Full {delivery.delivered}</span>
                      )}
                      {(delivery.partial || 0) > 0 && (
                        <span className={`${chipToneClass("warning")} rounded px-1.5 py-0.5`}>Partial {delivery.partial}</span>
                      )}
                      {(delivery.pending || 0) > 0 && (
                        <span className={`${chipToneClass("neutral")} rounded px-1.5 py-0.5`}>Pending {delivery.pending}</span>
                      )}
                      {(delivery.delivered || 0) === 0 && (delivery.partial || 0) === 0 && (delivery.pending || 0) === 0 && (
                        <span className="text-muted-foreground">No orders</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {actionPermissions.canManagePayments && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 flex-1"
                          onClick={() => {
                            const outstandingAmt = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
                            setAddPaymentFor({ userId: r.user.id, email: r.user.email });
                            setAddPaymentAmount(outstandingAmt > 0 ? outstandingAmt.toFixed(2) : "");
                            setAddPaymentMethod("");
                            setAddPaymentNote("");
                          }}
                        >
                          <CreditCard className="h-3.5 w-3.5 mr-1" />
                          Add Payment
                        </Button>
                      )}
                      {renderActionsMenu(r)}
                    </div>
                  </div>
                );
              })}
              {filteredRows.length === 0 && (
                <div className="text-center text-sm text-muted-foreground">
                  <p>No customers match the selected filters.</p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSearchQuery("");
                        setDeliveryFilter("all");
                        setBalanceFilter("all");
                        setCreditFilter("all");
                        setLimitFilter("all");
                        setIncludeArchived(false);
                      }}
                    >
                      Clear filters
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                      }}
                    >
                      Refresh
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-muted-foreground">
                Showing {filteredRows.length} of {totalRows} matching customers
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1 || isValidating}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {page} / {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages || isValidating}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
    <Dialog open={!!viewCart} onOpenChange={(open) => { if (!open) setViewCart(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Cart for {viewCart?.user?.email || "customer"}</DialogTitle>
        </DialogHeader>
        {viewCart?.cart?.items?.length ? (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {viewCart.cart.items.map((item: CartItem) => (
              <div key={item.id} className="flex items-center justify-between text-sm border rounded-md px-3 py-2">
                <div>
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-xs text-muted-foreground">Qty: {item.quantity}</p>
                </div>
                <div className="text-right font-mono">
                  <p>{formatCurrency(item.unitPrice)}</p>
                  <p className="text-xs text-muted-foreground">Subtotal: {formatCurrency(item.subtotal)}</p>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t pt-3 font-semibold">
              <span>Total</span>
              <span>{formatCurrency(viewCart.cart.total || 0)}</span>
            </div>
            {viewCart.cart.updatedAt && (
              <p className="text-xs text-muted-foreground">Updated {new Date(viewCart.cart.updatedAt).toLocaleString()}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Cart is empty.</p>
        )}
      </DialogContent>
    </Dialog>
    <Dialog open={!!confirmClear} onOpenChange={(o) => { if (!o) setConfirmClear(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden sm:max-h-none sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Delete Cart</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete this customer&apos;s cart
          {confirmClear?.email ? ` (${confirmClear.email})` : ""}? This action cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmClear(null)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!confirmClear) return;
              try {
                const res = await fetch(`/api/admin/carts/${confirmClear.id}/clear`, { method: "POST" });
                if (!res.ok) {
                  const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                  throw new Error(j?.error || "Failed to clear cart");
                }
                toast.success("Cart cleared");
                setConfirmClear(null);
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Failed to clear cart";
                toast.error(message);
              }
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!archiveFor} onOpenChange={(open) => {
      if (!open && !archiveSubmitting) {
        setArchiveFor(null);
        setArchiveReason("");
      }
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {archiveFor?.archived ? "Unarchive account" : "Archive account"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {archiveFor?.archived
              ? "This will return the account to active customer workflows."
              : "This will keep the customer history but remove the account from active customer workflows."}
            {archiveFor?.email ? ` Customer: ${archiveFor.email}.` : ""}
          </p>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Reason or note</label>
            <Input
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              placeholder="Optional audit note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={archiveSubmitting} onClick={() => setArchiveFor(null)}>
            Cancel
          </Button>
          <Button
            variant={archiveFor?.archived ? "secondary" : "destructive"}
            disabled={archiveSubmitting}
            onClick={async () => {
              if (!archiveFor) return;
              setArchiveSubmitting(true);
              try {
                const targetArchived = !archiveFor.archived;
                const res = await fetch(`/api/admin/users/${archiveFor.userId}/archive`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    archived: targetArchived,
                    reason: archiveReason.trim() || undefined,
                    sourcePage: "admin/customers",
                  }),
                });
                if (!res.ok) {
                  const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                  throw new Error(j?.error || "Failed to update archive status");
                }
                toast.success(targetArchived ? "Account archived" : "Account unarchived");
                setArchiveFor(null);
                setArchiveReason("");
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : "Failed to update archive status";
                toast.error(message);
              } finally {
                setArchiveSubmitting(false);
              }
            }}
          >
            {archiveFor?.archived ? "Unarchive" : "Archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!closeFor} onOpenChange={(open) => {
      if (!open && !closeSubmitting) {
        setCloseFor(null);
        setCloseConfirmText("");
        setCloseReason("");
        setCloseReasonDetail("");
        setCloseErrors({});
      }
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Close account</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Permanently close this unused customer account
            {closeFor?.email ? ` (${closeFor.email})` : ""}. This cannot be undone.
          </p>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Type &quot;{closeFor?.email || "CLOSE ACCOUNT"}&quot; to confirm
            </label>
            <Input
              value={closeConfirmText}
              onChange={(e) => {
                setCloseConfirmText(e.target.value);
                if (closeErrors.confirmText) setCloseErrors((prev) => ({ ...prev, confirmText: "" }));
              }}
              placeholder={closeFor?.email || "CLOSE ACCOUNT"}
              aria-invalid={!!closeErrors.confirmText}
              className={closeErrors.confirmText ? "border-red-500" : undefined}
            />
            {closeErrors.confirmText && <p className="text-xs text-red-600">{closeErrors.confirmText}</p>}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Closure reason</label>
            <select
              className={`h-9 w-full rounded border bg-background px-2 text-sm ${closeErrors.reason ? "border-red-500" : ""}`}
              value={closeReason}
              onChange={(e) => {
                setCloseReason(e.target.value);
                if (closeErrors.reason) setCloseErrors((prev) => ({ ...prev, reason: "" }));
              }}
            >
              <option value="">Select reason</option>
              <option value="Customer request">Customer request</option>
              <option value="Duplicate account">Duplicate account</option>
              <option value="Fraud or abuse">Fraud or abuse</option>
              <option value="Other">Other</option>
            </select>
            {closeErrors.reason && <p className="text-xs text-red-600">{closeErrors.reason}</p>}
            <Input
              value={closeReasonDetail}
              onChange={(e) => setCloseReasonDetail(e.target.value)}
              placeholder={closeReason === "Other" ? "Required details" : "Optional details"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={closeSubmitting} onClick={() => setCloseFor(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={closeSubmitting}
            onClick={async () => {
              if (!closeFor) return;
              const expected = (closeFor.email || "CLOSE ACCOUNT").trim().toLowerCase();
              const typed = closeConfirmText.trim().toLowerCase();
              const detail = closeReasonDetail.trim();
              const nextErrors: { confirmText?: string; reason?: string } = {};
              if (typed !== expected) nextErrors.confirmText = "Confirmation text does not match.";
              if (!closeReason) nextErrors.reason = "Select a closure reason.";
              if (closeReason === "Other" && detail.length < 5) nextErrors.reason = "Enter details for Other.";
              if (Object.keys(nextErrors).length > 0) {
                setCloseErrors(nextErrors);
                return;
              }
              setCloseSubmitting(true);
              try {
                const reason = closeReason === "Other"
                  ? detail
                  : detail
                    ? `${closeReason}: ${detail}`
                    : closeReason;
                const res = await fetch(`/api/admin/users/${closeFor.userId}/close`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ reason, sourcePage: "admin/customers" }),
                });
                if (!res.ok) {
                  const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                  throw new Error(j?.error || "Failed to close account");
                }
                toast.success("Account closed");
                setCloseFor(null);
                setCloseConfirmText("");
                setCloseReason("");
                setCloseReasonDetail("");
                setCloseErrors({});
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : "Failed to close account";
                toast.error(message);
              } finally {
                setCloseSubmitting(false);
              }
            }}
          >
            Close account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!refundCredit} onOpenChange={(open) => {
      if (!open) {
        setRefundCredit(null);
        setRefundAmount("");
        setRefundAll(true);
        setRefundErrors({});
      }
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Refund Store Credit</DialogTitle>
        </DialogHeader>
        {refundCredit && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Customer: <span className="font-medium">{refundCredit.email}</span>
            </p>
            <p className="text-muted-foreground">
              Available store credit: <span className="font-semibold">{formatCurrency(refundCredit.credit)}</span>
            </p>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3 w-3"
                  checked={refundAll}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setRefundAll(checked);
                    if (checked && refundCredit) {
                      setRefundAmount(refundCredit.credit.toFixed(2));
                    }
                  }}
                />
                Refund full store credit
              </label>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Amount to refund</label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={refundAmount}
                onChange={(e) => {
                  setRefundAmount(e.target.value);
                  if (refundErrors.amount) setRefundErrors((prev) => ({ ...prev, amount: "" }));
                }}
                disabled={refundAll}
                aria-invalid={!!refundErrors.amount}
                className={refundErrors.amount ? "border-red-500" : undefined}
              />
              {refundErrors.amount && <p className="text-xs text-red-600">{refundErrors.amount}</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Method</label>
              <Select value={refundMethod} onValueChange={(val) => setRefundMethod(val as "cash" | "transfer")}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="transfer">MoMo transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              placeholder="Reference (optional)"
              value={refundRef}
              onChange={(e) => setRefundRef(e.target.value)}
            />
            <Input
              placeholder="Reason (min 5 chars)"
              value={refundNote}
              onChange={(e) => {
                setRefundNote(e.target.value);
                if (refundErrors.note) setRefundErrors((prev) => ({ ...prev, note: "" }));
              }}
              aria-invalid={!!refundErrors.note}
              className={refundErrors.note ? "border-red-500" : undefined}
            />
            {refundErrors.note && <p className="text-xs text-red-600">{refundErrors.note}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRefundCredit(null)} disabled={refundSubmitting}>Cancel</Button>
              <Button
                onClick={async () => {
                  if (!refundCredit) return;
                  if (!refundCredit.userId) {
                    toast.error("Missing customer id");
                    return;
                  }
                  const value = Number(refundAmount);
                  if (!value || isNaN(value) || value <= 0) {
                    setRefundErrors((prev) => ({ ...prev, amount: "Enter a valid refund amount." }));
                    return;
                  }
                  if (refundNote.trim().length < 5) {
                    setRefundErrors((prev) => ({ ...prev, note: "Please add a brief reason (min 5 chars)." }));
                    return;
                  }
                  if (value > refundCredit.credit + 0.0001) {
                    setRefundErrors((prev) => ({ ...prev, amount: "Amount exceeds customer's credit." }));
                    return;
                  }
                  try {
                    setRefundSubmitting(true);
                    const res = await fetch(`/api/admin/customers/${refundCredit.userId}/refund-credit`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        amount: value,
                        method: refundMethod,
                        reference: refundRef || undefined,
                        note: refundNote || undefined,
                        userId: refundCredit.userId,
                      }),
                    });
                    if (!res.ok) {
                      const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                      throw new Error(j?.error || "Failed to refund credit");
                    }
                    toast.success("Credit refunded successfully");
                    setRefundCredit(null);
                    setRefundAmount("");
                    setRefundErrors({});
                    queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                  } catch (e: unknown) {
                    const message =
                      e instanceof Error ? e.message : "Failed to refund credit";
                    toast.error(message);
                  } finally {
                    setRefundSubmitting(false);
                  }
                }}
                disabled={refundSubmitting}
              >
                Refund
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
    {/* Add Payment (across orders) */}
    <Dialog
      open={!!addPaymentFor}
      onOpenChange={(open) => {
        if (!open) {
          setAddPaymentFor(null);
          setAddPaymentAmount("");
          setAddPaymentMethod("");
          setAddPaymentNote("");
          setAddPaymentErrors({});
          setAddPaymentOpenOrders([]);
          setAddPaymentOrdersError("");
          setAddPaymentOrdersLoading(false);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Add Payment (apply to oldest orders)</DialogTitle>
        </DialogHeader>
        {addPaymentFor && (() => {
          const row = rows.find((r) => r.user.id === addPaymentFor.userId);
          const outstanding = row
            ? Math.max(
                0,
                Number(row.ordersTotal || 0) - Number(row.paidTotal || 0),
              )
            : 0;
          return (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Customer:{" "}
                <span className="font-medium">
                  {addPaymentFor.email || addPaymentFor.userId}
                </span>
              </p>
              <p className="text-muted-foreground">
                Total outstanding balance across all open orders (unpaid or partially‑paid):{" "}
                <span className="font-semibold">
                  {formatCurrency(outstanding)}
                </span>
              </p>
              <div className="space-y-1">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Amount to apply"
                    value={addPaymentAmount}
                    onChange={(e) => {
                      setAddPaymentAmount(e.target.value);
                      if (addPaymentErrors.amount) setAddPaymentErrors((prev) => ({ ...prev, amount: "" }));
                    }}
                    aria-invalid={!!addPaymentErrors.amount}
                    className={addPaymentErrors.amount ? "border-red-500" : undefined}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={outstanding <= 0}
                    onClick={() =>
                      setAddPaymentAmount(outstanding.toFixed(2))
                    }
                  >
                    Use full balance
                  </Button>
                </div>
                {addPaymentErrors.amount ? (
                  <p className="text-xs text-red-600">{addPaymentErrors.amount}</p>
                ) : null}
              </div>
              <div className="rounded-md border p-3 space-y-2">
                <div className="text-xs font-medium">Allocation preview (oldest orders first)</div>
                {addPaymentOrdersLoading ? (
                  <div className="text-xs text-muted-foreground">Loading open orders…</div>
                ) : addPaymentOrdersError ? (
                  <div className="text-xs text-red-600">{addPaymentOrdersError}</div>
                ) : addPaymentOpenOrders.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No open orders available for allocation.</div>
                ) : addPaymentAllocationPreview.allocations.length === 0 ? (
                  <div className="text-xs text-muted-foreground">Enter amount to preview allocations.</div>
                ) : (
                  <>
                    <div className="space-y-1 text-xs">
                      {addPaymentAllocationPreview.allocations.map((entry) => (
                        <div
                          key={`alloc-${entry.orderId}`}
                          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-start"
                        >
                          <span className="min-w-0 truncate">Order {formatIdReadable(entry.orderId)}</span>
                          <span className="text-right break-words">
                            {formatCurrency(entry.apply)} ({formatCurrency(entry.previousBalance)} → {formatCurrency(entry.remainingAfter)})
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="border-t pt-2 text-xs flex items-center justify-between">
                      <span>Total to allocate</span>
                      <span className="font-medium">
                        {formatCurrency(
                          addPaymentAllocationPreview.allocations.reduce(
                            (sum, e) => sum + Number(e.apply || 0),
                            0,
                          ),
                        )}
                      </span>
                    </div>
                    {addPaymentAllocationPreview.unallocated > 0.005 ? (
                      <div className="text-xs text-amber-700">
                        Unallocated remainder: {formatCurrency(addPaymentAllocationPreview.unallocated)} (exceeds current open order balances).
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Method
                </label>
                <Select
                  value={addPaymentMethod || undefined}
                  onValueChange={(val) => {
                    setAddPaymentMethod(val as "" | "cash" | "transfer");
                    if (addPaymentErrors.method) {
                      setAddPaymentErrors((prev) => ({ ...prev, method: "" }));
                    }
                  }}
                >
                  <SelectTrigger className={`h-9 ${addPaymentErrors.method ? "border-red-500" : ""}`}>
                    <SelectValue placeholder="Select payment method" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="transfer">MoMo transfer</SelectItem>
                  </SelectContent>
                </Select>
                {addPaymentErrors.method ? (
                  <p className="text-xs text-red-600">{addPaymentErrors.method}</p>
                ) : null}
              </div>
              <Input
                placeholder="Note (optional)"
                value={addPaymentNote}
                onChange={(e) => setAddPaymentNote(e.target.value)}
              />
              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    variant="outline"
                    disabled={addPaymentSubmitting}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  onClick={async () => {
                    if (!addPaymentFor) return;
                    const row = rows.find(
                      (r) => r.user.id === addPaymentFor.userId,
                    );
                    const outstanding = row
                      ? Math.max(
                          0,
                          Number(row.ordersTotal || 0) -
                            Number(row.paidTotal || 0),
                        )
                      : 0;
                    const value = Number(addPaymentAmount);
                    if (!value || isNaN(value) || value <= 0) {
                      setAddPaymentErrors((prev) => ({ ...prev, amount: "Enter a valid payment amount." }));
                      return;
                    }
                    if (!addPaymentMethod) {
                      setAddPaymentErrors((prev) => ({ ...prev, method: "Select payment method." }));
                      return;
                    }
                    if (value > outstanding + 0.0001) {
                      setAddPaymentErrors((prev) => ({ ...prev, amount: "Amount exceeds outstanding balance." }));
                      return;
                    }
                    try {
                      setAddPaymentSubmitting(true);
                      await createUserPayment({
                        userId: addPaymentFor.userId,
                        amount: value,
                        method: addPaymentMethod,
                        note: addPaymentNote,
                        location: "admin/customers:actions-add-payment",
                      });
                      toast.success("Payment recorded and applied to orders.");
                      setAddPaymentFor(null);
                      setAddPaymentAmount("");
                      setAddPaymentMethod("");
                      setAddPaymentNote("");
                      setAddPaymentErrors({});
                      queryClient.invalidateQueries({
                        queryKey: ["admin", "customers"],
                      });
                    } catch (e: unknown) {
                      const message =
                        e instanceof Error
                          ? e.message
                          : "Failed to record payment";
                      toast.error(message);
                    } finally {
                      setAddPaymentSubmitting(false);
                    }
                  }}
                  disabled={addPaymentSubmitting}
                >
                  Confirm Payment
                </Button>
              </DialogFooter>
            </div>
          );
        })()}
      </DialogContent>
    </Dialog>
    {/* Manual adjustment */}
    <Dialog
      open={!!adjustFor}
      onOpenChange={(open) => {
        if (!open) {
          setAdjustFor(null);
          setAdjustAmount("");
          setAdjustNote("");
          setAdjustErrors({});
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Issue store credit</DialogTitle>
        </DialogHeader>
        {adjustFor && (() => {
          const row = rows.find((r) => r.user.id === adjustFor.userId);
          const outstanding = row
            ? Math.max(
                0,
                Number(row.ordersTotal || 0) - Number(row.paidTotal || 0),
              )
            : 0;
          return (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Customer:{" "}
                <span className="font-medium">
                  {adjustFor.email || adjustFor.userId}
                </span>
              </p>
              <p className="text-muted-foreground">
                Current outstanding balance:{" "}
                <span className="font-semibold">
                  {formatCurrency(outstanding)}
                </span>
              </p>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="Store credit amount"
                value={adjustAmount}
                onChange={(e) => {
                  setAdjustAmount(e.target.value);
                  if (adjustErrors.amount) setAdjustErrors((prev) => ({ ...prev, amount: "" }));
                }}
                aria-invalid={!!adjustErrors.amount}
                className={adjustErrors.amount ? "border-red-500" : undefined}
              />
              {adjustErrors.amount && <p className="text-xs text-red-600">{adjustErrors.amount}</p>}
              <Input
                placeholder="Reason / note (min 5 chars)"
                value={adjustNote}
                onChange={(e) => {
                  setAdjustNote(e.target.value);
                  if (adjustErrors.note) setAdjustErrors((prev) => ({ ...prev, note: "" }));
                }}
                aria-invalid={!!adjustErrors.note}
                className={adjustErrors.note ? "border-red-500" : undefined}
              />
              {adjustErrors.note && <p className="text-xs text-red-600">{adjustErrors.note}</p>}
              <p className="text-xs text-muted-foreground">
                This creates unapplied store credit for the customer. Use{" "}
                <strong>Apply to Balance</strong> from the Actions menu afterwards
                if the credit should settle oldest unpaid orders.
              </p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={adjustSubmitting}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  onClick={async () => {
                    if (!adjustFor) return;
                    const value = Number(adjustAmount);
                    if (!value || isNaN(value) || value <= 0) {
                      setAdjustErrors((prev) => ({ ...prev, amount: "Enter a valid adjustment amount." }));
                      return;
                    }
                    if (adjustNote.trim().length < 5) {
                      setAdjustErrors((prev) => ({ ...prev, note: "Please add a brief reason (min 5 chars)." }));
                      return;
                    }
                    try {
                      setAdjustSubmitting(true);
                      await createUserPayment({
                        userId: adjustFor.userId,
                        amount: value,
                        method: "adjustment",
                        note: adjustNote,
                        location: "admin/customers:actions-adjustment",
                        refundDisposition: "credit",
                      });
                      toast.success("Store credit issued.");
                      setAdjustFor(null);
                      setAdjustAmount("");
                      setAdjustNote("");
                      setAdjustErrors({});
                      queryClient.invalidateQueries({
                        queryKey: ["admin", "customers"],
                      });
                    } catch (e: unknown) {
                      const message =
                        e instanceof Error
                          ? e.message
                          : "Failed to record adjustment";
                      toast.error(message);
                    } finally {
                      setAdjustSubmitting(false);
                    }
                  }}
                  disabled={adjustSubmitting}
                >
                  Issue credit
                </Button>
              </DialogFooter>
            </div>
          );
        })()}
      </DialogContent>
    </Dialog>
    {/* Credit limit */}
    <Dialog
      open={!!creditLimitFor}
      onOpenChange={(open) => {
        if (!open) {
          setCreditLimitFor(null);
          setCreditLimitValue("");
          setCreditLimitError("");
          setCreditLimitSubmitting(false);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Set credit limit</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Credit limits place new orders on hold once outstanding balances exceed the limit.
          </p>
          <div className="space-y-2">
            <label className="text-xs uppercase text-muted-foreground">
              Limit for {creditLimitFor?.email || "customer"}
            </label>
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00 (no limit)"
              value={creditLimitValue}
              onChange={(e) => {
                setCreditLimitValue(e.target.value);
                if (creditLimitError) setCreditLimitError("");
              }}
              aria-invalid={!!creditLimitError}
              className={creditLimitError ? "border-red-500" : undefined}
            />
            {creditLimitError && (
              <p className="text-xs text-red-600">{creditLimitError}</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={creditLimitSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={creditLimitSubmitting}
            onClick={async () => {
              if (!creditLimitFor) return;
              const raw = creditLimitValue.trim();
              const value = raw === "" ? 0 : Number(raw);
              if (!Number.isFinite(value) || value < 0) {
                setCreditLimitError("Enter a valid non-negative number.");
                return;
              }
              setCreditLimitSubmitting(true);
              try {
                const res = await fetch(
                  `/api/admin/customers/${creditLimitFor.userId}/credit-limit`,
                  {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ creditLimit: value }),
                  },
                );
                const j = await res.json().catch(() => ({} as { error?: string }));
                if (!res.ok) {
                  throw new Error(j?.error || "Failed to update credit limit");
                }
                toast.success("Credit limit updated.");
                setCreditLimitFor(null);
                setCreditLimitValue("");
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Failed to update credit limit";
                toast.error(message);
              } finally {
                setCreditLimitSubmitting(false);
              }
            }}
          >
            Save limit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Commerce profile */}
    <Dialog
      open={!!profileFor}
      onOpenChange={(open) => {
        if (!open) {
          setProfileFor(null);
          setProfileValue("B2B");
          setProfileLoading(false);
          setProfileSubmitting(false);
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Set commerce profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Controls customer feature access. B2B enables clinic procurement workflows; B2C uses the retail flow only.
          </p>
          <div className="space-y-2">
            <label className="text-xs uppercase text-muted-foreground">
              Profile for {profileFor?.email || "customer"}
            </label>
            <Select
              value={profileValue}
              onValueChange={(value) => setProfileValue(value as CustomerProfileType)}
              disabled={profileLoading}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="B2B">B2B</SelectItem>
                <SelectItem value="B2C">B2C</SelectItem>
              </SelectContent>
            </Select>
            {profileLoading && (
              <p className="text-xs text-muted-foreground">Loading current profile...</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={profileSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={profileSubmitting || profileLoading || !profileFor}
            onClick={async () => {
              if (!profileFor) return;
              setProfileSubmitting(true);
              try {
                const res = await fetch(`/api/admin/customers/${profileFor.userId}/profile`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ profile: profileValue }),
                });
                const body = (await res.json().catch(() => ({}))) as { error?: string };
                if (!res.ok) throw new Error(body.error || "Failed to update customer profile.");
                toast.success(`Commerce profile updated to ${profileValue}.`);
                setProfileFor(null);
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : "Failed to update customer profile.";
                toast.error(message);
              } finally {
                setProfileSubmitting(false);
              }
            }}
          >
            Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Explain totals dialog */}
    <Dialog open={!!explain} onOpenChange={(o) => { if (!o) setExplain(null); }}>
      <DialogContent className="max-w-2xl max-h-[85svh] overflow-y-auto sm:max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Explain Totals {explain?.email ? `for ${explain.email}` : ""}</DialogTitle>
        </DialogHeader>
        {explain && (
          <ExplainTotals
            userId={explain.userId}
            paymentsTotal={explain.paymentsTotal}
            paidTotal={explain.paidTotal}
            ordersTotal={explain.ordersTotal}
            storeCredit={explain.storeCredit}
            refundedCash={explain.refundedCash}
            balance={explain.balance}
            canBackfillOrderLinks={actionPermissions.canManageCredit}
          />
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

export default function AdminCustomersPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8 max-w-4xl">
          <h1 className="text-2xl font-semibold mb-4">Customers</h1>
          <p className="text-sm text-muted-foreground">Loading customers…</p>
        </section>
      }
    >
      <AdminCustomersContent />
    </Suspense>
  );
}

function PaymentsSummaryButton(props: { month: string; method: string; status: string; total: number; count: number }) {
  const { month, method, status, total, count } = props;
  const [open, setOpen] = useState(false);
  const showBreakdown = !method;

  const cashSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "cash", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "cash");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const cardSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "card", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "card");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const transferSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "transfer", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "transfer");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const adjustmentSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "adjustment", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "adjustment");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const breakdown = [
    { m: "cash" as const, q: cashSummary },
    { m: "card" as const, q: cardSummary },
    { m: "transfer" as const, q: transferSummary },
    { m: "adjustment" as const, q: adjustmentSummary },
  ];

  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip content="Click for more info">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} title="Click for breakdown">
            Payments Total: {formatCurrency(total)} ({count})
          </Button>
        </Tooltip>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Payments Summary</DialogTitle>
          </DialogHeader>
          <div className="text-xs text-muted-foreground mb-2">
            Month: <strong>{month}</strong> • Method: <strong>{method || 'All'}</strong> • Status: <strong>{status || 'All'}</strong>
          </div>
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between"><span>Payments Total</span><span className="font-mono tabular-nums">{formatCurrency(total)} ({count})</span></div>
            {method ? null : (
              <div className="rounded border">
                <div className="px-3 py-2 text-xs text-muted-foreground border-b">Breakdown by method</div>
                <div className="p-3 grid gap-1">
                  {(() => {
                    const knownTotal = breakdown.reduce((s, b) => s + Number(b.q.data?.total || 0), 0);
                    const knownCount = breakdown.reduce((s, b) => s + Number(b.q.data?.count || 0), 0);
                    const otherTotal = Math.max(0, Number(total || 0) - knownTotal);
                    const otherCount = Math.max(0, Number(count || 0) - knownCount);
                    return (
                      <>
                        {breakdown.map(({ m, q }) => (
                          <div key={m} className="flex justify-between text-sm">
                            <span className="capitalize">{m}</span>
                            <span className="font-mono tabular-nums">{formatCurrency(Number(q.data?.total || 0))} ({Number(q.data?.count || 0)})</span>
                          </div>
                        ))}
                        {(otherTotal > 0 || otherCount > 0) && (
                          <div className="flex justify-between text-sm">
                            <span>Other/Unspecified</span>
                            <span className="font-mono tabular-nums">{formatCurrency(otherTotal)} ({otherCount})</span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ExplainTotals({
  userId,
  paymentsTotal,
  paidTotal,
  ordersTotal,
  storeCredit,
  refundedCash,
  balance,
  canBackfillOrderLinks,
}: {
  userId: string;
  paymentsTotal: number;
  paidTotal: number;
  ordersTotal: number;
  storeCredit: number;
  refundedCash: number;
  balance: number;
  canBackfillOrderLinks: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: payData, error: payErr, isFetching: fetchingPayments } = useClientQuery({
    queryKey: ["admin", "payments", "by-user", userId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/payments/user/${userId}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load payments (${r.status})`);
      return j as { payments: PaymentRow[]; total: number };
    },
  });
  const { data: balData } = useClientQuery({
    queryKey: ["admin", "customer-balance", userId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/customers/${userId}/balance`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load balance (${r.status})`);
      return j as { storeCredit: number; cashRefunds: number; balance: number; ordersTotal: number; paidTotal: number };
    },
  });
  const { data: ordData, error: ordErr, isFetching: fetchingOrders } = useClientQuery({
    queryKey: ["admin", "orders", "summary", userId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/orders/user/${userId}/summary`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load order summary (${r.status})`);
      return j as { ordersTotal: number; paidTotal: number; balance: number };
    },
  });

  const list: PaymentRow[] = useMemo(() => payData?.payments ?? [], [payData]);
  const paymentsSum = Number(payData?.total ?? paymentsTotal ?? 0);
  const paidSum = Number(ordData?.paidTotal ?? paidTotal ?? 0);
  const ordersSum = Number(ordData?.ordersTotal ?? ordersTotal ?? 0);
  const balanceSum = Number(ordData?.balance ?? balance ?? 0);
  const ledgerGap = Math.max(0, paymentsSum - paidSum);
  const [ledgerRange, setLedgerRange] = useState<"all" | "30" | "90">("all");
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [manualOrderIds, setManualOrderIds] = useState("");
  const [manualLinkBusy, setManualLinkBusy] = useState(false);

  const appliedOrderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of list) {
      if (Array.isArray(p.applied)) {
        for (const a of p.applied) {
          if (a.orderId) ids.add(String(a.orderId));
        }
      }
    }
    return Array.from(ids);
  }, [list]);
  const hasAppliedOrders = appliedOrderIds.length > 0;

  const ledgerList = useMemo(() => {
    if (ledgerRange === "all") return list;
    const days = ledgerRange === "30" ? 30 : 90;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return list.filter((p) => new Date(p.createdAt).getTime() >= cutoff);
  }, [list, ledgerRange]);

  const formatMethod = (p: PaymentRow) => {
    const raw =
      p.meta?.method ||
      (p.meta?.reference === "AUTO_APPLY" ? "Auto apply" : "") ||
      (p.status || "");
    const value = String(raw || "").toLowerCase();
    if (!value) return "—";
    if (value === "momo") return "MoMo";
    if (value === "auto apply") return "Auto apply";
    return value.replace(/^\w/, (c) => c.toUpperCase());
  };

  return (
    <div className="grid gap-4">
      {/* Section A: snapshot – matches Customers row */}
      <div className="border-b pb-3">
        <h4 className="text-sm font-semibold mb-2">
          Current summary (live orders + payments)
        </h4>
        {canBackfillOrderLinks && hasAppliedOrders && ordersSum <= 0.005 ? (
          <div className="mb-2 rounded-md border border-amber-200 bg-amber-50/60 p-2 text-xs text-amber-900">
            This customer has payments applied to orders that are not linked to their account,
            so current order totals show as zero. You can backfill order links below.
          </div>
        ) : null}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Orders (net of returns)</div>
            <div className="font-mono tabular-nums font-semibold">
              {formatCurrency(ordersSum)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Paid (sum of amountPaid)</div>
            <div className="font-mono tabular-nums font-semibold">
              {formatCurrency(paidSum)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Payments (ledger total)</div>
            <div className="font-mono tabular-nums font-semibold">
              {formatCurrency(paymentsSum)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Store credit (available)</div>
            <div className="font-mono tabular-nums font-semibold text-amber-700">
              {formatCurrency(Number(balData?.storeCredit ?? storeCredit))}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Refunded (cash)</div>
            <div className="font-mono tabular-nums font-semibold text-rose-700">
              {formatCurrency(Number(balData?.cashRefunds ?? refundedCash))}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Balance (orders – paid)</div>
            <div className="font-mono tabular-nums font-semibold text-red-700">
              {formatCurrency(balanceSum)}
            </div>
          </div>
        </div>
        {hasAppliedOrders && ordersSum <= 0.005 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={backfillBusy}
              onClick={async () => {
                try {
                  setBackfillBusy(true);
                  const res = await fetch(`/api/admin/customers/${userId}/backfill-orders`, {
                    method: "POST",
                  });
                  const payload = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(payload?.error || "Backfill failed.");
                  toast.success(`Linked ${payload.linked} order(s) to this customer.`);
                  if (payload.skippedDifferentUser > 0) {
                    toast.info(`${payload.skippedDifferentUser} order(s) were linked to another user and skipped.`);
                  }
                  queryClient.invalidateQueries({ queryKey: ["admin", "orders", "summary", userId] });
                  queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : "Backfill failed.";
                  toast.error(msg);
                } finally {
                  setBackfillBusy(false);
                }
              }}
            >
              {backfillBusy ? "Linking orders..." : "Backfill order links"}
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={manualOrderIds}
                onChange={(e) => setManualOrderIds(e.target.value)}
                placeholder="Paste order ID(s) or invoice number(s)"
                className="h-8 w-72 text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={manualLinkBusy}
                onClick={async () => {
                  const raw = manualOrderIds
                    .split(/[\s,;]+/g)
                    .map((v) => v.trim())
                    .filter(Boolean);
                  if (raw.length === 0) {
                    toast.error("Enter at least one order ID.");
                    return;
                  }
                  try {
                    setManualLinkBusy(true);
                    const res = await fetch(`/api/admin/customers/${userId}/backfill-orders`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ orderIds: raw }),
                    });
                    const payload = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(payload?.error || "Link failed.");
                    toast.success(`Linked ${payload.linked} order(s) to this customer.`);
                    if (payload.skippedDifferentUser > 0) {
                      toast.info(`${payload.skippedDifferentUser} order(s) were linked to another user and skipped.`);
                    }
                    if (payload.missingOrders > 0) {
                      toast.info(`${payload.missingOrders} order(s) were not found.`);
                    }
                    queryClient.invalidateQueries({ queryKey: ["admin", "orders", "summary", userId] });
                    queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                  } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : "Link failed.";
                    toast.error(msg);
                  } finally {
                    setManualLinkBusy(false);
                  }
                }}
              >
                {manualLinkBusy ? "Linking..." : "Link order(s)"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Section B: lifetime ledger */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h4 className="text-sm font-semibold">Lifetime payment ledger</h4>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground" title="Filters the ledger table below; lifetime totals above are always shown in full">Table range:</span>
            <Button size="sm" variant={ledgerRange === "30" ? "default" : "outline"} onClick={() => setLedgerRange("30")}>
              Last 30 d
            </Button>
            <Button size="sm" variant={ledgerRange === "90" ? "default" : "outline"} onClick={() => setLedgerRange("90")}>
              Last 90 d
            </Button>
            <Button size="sm" variant={ledgerRange === "all" ? "default" : "outline"} onClick={() => setLedgerRange("all")}>
              All
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Lifetime payments total</div>
            <div className="font-mono tabular-nums font-semibold">
              {formatCurrency(paymentsSum)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Lifetime amountPaid on orders</div>
            <div className="font-mono tabular-nums font-semibold">
              {formatCurrency(paidSum)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">
              <div className="inline-flex items-center gap-1">
                <span>Unapplied funds (payments – amountPaid)</span>
                <Tooltip content="Payments that did not land on an order yet (e.g., store credit issuance or adjustments).">
                  <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Unapplied funds" />
                </Tooltip>
              </div>
            </div>
            <div className="font-mono tabular-nums font-semibold text-amber-700">
              {formatCurrency(ledgerGap)}
            </div>
          </div>
          <div className="rounded border p-3 text-center break-words">
            <div className="text-muted-foreground">Refunded (cash)</div>
            <div className="font-mono tabular-nums font-semibold text-rose-700">
              {formatCurrency(
                list
                  .filter((p) => {
                    const status = String(
                      p.status || p.meta?.status || "",
                    ).toUpperCase();
                    const disposition = String(
                      p.refundDisposition || p.meta?.refundDisposition || "",
                    ).toUpperCase();
                    return status === "REFUND" && disposition === "CASH";
                  })
                  .reduce(
                    (sum: number, p) =>
                      sum + Math.abs(Number(p.amount || 0)),
                    0,
                  ),
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${chipToneClass("warning")}`} />
            Store credit / unapplied
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${chipToneClass("danger")}`} />
            Refunds (cash)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${chipToneClass("danger")}`} />
            Balance due
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Lifetime figures include all historical payments, refunds, and credit
          movements. “Unapplied funds” reflects amounts that did not end up as{" "}
          <code>amountPaid</code> on orders (for example, store-credit issuance
          and internal adjustments). Current store credit and balance are shown
          in the summary above.
        </p>
      </div>

      {/* Per-payment breakdown */}
      <div className="rounded border overflow-hidden">
        <div className="px-3 pt-3 text-xs text-muted-foreground">
          {ledgerRange === "all" ? "Showing all ledger entries." : `Showing last ${ledgerRange} days.`}
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          <Table className="w-full table-auto">
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="text-left">Date</TableHead>
                <TableHead className="text-left">Method</TableHead>
                <TableHead className="text-center">Amount</TableHead>
                <TableHead className="text-left">Applied breakdown</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledgerList.map((p) => (
                (() => {
                  const breakdown = buildAppliedBreakdownDisplay(p);
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="text-left text-sm">
                        {new Date(p.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-left text-xs">
                        {formatMethod(p)}
                      </TableCell>
                      <TableCell className="text-center font-mono tabular-nums">
                        {formatCurrency(Number(p.amount || 0))}
                      </TableCell>
                      <TableCell className="text-left text-xs">
                        {breakdown.entries.length > 0 ? (
                          <div className="space-y-1">
                            <div className="flex flex-wrap gap-1">
                              {breakdown.entries.map((a: PaymentApplied, idx: number) => (
                                <span
                                  key={idx}
                                  className="inline-block bg-muted rounded px-1.5 py-0.5"
                                >
                                  {formatOrderId(a.orderId)}:{" "}
                                  {formatCurrency(Number(a.applied || 0))}
                                </span>
                              ))}
                            </div>
                            {breakdown.unallocated > 0.01 ? (
                              <div className="text-amber-700">
                                Unallocated: {formatCurrency(breakdown.unallocated)}
                              </div>
                            ) : null}
                            {breakdown.overLinked > 0.01 ? (
                              <div className="text-amber-700">
                                Over-linked hidden: {formatCurrency(breakdown.overLinked)}
                              </div>
                            ) : null}
                            {breakdown.hasMismatch ? (
                              <div className="text-amber-700">
                                Applied breakdown mismatch on this row.
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            Store credit (not yet applied to any order)
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })()
              ))}
              {ledgerList.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-sm text-muted-foreground py-4"
                  >
                    {fetchingPayments || fetchingOrders ? (
                      "Loading..."
                    ) : payErr || ordErr ? (
                      "Failed to load details"
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <span>No payments found.</span>
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/orders?userId=${encodeURIComponent(userId)}`}>
                              View orders
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              queryClient.invalidateQueries({ queryKey: ["admin", "payments", "by-user", userId] });
                              queryClient.invalidateQueries({ queryKey: ["admin", "orders", "summary", userId] });
                            }}
                          >
                            Refresh
                          </Button>
                        </div>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function formatOrderId(orderId: string) {
  if (!orderId) return "UNKNOWN";
  const clean = orderId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (clean.length <= 6) return clean || "UNKNOWN";
  const start = clean.slice(0, 3);
  const end = clean.slice(-3);
  return `${start}...${end}`;
}
