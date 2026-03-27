"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Lock } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

type UserRow = {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    phone: string | null;
    role: string;
    archived: boolean;
    lastLoginAt: string | null;
    createdAt: string;
    employeeId?: string | null;
    lastRoleChange?: {
      at: string;
      by?: { id: string; name: string | null; email: string | null } | null;
      from?: string | null;
      to?: string | null;
    } | null;
  };
};

const ROLE_OPTIONS = ["STAFF", "DISPATCHER", "ACCOUNTANT", "ADMIN"] as const;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string })?.error || "Failed to load users.";
    throw new Error(message);
  }
  return data;
};

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const roleManagementEnabled =
    process.env.NEXT_PUBLIC_ADMIN_ROLE_MANAGEMENT_ENABLED === "1";
  const protectedAdmins = useMemo(
    () =>
      String(process.env.NEXT_PUBLIC_PROTECTED_ADMIN_EMAILS || "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    [],
  );
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPhone, setCreatePhone] = useState("");
  const [createRole, setCreateRole] = useState<string>("STAFF");
  const [createError, setCreateError] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [backfillSubmitting, setBackfillSubmitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, error, isFetching } = useClientQuery<{
    rows: UserRow[];
  }>({
    queryKey: ["admin", "users", includeArchived ? "archived" : "active"],
    queryFn: () =>
      fetcher(
        `/api/admin/users?includeArchived=${includeArchived ? "1" : "0"}`,
      ),
    enabled: isAdmin,
  });
  const { data: inviteData } = useClientQuery<{
    rows: Array<{
      id: string;
      userId: string;
      createdAt: string;
      expiresAt: string;
      user: {
        id: string;
        name: string | null;
        email: string | null;
        phone: string | null;
        role: string;
      };
    }>;
  }>({
    queryKey: ["admin", "employee-invites"],
    queryFn: () => fetcher("/api/admin/users/invite"),
    enabled: isAdmin,
  });

  const rows = useMemo(() => {
    const raw = (data?.rows || []) as UserRow[];
    return raw.filter((row) => {
      const user = row.user;
      if (user.role === "CUSTOMER") {
        return false;
      }
      const haystack = [
        user.name,
        user.email,
        user.phone,
        user.role,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (search.trim() && !haystack.includes(search.trim().toLowerCase())) {
        return false;
      }
      if (roleFilter !== "ALL" && user.role !== roleFilter) {
        return false;
      }
      return true;
    });
  }, [data?.rows, roleFilter, search]);

  const updateRole = async (userId: string, nextRole: string) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to update role.");
      }
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("Role updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role.");
    }
  };

  const resetCreateForm = () => {
    setCreateName("");
    setCreateEmail("");
    setCreatePhone("");
    setCreateRole("STAFF");
    setCreateError("");
    setCreatedInviteUrl("");
    setDeliveryNote("");
  };

  const backfillEmployeeProfiles = async () => {
    if (backfillSubmitting) return;
    setBackfillSubmitting(true);
    try {
      const res = await fetch("/api/admin/hr/employees/backfill-users", {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to backfill employees.");
      }
      toast.success(
        `Backfill complete: ${payload.created ?? 0} created, ${payload.linked ?? 0} linked.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to backfill employees.");
    } finally {
      setBackfillSubmitting(false);
    }
  };

  const submitCreateEmployee = async () => {
    setCreateError("");
    setCreateSubmitting(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName.trim(),
          email: createEmail.trim(),
          phone: createPhone.trim() || undefined,
          role: createRole,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to create employee.");
      }
      setCreatedInviteUrl(String(payload?.inviteUrl || ""));
      const channel = payload?.channel ? String(payload.channel) : "";
      setDeliveryNote(
        channel
          ? `Invite sent via ${channel}.`
          : "Invite created. Please share the link manually.",
      );
      toast.success("Employee invite sent.");
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-invites"] });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create employee.");
    } finally {
      setCreateSubmitting(false);
    }
  };

  const copyInviteLink = async () => {
    if (!createdInviteUrl) return;
    try {
      await navigator.clipboard.writeText(createdInviteUrl);
      toast.success("Invite link copied.");
    } catch {
      toast.error("Copy failed. Select the link and copy manually.");
    }
  };

  const resendInvite = async (userId: string) => {
    try {
      const res = await fetch("/api/admin/users/invite/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to resend invite.");
      }
      const channel = payload?.channel ? ` via ${payload.channel}` : "";
      toast.success(`Invite re-sent${channel}.`);
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-invites"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resend invite.");
    }
  };

  const forceLogout = async (userId: string, opts: { silent?: boolean } = {}) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/force-logout`, {
        method: "PATCH",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to force logout.");
      }
      if (!opts.silent) {
        toast.success("User session cleared.");
      }
    } catch (err) {
      if (!opts.silent) {
        toast.error(err instanceof Error ? err.message : "Failed to force logout.");
      }
      throw err;
    }
  };

  const bulkUpdateArchive = async (archived: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    let updated = 0;
    let skipped = 0;
    for (const id of ids) {
      const row = rows.find((r) => r.user.id === id);
      if (!row) continue;
      const isProtectedAdmin =
        row.user.role === "ADMIN" &&
        !!row.user.email &&
        protectedAdmins.includes(row.user.email.toLowerCase());
      if (isProtectedAdmin) {
        skipped += 1;
        continue;
      }
      try {
        await toggleArchive(id, archived, { silent: true });
        updated += 1;
      } catch {
        // handled in aggregate
      }
    }
    setSelectedIds(new Set());
    if (updated > 0) {
      toast.success(
        archived
          ? `Deactivated ${updated} user(s).`
          : `Reactivated ${updated} user(s).`,
      );
    }
    if (skipped > 0) {
      toast.info(`Skipped ${skipped} protected admin(s).`);
    }
  };

  const bulkForceLogout = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    let updated = 0;
    let skipped = 0;
    for (const id of ids) {
      const row = rows.find((r) => r.user.id === id);
      if (!row) continue;
      const isProtectedAdmin =
        row.user.role === "ADMIN" &&
        !!row.user.email &&
        protectedAdmins.includes(row.user.email.toLowerCase());
      if (isProtectedAdmin) {
        skipped += 1;
        continue;
      }
      try {
        await forceLogout(id, { silent: true });
        updated += 1;
      } catch {
        // handled in aggregate
      }
    }
    setSelectedIds(new Set());
    if (updated > 0) toast.success(`Forced logout for ${updated} user(s).`);
    if (skipped > 0) toast.info(`Skipped ${skipped} protected admin(s).`);
  };

  const toggleArchive = async (
    userId: string,
    nextArchived: boolean,
    opts: { silent?: boolean } = {},
  ) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: nextArchived }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to update user status.");
      }
      if (nextArchived && !includeArchived) {
        setIncludeArchived(true);
      }
      if (!opts.silent) {
        toast.success(nextArchived ? "User deactivated." : "User reactivated.");
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (err) {
      if (!opts.silent) {
        toast.error(err instanceof Error ? err.message : "Failed to update user status.");
      }
      throw err;
    }
  };

  const inviteRows = useMemo(
    () => (inviteData?.rows || []) as Array<{
      id: string;
      userId: string;
      createdAt: string;
      expiresAt: string;
      user: {
        id: string;
        name: string | null;
        email: string | null;
        phone: string | null;
        role: string;
      };
    }>,
    [inviteData?.rows],
  );

  const inviteByUserId = useMemo(() => {
    const map = new Map<string, { id: string; userId: string }>();
    for (const invite of inviteRows) {
      map.set(invite.userId, { id: invite.id, userId: invite.userId });
    }
    return map;
  }, [inviteRows]);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const buildInviteUrl = (userId: string) =>
    origin ? `${origin}/invite?userId=${userId}` : "";

  if (!isAdmin) {
    return (
      <section className="container mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Users & Roles</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Admins only.</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users & Roles</h1>
        <p className="text-sm text-muted-foreground">
          Manage staff access without using the Customers list.
        </p>
        <div className="text-xs text-muted-foreground mt-1">
          <Link
            href="/admin/audit?entityType=USER&sourcePage=admin/users"
            className="underline"
          >
            View audit trail for role and access changes
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Filters</CardTitle>
            <Button
              className="w-full sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => {
                resetCreateForm();
                setCreateOpen(true);
              }}
            >
              Create employee
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search name, email, phone"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full sm:w-64"
            />
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full sm:w-44 h-9">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All roles</SelectItem>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              Show archived
            </label>
          </div>
          {!roleManagementEnabled ? (
            <div className="text-xs text-muted-foreground">
              Role changes are disabled. Set{" "}
              <span className="font-mono">NEXT_PUBLIC_ADMIN_ROLE_MANAGEMENT_ENABLED=1</span>{" "}
              to enable.
            </div>
          ) : null}
          {roleManagementEnabled ? (
            <div className="text-xs text-muted-foreground">
              Protected admins are locked via{" "}
              <span className="font-mono">NEXT_PUBLIC_PROTECTED_ADMIN_EMAILS</span>.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How invites work</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <ul className="list-disc pl-4 space-y-1">
            <li>
              Admins create employees here. Invites are sent by email first, then SMS and WhatsApp
              if needed.
            </li>
            <li>
              New employees must verify email and phone on first login and reset their password.
            </li>
            <li>
              Role changes and access are Admin‑only for now. You can expand roles later as the team
              grows.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            HR is the source of truth for employee profiles. Creating a user here will also
            auto-create (or link) the employee profile in HR.
          </p>
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={backfillEmployeeProfiles}
              disabled={backfillSubmitting}
            >
              {backfillSubmitting ? "Backfilling…" : "Backfill HR profiles"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Directory</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load users."}
            </p>
          ) : isFetching ? (
            <p className="text-sm text-muted-foreground">Loading users…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users found.</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex flex-wrap items-center gap-2 mb-3 text-sm">
                <span className="text-muted-foreground">
                  Selected: {selectedIds.size}
                </span>
                <Button
                  className="w-full sm:w-auto"
                  variant="outline"
                  size="sm"
                  disabled={selectedIds.size === 0}
                  onClick={() => bulkUpdateArchive(true)}
                >
                  Deactivate selected
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  variant="outline"
                  size="sm"
                  disabled={selectedIds.size === 0}
                  onClick={() => bulkUpdateArchive(false)}
                >
                  Reactivate selected
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  variant="outline"
                  size="sm"
                  disabled={selectedIds.size === 0}
                  onClick={bulkForceLogout}
                >
                  Force logout selected
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selectedIds.size > 0 && selectedIds.size === rows.length}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds(new Set(rows.map((r) => r.user.id)));
                          } else {
                            setSelectedIds(new Set());
                          }
                        }}
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Last role change</TableHead>
                    <TableHead>Last login</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead>Access</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const user = row.user;
                    const isProtectedAdmin =
                      user.role === "ADMIN" &&
                      !!user.email &&
                      protectedAdmins.includes(user.email.toLowerCase());
                    const isSelected = selectedIds.has(user.id);
                    const lastRole = user.lastRoleChange;
                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${user.name || user.email || "user"}`}
                            checked={isSelected}
                            onChange={(e) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) {
                                  next.add(user.id);
                                } else {
                                  next.delete(user.id);
                                }
                                return next;
                              });
                            }}
                          />
                        </TableCell>
                        <TableCell>{user.name || "—"}</TableCell>
                        <TableCell>{user.email || "—"}</TableCell>
                        <TableCell>{user.phone || "—"}</TableCell>
                        <TableCell>
                          {roleManagementEnabled ? (
                            <div className="flex items-center gap-2">
                              <Select
                                value={user.role}
                                disabled={isProtectedAdmin}
                                onValueChange={(value) => updateRole(user.id, value)}
                              >
                                <SelectTrigger className="h-8 w-36">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ROLE_OPTIONS.map((opt) => (
                                    <SelectItem key={opt} value={opt}>
                                      {opt}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {isProtectedAdmin ? (
                                <span
                                  className="text-red-400"
                                  title="Protected admin role is locked to prevent accidental removal."
                                >
                                  <Lock className="h-4 w-4" />
                                </span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-sm">{user.role}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {lastRole ? (
                            <div className="text-xs text-muted-foreground">
                              <div>{new Date(lastRole.at).toLocaleString()}</div>
                              <div>
                                {lastRole.by?.name ||
                                  lastRole.by?.email ||
                                  "—"}
                              </div>
                              <div>
                                <Link
                                  href={`/admin/audit?entityType=USER&entityId=${user.id}&sourcePage=admin/users`}
                                  className="underline"
                                >
                                  View history
                                </Link>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.lastLoginAt
                            ? new Date(user.lastLoginAt).toLocaleString()
                            : "—"}
                        </TableCell>
                        <TableCell>
                          {user.archived ? "Archived" : "Active"}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button asChild variant="outline" size="sm">
                              <Link
                                href={
                                  user.employeeId
                                    ? `/admin/hr/staff/${user.employeeId}`
                                    : "/admin/hr/staff"
                                }
                              >
                                View
                              </Link>
                            </Button>
                            {inviteByUserId.has(user.id) ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => resendInvite(user.id)}
                              >
                                Reset invite
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isProtectedAdmin}
                              title={
                                isProtectedAdmin
                                  ? "Protected admin accounts cannot be deactivated."
                                  : undefined
                              }
                              onClick={() => {
                                const label = user.archived ? "reactivate" : "deactivate";
                                if (!confirm(`Are you sure you want to ${label} this user?`)) {
                                  return;
                                }
                                void toggleArchive(user.id, !user.archived);
                              }}
                            >
                              {user.archived ? "Reactivate" : "Deactivate"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={isProtectedAdmin}
                              title={
                                isProtectedAdmin
                                  ? "Protected admin accounts cannot be forced to logout."
                                  : undefined
                              }
                              onClick={() => forceLogout(user.id)}
                            >
                              Force logout
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pending invites</CardTitle>
        </CardHeader>
        <CardContent>
          {inviteRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active invites.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inviteRows.map((invite) => {
                    const url = buildInviteUrl(invite.userId);
                    return (
                      <TableRow key={invite.id}>
                        <TableCell>{invite.user.name || "—"}</TableCell>
                        <TableCell>{invite.user.email || "—"}</TableCell>
                        <TableCell>{invite.user.role}</TableCell>
                        <TableCell>{new Date(invite.createdAt).toLocaleString()}</TableCell>
                        <TableCell>{new Date(invite.expiresAt).toLocaleString()}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => resendInvite(invite.userId)}
                            >
                              Resend
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                if (!url) return;
                                try {
                                  await navigator.clipboard.writeText(url);
                                  toast.success("Invite link copied.");
                                } catch {
                                  toast.error("Copy failed.");
                                }
                              }}
                            >
                              Copy link
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite employee</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              An invite link and verification code will be sent via email and SMS
              (WhatsApp fallback).
            </p>
            <div>
              <label className="text-xs text-muted-foreground">Full name</label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g., Abena Mensah"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Email</label>
              <Input
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                placeholder="staff@company.com"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Phone (required)</label>
              <Input
                value={createPhone}
                onChange={(e) => setCreatePhone(e.target.value)}
                placeholder="0241234567"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Role</label>
              <Select value={createRole} onValueChange={setCreateRole}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">STAFF</SelectItem>
                  <SelectItem value="ACCOUNTANT">ACCOUNTANT</SelectItem>
                  <SelectItem value="ADMIN">ADMIN</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {createdInviteUrl ? (
              <div className="rounded-md border p-3 space-y-1">
                <div className="text-xs text-muted-foreground">Invite link</div>
                <div className="font-medium break-all">{createdInviteUrl}</div>
                <div className="text-xs text-muted-foreground">
                  {deliveryNote || "Share this once. The link expires in 24 hours."}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={copyInviteLink}>
                    Copy invite link
                  </Button>
                </div>
              </div>
            ) : null}
            {createError ? <p className="text-xs text-red-600">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Close
            </Button>
            <Button
              onClick={submitCreateEmployee}
              disabled={
                createSubmitting ||
                !createName.trim() ||
                !createEmail.trim() ||
                !createPhone.trim()
              }
            >
              {createSubmitting ? "Sending..." : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
