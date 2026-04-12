"use client";

export const dynamic = "force-dynamic";

import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { chipToneBorderClass, chipToneClass, orderStatusTone } from "@/lib/status-chips";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useParams } from "next/navigation";
import { formatIdReadable } from "@/lib/utils";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type OrderRow = {
  id: string;
  status: string;
  deliveryStatus?: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  deliveredAt?: string | null;
  items?: Array<{
    id: string;
    quantity: number;
    price: number;
    deliveredQuantity?: number;
    returnedQuantity?: number;
    product?: { name?: string | null } | null;
  }>;
  createdAt: string;
  userId?: string | null;
};

type NormalizedOrderRow = OrderRow & {
  totalPaid: number;
  computedBalance: number;
};

type CustomerProfileSnapshot = {
  userId: string;
  profile: "B2B" | "B2C";
  name?: string | null;
  email?: string | null;
  role?: string | null;
  phone?: string | null;
  archived?: boolean;
  deletedAt?: string | null;
  createdAt?: string | null;
  lastLoginAt?: string | null;
  isEmployeeCustomer?: boolean;
};

type LifecycleAuditRow = {
  id: string;
  action: string;
  outcome?: string | null;
  createdAt: string;
  actor?: {
    id?: string | null;
    email?: string | null;
    name?: string | null;
    role?: string | null;
  } | null;
  meta?: {
    reason?: string | null;
    from?: boolean | null;
    to?: boolean | null;
    blockers?: string[] | null;
    profile?: string | null;
    sourcePage?: string | null;
  } | null;
};

const LIFECYCLE_AUDIT_ACTIONS = new Set([
  "USER_ARCHIVE",
  "USER_UNARCHIVE",
  "USER_CLOSE",
  "USER_CLOSE_DENIED",
  "CUSTOMER_PROFILE_UPDATED",
]);

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function lifecycleActionLabel(action: string) {
  if (action === "USER_ARCHIVE") return "Archived";
  if (action === "USER_UNARCHIVE") return "Restored";
  if (action === "USER_CLOSE") return "Closed";
  if (action === "USER_CLOSE_DENIED") return "Close blocked";
  if (action === "CUSTOMER_PROFILE_UPDATED") return "Profile updated";
  return action.replace(/_/g, " ");
}

function lifecycleActionTone(
  action: string,
  outcome?: string | null,
): "success" | "warning" | "danger" {
  if (outcome === "FAILED" || action === "USER_CLOSE_DENIED") return "danger";
  if (action === "USER_ARCHIVE") return "warning";
  if (action === "USER_CLOSE") return "danger";
  return "success";
}

export default function AdminCustomerReadOnlyView() {
  const params = useParams<{ id: string }>();
  const userId = params.id;

  // Fetch order history via the same endpoint the customer portal uses, scoped by userId for admins
  const { data: ordersData, error } = useClientQuery<{ orders: OrderRow[] }>({
    queryKey: ["admin", "customer-orders", userId],
    queryFn: () => fetcher(`/api/orders/history?userId=${userId}`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  // Admin-facing balance snapshot (includes store credit)
  type AccountSummary = {
    ordersTotal: number;
    paidTotal: number;
    paymentsTotal: number;
    balance: number;
    storeCredit: number;
    cashRefunds: number;
    creditLimit: number;
    updatedAt: string;
  };
  const [accountSummary, setAccountSummary] = useState<AccountSummary | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string | null>(null);
  const [customerProfile, setCustomerProfile] = useState<CustomerProfileSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      if (!userId) return;
      try {
        const res = await fetch(`/api/admin/customers/${userId}/balance`);
        if (!res.ok) return;
        const json = (await res.json().catch(() => null)) as AccountSummary | null;
        if (!cancelled && json) {
          setAccountSummary(json);
        }
      } catch {
        // best-effort; leave summary as-is
      }
    }
    loadBalance();
    const id = setInterval(loadBalance, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    async function loadProfile() {
      try {
        const res = await fetch(
          `/api/admin/customers/${encodeURIComponent(String(userId))}/profile`,
        );
        const json = (await res.json().catch(() => null)) as CustomerProfileSnapshot | null;
        if (cancelled || !json) return;
        setCustomerProfile(json);
        if (json.name) setCustomerName(json.name.trim() || null);
        if (json.email) setCustomerEmail(json.email.trim() || null);
      } catch {
        // best effort
      }
    }
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const {
    data: lifecycleAuditRows,
    error: lifecycleAuditError,
    isFetching: lifecycleAuditLoading,
  } = useClientQuery<LifecycleAuditRow[]>({
    queryKey: ["admin", "customer-lifecycle-audit", userId],
    queryFn: async () => {
      const params = new URLSearchParams({
        customerId: String(userId),
        entityType: "USER",
        limit: "20",
      });
      const res = await fetch(`/api/admin/audit?${params.toString()}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          json && typeof json === "object" && "error" in json
            ? String((json as { error?: unknown }).error || "Failed to load lifecycle history")
            : "Failed to load lifecycle history",
        );
      }
      const rows = Array.isArray(json)
        ? json
        : Array.isArray((json as { items?: unknown } | null)?.items)
          ? ((json as { items: unknown[] }).items)
          : [];
      return rows
        .filter((row): row is LifecycleAuditRow => {
          if (!row || typeof row !== "object") return false;
          const action = String((row as { action?: unknown }).action || "");
          return LIFECYCLE_AUDIT_ACTIONS.has(action);
        })
        .slice(0, 5);
    },
    enabled: Boolean(userId),
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  const rawOrders: OrderRow[] = (ordersData?.orders || []) as OrderRow[];

  // Mirror the customer portal's normalization so totals and balances match exactly.
  const orders: NormalizedOrderRow[] = rawOrders.map((o) => {
    const totalPaid = Number(o.amountPaid ?? 0);
    const computedBalance = Number(
      o.balance ?? Math.max(0, Number(o.total ?? 0) - totalPaid),
    );
    return {
      ...o,
      totalPaid,
      computedBalance,
    };
  });

  const nonCancelledOrders = orders.filter((o) => o.status !== "CANCELLED");
  const ordersTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.total ?? 0),
    0,
  );
  const paidTotal = nonCancelledOrders.reduce(
    (sum, o) => sum + Number(o.totalPaid ?? 0),
    0,
  );
  const balance = Math.max(0, ordersTotal - paidTotal);
  const displayBalance = Number(accountSummary?.balance ?? balance);
  const hasOutstanding = (() => {
    const summaryBalance = Number(accountSummary?.balance ?? 0);
    if (summaryBalance > 0) return true;
    return nonCancelledOrders.some((o) => Number(o.computedBalance ?? 0) > 0);
  })();
  const creditAvailable = Math.max(
    0,
    Number(accountSummary?.storeCredit ?? 0),
  );
  const creditLimit = Math.max(0, Number(accountSummary?.creditLimit ?? 0));
  const accountStatus = customerProfile?.deletedAt
    ? "Closed"
    : customerProfile?.archived
      ? "Archived"
      : "Active";
  const accountStatusTone =
    accountStatus === "Active"
      ? "success"
      : accountStatus === "Archived"
        ? "warning"
        : "danger";
  const recentLifecycleRows = lifecycleAuditRows || [];

  const orderQuery = new URLSearchParams();
  orderQuery.set("userId", String(userId));
  if (customerEmail) {
    orderQuery.set("q", customerEmail);
  } else if (customerName) {
    orderQuery.set("q", customerName);
  }
  const getStatusBadge = (status: string) => chipToneClass(orderStatusTone(status));
  const formatBalance = (value: number) =>
    value > 0 ? formatCurrency(value) : "None";

  if (error) {
    const msg = (error as Error).message || "Error";
    return (
      <section className="container mx-auto py-8 max-w-4xl">
        <h1 className="text-xl font-semibold mb-4">Customer View</h1>
        <p className="text-sm text-red-600">Failed to load orders: {msg}</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 max-w-4xl space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Customer Account View</h1>
          <p className="text-xs">
            <span className="font-semibold">Customer:</span>{" "}
            {customerName || "Unknown name"}
            {customerEmail ? (
              <>
                {" "}
                -{" "}
                <span className="text-muted-foreground">
                  {customerEmail}
                </span>
              </>
            ) : (
              <>
                {" "}
                -{" "}
                <span className="text-muted-foreground">
                  ID: {formatIdReadable(userId)}
                </span>
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            Balance and order history mirrors what the customer sees. Changes must be made
            from the main admin tools.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a
              href={`/admin/audit?customerId=${encodeURIComponent(String(userId))}&entityType=USER&entityId=${encodeURIComponent(String(userId))}&sourcePage=admin/customers/[id]/view`}
            >
              Audit log
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const res = await fetch(
                  `/api/admin/customers/${encodeURIComponent(String(userId))}/reminder/email`,
                  { method: "POST" },
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
            Send reminder
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/api/admin/customers/${encodeURIComponent(
                String(userId),
              )}/statement?format=pdf`}
              target="_blank"
              rel="noreferrer"
            >
              Statement PDF
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link
              href={`/api/admin/customers/${encodeURIComponent(
                String(userId),
              )}/statement?format=csv`}
              target="_blank"
              rel="noreferrer"
            >
              Statement CSV
            </Link>
          </Button>
          <Link
            href={`/admin/customers?focus=${encodeURIComponent(String(userId))}`}
            className="text-xs underline"
          >
            Back to Customers
          </Link>
        </div>
      </header>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Account Status</CardTitle>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chipToneClass(accountStatusTone)}`}
            >
              {accountStatus}
            </span>
          </div>
        </CardHeader>
        <CardContent className="py-3 text-sm space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Commerce profile</div>
              <div className="font-medium">{customerProfile?.profile || "Unknown"}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Role</div>
              <div className="font-medium">{customerProfile?.role || "Unknown"}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Created</div>
              <div className="font-medium">{formatDateTime(customerProfile?.createdAt)}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Last login</div>
              <div className="font-medium">{formatDateTime(customerProfile?.lastLoginAt)}</div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Outstanding balance</div>
              <div className={displayBalance > 0 ? "font-semibold text-red-600" : "font-medium text-green-700"}>
                {formatBalance(displayBalance)}
              </div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Store credit</div>
              <div className="font-medium">{formatCurrency(creditAvailable)}</div>
            </div>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Credit limit</div>
              <div className="font-medium">{creditLimit > 0 ? formatCurrency(creditLimit) : "None"}</div>
            </div>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Recent lifecycle history</h2>
              <a
                href={`/admin/audit?customerId=${encodeURIComponent(String(userId))}&entityType=USER&entityId=${encodeURIComponent(String(userId))}&sourcePage=admin/customers/[id]/view`}
                className="text-xs underline"
              >
                Open full audit log
              </a>
            </div>
            {lifecycleAuditLoading && recentLifecycleRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">Loading lifecycle history...</p>
            ) : lifecycleAuditError ? (
              <p className="text-xs text-muted-foreground">
                Lifecycle history is not available for this admin session.
              </p>
            ) : recentLifecycleRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No lifecycle changes have been recorded for this customer yet.
              </p>
            ) : (
              <div className="space-y-2">
                {recentLifecycleRows.map((row) => {
                  const tone = lifecycleActionTone(row.action, row.outcome);
                  const actor =
                    row.actor?.name ||
                    row.actor?.email ||
                    row.actor?.id ||
                    "System";
                  const blockers = Array.isArray(row.meta?.blockers)
                    ? row.meta?.blockers.filter(Boolean).join(", ")
                    : "";
                  return (
                    <div key={row.id} className="rounded border p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`rounded-full px-2 py-0.5 font-medium ${chipToneClass(tone)}`}>
                          {lifecycleActionLabel(row.action)}
                        </span>
                        <span className="text-muted-foreground">
                          {formatDateTime(row.createdAt)}
                        </span>
                      </div>
                      <div className="mt-2 text-muted-foreground">
                        Actor: <span className="text-foreground">{actor}</span>
                        {row.outcome ? (
                          <>
                            {" "}
                            | Outcome: <span className="text-foreground">{row.outcome}</span>
                          </>
                        ) : null}
                      </div>
                      {row.meta?.reason ? (
                        <div className="mt-1 text-muted-foreground">
                          Reason: <span className="text-foreground">{row.meta.reason}</span>
                        </div>
                      ) : null}
                      {blockers ? (
                        <div className="mt-1 text-muted-foreground">
                          Blockers: <span className="text-foreground">{blockers}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Account Balance</CardTitle>
        </CardHeader>
        <CardContent className="py-3 text-sm space-y-1">
          {hasOutstanding && (
            <div className={`mb-3 border p-3 text-xs !rounded-none ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
              You have an outstanding balance. Please call{" "}
              <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                {ADMIN_PHONE}
              </a>{" "}
              to arrange payment.
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This page shows whether you currently have any outstanding balance or store credit on
            your account. For detailed history, use your order list below.
          </p>
          <div className="flex justify-between">
            <span>Outstanding balance</span>
            <span className={displayBalance > 0 ? "font-semibold text-red-600" : "font-medium text-green-700"}>
              {formatBalance(displayBalance)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Credit limit</span>
            <span className="font-medium text-muted-foreground">
              {creditLimit > 0 ? formatCurrency(creditLimit) : "None"}
            </span>
          </div>
          {creditAvailable > 0 && (
            <div className="mt-3">
              <p className={`text-xs rounded border px-2 py-1 ${chipToneClass("success")} ${chipToneBorderClass("success")}`}>
                Store credit available:{" "}
                <span className="font-semibold">
                  {formatCurrency(creditAvailable)}
                </span>
                . This credit will be used automatically when you place new orders. If you would
                like it applied to an existing outstanding balance, please call{" "}
                <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                  {ADMIN_PHONE}
                </a>
                .
              </p>
            </div>
          )}
          {accountSummary?.updatedAt ? (
            <p className="text-[11px] text-muted-foreground mt-2">
              Last synced: {new Date(accountSummary.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="!border-none !shadow-md !rounded-none">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">
            Orders {orders.length > 0 ? `(${orders.length})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-3">
          {orders.length === 0 ? (
            <div className="text-xs">
              <p className="text-muted-foreground">No orders found for this customer.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href={`/admin/orders?${orderQuery.toString()}`}
                  className="inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
                >
                  View orders
                </Link>
                <Link
                  href="/admin/customers"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
                >
                  Back to customers
                </Link>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="account-balance-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell>{new Date(o.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.total ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(Number(o.totalPaid ?? 0))}
                      </TableCell>
                      <TableCell className={`text-right ${Number(o.computedBalance ?? 0) > 0 ? "text-red-600" : "text-green-700"}`}>
                        {formatCurrency(Number(o.computedBalance ?? 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${getStatusBadge(o.status)}`}>
                          {String(o.status || "").toUpperCase()}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="text-right mt-2">
            <Link href={`/admin/orders?${orderQuery.toString()}`} className="underline text-sm">
              View all orders
            </Link>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
