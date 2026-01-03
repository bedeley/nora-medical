"use client";

export const dynamic = "force-dynamic";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { chipToneClass } from "@/lib/status-chips";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, XCircle } from "lucide-react";
import { useClientQuery } from "@/hooks/use-client-query";

type CustomerUser = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  role: string;
  archived: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};

type CustomerRow = {
  user: CustomerUser;
  ordersTotal: number;
  paidTotal: number;
  paymentsTotal: number;
  delivery: { delivered: number; partial: number; pending: number };
  refundedCash: number;
  lastOrderAt: string | null;
  whatsappReady: boolean;
  phoneVerified: boolean;
};

type CustomersResponse = {
  rows: CustomerRow[];
  partial?: boolean;
};

const fetcher = async <T = CustomersResponse>(u: string): Promise<T> => {
  const r = await fetch(u);
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as T;
};

export default function CustomerAccountsPage() {
  const queryClient = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data, error, isLoading } = useClientQuery<CustomersResponse>({
    queryKey: ["admin", "customers", { includeArchived: includeArchived ? "1" : "0" }],
    queryFn: () => fetcher<CustomersResponse>(`/api/admin/customers?includeArchived=${includeArchived ? "1" : "0"}`),
    refetchInterval: 10000,
  });
  const rows = useMemo<CustomerRow[]>(() => data?.rows ?? [], [data]);
  const [q, setQ] = useState("");
  const [confirmClose, setConfirmClose] = useState<{ id: string; email?: string | null } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<{ id: string; email?: string | null; archived: boolean } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [closeReason, setCloseReason] = useState("");
  const [closeReasonDetail, setCloseReasonDetail] = useState("");
  const [closeErrors, setCloseErrors] = useState<{ confirmText?: string; reason?: string }>({});
  // Tick every minute to ensure days-since value stays fresh without relying on server refresh
  const [nowTick, setNowTick] = useState<number>(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const formatDaysAgo = (iso: string | null | undefined) => {
    if (!iso) return "-";
    const days = Math.max(0, Math.floor((nowTick - new Date(iso).getTime()) / (1000 * 60 * 60 * 24)));
    if (days === 0) return "Today";
    return days === 1 ? "1 day ago" : `${days} days ago`;
  };

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(
      (r) => (r.user?.email || "").toLowerCase().includes(query) || (r.user?.name || "").toLowerCase().includes(query)
    );
  }, [rows, q]);

  return (
    <div className="container mx-auto py-8 max-w-6xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customer Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Manage access, archive status, and account history.
          </p>
        </div>
      </div>
      <Card className="shadow-sm">
        <CardHeader className="py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Input
            className="h-9 w-full max-w-sm"
            placeholder="Search by name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
        </CardContent>
      </Card>

      {/* Loading / error state */}
      {isLoading && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading customers...</p>
      ) : error ? (
        <div className="rounded-md border p-6 text-sm">
          {(() => {
            const msg = error instanceof Error ? error.message : "Error";
            const unauthorized = /unauthorized/i.test(msg);
            return unauthorized ? (
              <p>Admin access required. Please sign in with an admin account.</p>
            ) : (
              <p>Failed to load customers: {msg}</p>
            );
          })()}
        </div>
      ) : (
        <Card className="shadow-sm">
          <CardHeader className="flex items-center justify-between py-3">
            <CardTitle className="text-base font-semibold">Accounts</CardTitle>
            <span className="text-xs text-muted-foreground">{filtered.length} shown</span>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Name</TableHead>
                <TableHead className="text-center">Email</TableHead>
                <TableHead className="text-center">Phone</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-center">Account Created</TableHead>
                <TableHead className="text-center">Last Login</TableHead>
                <TableHead className="text-center">Last Order</TableHead>
                <TableHead className="text-center">Days Ago</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.user.id} className={r.user.archived ? "bg-muted/20" : ""}>
                  <TableCell className="text-center">{r.user.name || "Unnamed"}</TableCell>
                  <TableCell className="text-center">{r.user.email}</TableCell>
                  <TableCell className="text-center">
                    <span className="inline-flex items-center justify-center gap-1">
                      {r.user.phone || "-"}
                      {r.user.phone &&
                        (r.phoneVerified ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                            <span className="sr-only">Phone verified</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5 text-red-600" />
                            <span className="sr-only">Phone not verified</span>
                          </>
                        ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
                        r.user.archived
                          ? chipToneClass("neutral")
                          : chipToneClass("success")
                      }`}
                    >
                      {r.user.archived ? "Archived" : "Active"}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    {r.user.createdAt ? new Date(r.user.createdAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-center">
                    {r.user.lastLoginAt ? new Date(r.user.lastLoginAt).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-center">{r.lastOrderAt ? new Date(r.lastOrderAt).toLocaleString() : "-"}</TableCell>
                  <TableCell className="text-center">{formatDaysAgo(r.lastOrderAt)}</TableCell>
                  <TableCell className="text-center">
                    <div className="flex justify-center gap-2">
                      <Button
                        variant={r.user.archived ? "outline" : "secondary"}
                        size="sm"
                        onClick={() =>
                          setConfirmArchive({
                            id: r.user.id,
                            email: r.user.email,
                            archived: r.user.archived,
                          })
                        }
                      >
                        {r.user.archived ? "Unarchive" : "Archive"}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={
                          r.user.archived ||
                          r.ordersTotal > 0 ||
                          r.paymentsTotal > 0
                        }
                        onClick={() =>
                          setConfirmClose({
                            id: r.user.id,
                            email: r.user.email,
                          })
                        }
                        title={
                          r.ordersTotal > 0 || r.paymentsTotal > 0
                            ? "Accounts with order/payment history cannot be deleted; archive instead."
                            : undefined
                        }
                      >
                        Close Account
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-6">
                    <div className="flex flex-col items-center gap-3">
                      <span>No customers found for the current search.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setQ("");
                            setIncludeArchived(false);
                          }}
                        >
                          Clear search
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIncludeArchived(true);
                          }}
                        >
                          Include archived
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Close account (hard delete for accounts with no history) */}
      <Dialog
        open={!!confirmClose}
        onOpenChange={(open) => {
        if (!open) {
          setConfirmClose(null);
          setConfirmText("");
          setCloseReason("");
          setCloseReasonDetail("");
          setCloseErrors({});
        }
      }}
    >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
          <DialogTitle className="text-base font-semibold">Close Account</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to permanently close this account
            {confirmClose?.email ? ` (${confirmClose.email})` : ""}? This cannot be undone.
          </p>
          <div className="mt-2 grid gap-1.5">
            <label className="text-xs text-muted-foreground">
              Type &quot;{confirmClose?.email || "CLOSE ACCOUNT"}&quot; to confirm
            </label>
            <Input
              value={confirmText}
              onChange={(e) => {
                setConfirmText(e.target.value);
                if (closeErrors.confirmText) {
                  setCloseErrors((prev) => ({ ...prev, confirmText: "" }));
                }
              }}
              placeholder={String(confirmClose?.email || "CLOSE ACCOUNT")}
              aria-invalid={!!closeErrors.confirmText}
              className={closeErrors.confirmText ? "border-red-500" : undefined}
            />
            {closeErrors.confirmText && (
              <p className="text-xs text-red-600">{closeErrors.confirmText}</p>
            )}
          </div>
          <div className="mt-3 grid gap-1.5">
            <label className="text-xs text-muted-foreground">Closure reason</label>
            <select
              className={`h-9 w-full rounded border bg-background px-2 text-sm ${closeErrors.reason ? "border-red-500" : ""}`}
              value={closeReason}
              onChange={(e) => {
                setCloseReason(e.target.value);
                if (closeErrors.reason) {
                  setCloseErrors((prev) => ({ ...prev, reason: "" }));
                }
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
              placeholder="Optional details"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={
                confirmText.trim().toLowerCase() !== (confirmClose?.email || "CLOSE ACCOUNT").trim().toLowerCase() ||
                !closeReason
              }
              onClick={async () => {
                if (!confirmClose) return;
                const expected = (confirmClose?.email || "CLOSE ACCOUNT").trim().toLowerCase();
                const typed = confirmText.trim().toLowerCase();
                if (typed !== expected) {
                  setCloseErrors((prev) => ({ ...prev, confirmText: "Confirmation text does not match." }));
                  return;
                }
                if (!closeReason) {
                  setCloseErrors((prev) => ({ ...prev, reason: "Select a closure reason." }));
                  return;
                }
                try {
                  const detail = closeReasonDetail.trim();
                  const reason = closeReason === "Other" ? detail : detail ? `${closeReason}: ${detail}` : closeReason;
                  const res = await fetch(`/api/admin/users/${confirmClose.id}/close`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reason }),
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                    throw new Error(j?.error || 'Failed to close account');
                  }
                  toast.success('Account closed');
                  setConfirmClose(null);
                  setConfirmText("");
                  setCloseErrors({});
                  queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                } catch (err) {
                  const message = err instanceof Error ? err.message : "Failed to close account";
                  toast.error(message);
                }
              }}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Archive / Unarchive account */}
      <Dialog
        open={!!confirmArchive}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmArchive(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {confirmArchive?.archived ? "Unarchive Account" : "Archive Account"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirmArchive?.archived
              ? "This will mark the account as active again."
              : "This will mark the account as archived. Archived accounts remain in history but are treated as inactive."}
            {confirmArchive?.email ? ` (${confirmArchive.email})` : ""}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmArchive(null)}
            >
              Cancel
            </Button>
            <Button
              variant={confirmArchive?.archived ? "secondary" : "destructive"}
              onClick={async () => {
                if (!confirmArchive) return;
                try {
                  const res = await fetch(
                    `/api/admin/users/${confirmArchive.id}/archive`,
                    {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        archived: !confirmArchive.archived,
                      }),
                    },
                  );
                  if (!res.ok) {
                    const j = await res
                      .json()
                      .catch(
                        async () => ({
                          error: await res.text().catch(() => ""),
                        }),
                      );
                    throw new Error(
                      j?.error ||
                        (confirmArchive.archived
                          ? "Failed to unarchive account"
                          : "Failed to archive account"),
                    );
                  }
                  const wasArchived = confirmArchive.archived;
                  toast.success(
                    wasArchived ? "Account unarchived" : "Account archived",
                    {
                      action: {
                        label: "Undo",
                        onClick: async () => {
                          const undo = await fetch(
                            `/api/admin/users/${confirmArchive.id}/archive`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ archived: wasArchived }),
                            },
                          );
                          if (!undo.ok) {
                            const j = await undo
                              .json()
                              .catch(async () => ({ error: await undo.text().catch(() => "") }));
                            toast.error(j?.error || "Undo failed");
                            return;
                          }
                          queryClient.invalidateQueries({
                            queryKey: ["admin", "customers"],
                          });
                          toast.success("Undo complete");
                        },
                      },
                    },
                  );
                  setConfirmArchive(null);
                  queryClient.invalidateQueries({
                    queryKey: ["admin", "customers"],
                  });
                } catch (err) {
                  const message =
                    err instanceof Error
                      ? err.message
                      : "Failed to update account";
                  toast.error(message);
                }
              }}
            >
              {confirmArchive?.archived ? "Unarchive" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
