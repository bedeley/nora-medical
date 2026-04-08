"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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
    isProtected?: boolean;
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

type InviteRow = {
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
};

const ROLE_OPTIONS = ["STAFF", "DISPATCHER", "ACCOUNTANT", "ADMIN"] as const;
const DORMANT_ACCESS_ROLES = new Set(["ADMIN", "ACCOUNTANT"]);
const DAY_MS = 24 * 60 * 60 * 1000;

type QuickFilter = "ALL" | "MISSING_HR" | "PENDING_INVITE" | "PROTECTED_ADMIN" | "DORMANT_ELEVATED";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string })?.error || "Failed to load users.";
    throw new Error(message);
  }
  return data;
};

function formatRelativeTime(value: string | null) {
  if (!value) return "Never";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 60 * 1000) return "Just now";
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / (60 * 1000)))}m ago`;
  if (diff < DAY_MS) return `${Math.max(1, Math.floor(diff / (60 * 60 * 1000)))}h ago`;
  if (diff < 30 * DAY_MS) return `${Math.max(1, Math.floor(diff / DAY_MS))}d ago`;
  if (diff < 365 * DAY_MS) return `${Math.max(1, Math.floor(diff / (30 * DAY_MS)))}mo ago`;
  return `${Math.max(1, Math.floor(diff / (365 * DAY_MS)))}y ago`;
}

function getInviteUrgency(expiresAt: string) {
  const msRemaining = new Date(expiresAt).getTime() - Date.now();
  if (msRemaining <= 0) {
    return {
      label: "Expired",
      detail: "Invite is no longer valid",
      className: "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200",
    };
  }
  if (msRemaining <= DAY_MS) {
    const hours = Math.max(1, Math.ceil(msRemaining / (60 * 60 * 1000)));
    return {
      label: "Expires soon",
      detail: `${hours}h left`,
      className: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
    };
  }
  const days = Math.max(1, Math.ceil(msRemaining / DAY_MS));
  return {
    label: "Active",
    detail: `${days}d left`,
    className: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
  };
}

function isDormantElevatedUser(user: UserRow["user"]) {
  if (user.archived) return false;
  if (!DORMANT_ACCESS_ROLES.has(user.role)) return false;
  if (!user.lastLoginAt) return true;
  return Date.now() - new Date(user.lastLoginAt).getTime() > 30 * DAY_MS;
}

function SummaryTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const roleManagementEnabled =
    process.env.NEXT_PUBLIC_ADMIN_ROLE_MANAGEMENT_ENABLED === "1";
  // Protected admin status is now provided by the server via isProtected flag
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
  const [ensuringProfileUserId, setEnsuringProfileUserId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("ALL");

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
    rows: InviteRow[];
  }>({
    queryKey: ["admin", "employee-invites"],
    queryFn: () => fetcher("/api/admin/users/invite"),
    enabled: isAdmin,
  });

  const allUsers = useMemo(() => {
    const raw = (data?.rows || []) as UserRow[];
    return raw.filter((row) => row.user.role !== "CUSTOMER");
  }, [data?.rows]);

  const inviteRows = useMemo(
    () => (inviteData?.rows || []) as InviteRow[],
    [inviteData?.rows],
  );

  const inviteByUserId = useMemo(() => {
    const map = new Map<string, { id: string; userId: string }>();
    for (const invite of inviteRows) {
      map.set(invite.userId, { id: invite.id, userId: invite.userId });
    }
    return map;
  }, [inviteRows]);

  const rows = useMemo(() => {
    const raw = allUsers;
    return raw.filter((row) => {
      const user = row.user;
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
      if (quickFilter === "MISSING_HR" && user.employeeId) {
        return false;
      }
      if (quickFilter === "PENDING_INVITE" && !inviteByUserId.has(user.id)) {
        return false;
      }
      if (quickFilter === "PROTECTED_ADMIN" && !user.isProtected) {
        return false;
      }
      if (quickFilter === "DORMANT_ELEVATED" && !isDormantElevatedUser(user)) {
        return false;
      }
      return true;
    });
  }, [allUsers, inviteByUserId, quickFilter, roleFilter, search]);

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

  const ensureEmployeeProfile = async (userId: string) => {
    if (ensuringProfileUserId) return;
    setEnsuringProfileUserId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/employee-profile`, {
        method: "PATCH",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to create the HR profile.");
      }
      const summary =
        payload?.outcome === "created"
          ? "HR profile created."
          : payload?.outcome === "linked"
            ? "Existing HR profile linked."
            : "HR profile was already linked.";
      toast.success(summary);
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create the HR profile.");
    } finally {
      setEnsuringProfileUserId("");
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
        throw new Error(payload?.error || "Failed to create user invite.");
      }
      setCreatedInviteUrl(String(payload?.inviteUrl || ""));
      const channel = payload?.channel ? String(payload.channel) : "";
      setDeliveryNote(
        channel
          ? `Invite sent via ${channel}.`
          : "Invite created. Please share the link manually.",
      );
      toast.success("User invite sent.");
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "employee-invites"] });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user invite.");
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
        !!row.user.isProtected;
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
        !!row.user.isProtected;
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

  const quickFilterCounts = useMemo(
    () => ({
      ALL: allUsers.length,
      MISSING_HR: allUsers.filter((row) => !row.user.employeeId).length,
      PENDING_INVITE: allUsers.filter((row) => inviteByUserId.has(row.user.id)).length,
      PROTECTED_ADMIN: allUsers.filter((row) => row.user.isProtected).length,
      DORMANT_ELEVATED: allUsers.filter((row) => isDormantElevatedUser(row.user)).length,
    }),
    [allUsers, inviteByUserId],
  );

  const totalUsers = allUsers.length;
  const activeUsers = allUsers.filter((row) => !row.user.archived).length;
  const archivedUsers = allUsers.filter((row) => row.user.archived).length;
  const missingHrProfiles = allUsers.filter((row) => !row.user.employeeId).length;
  const linkedHrProfiles = totalUsers - missingHrProfiles;
  const pendingInvites = inviteRows.length;
  const protectedAdmins = allUsers.filter((row) => row.user.isProtected).length;
  const dormantElevatedUsers = quickFilterCounts.DORMANT_ELEVATED;
  const recentSignIns = allUsers.filter((row) => {
    if (!row.user.lastLoginAt) return false;
    return new Date(row.user.lastLoginAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000;
  }).length;
  const quickFilterButtons: Array<{ key: QuickFilter; label: string; count: number }> = [
    { key: "ALL", label: "All accounts", count: quickFilterCounts.ALL },
    { key: "MISSING_HR", label: "Missing HR profile", count: quickFilterCounts.MISSING_HR },
    { key: "PENDING_INVITE", label: "Pending invite", count: quickFilterCounts.PENDING_INVITE },
    { key: "PROTECTED_ADMIN", label: "Protected admin", count: quickFilterCounts.PROTECTED_ADMIN },
    { key: "DORMANT_ELEVATED", label: "Dormant elevated access", count: quickFilterCounts.DORMANT_ELEVATED },
  ];

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
    <section className="space-y-6 pb-20 md:pb-0">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.28em] text-muted-foreground">
                <Badge variant="outline">People access</Badge>
                <span>HR-linked identities</span>
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Users & Roles</h1>
                <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                  Manage staff access, role assignment, invite delivery, and HR profile readiness
                  from one workspace aligned with the HR control pages.
                </p>
                <p className="text-xs text-muted-foreground">
                  {missingHrProfiles > 0
                    ? `${missingHrProfiles} account${missingHrProfiles === 1 ? "" : "s"} still need an HR profile link.`
                    : "All visible staff accounts are linked to an HR profile."}{" "}
                  {pendingInvites > 0
                    ? `${pendingInvites} invite${pendingInvites === 1 ? "" : "s"} still need to be accepted.`
                    : "No pending invites are waiting for acceptance."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href="#directory-controls"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Controls
                </a>
                <a
                  href="#directory"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Directory
                </a>
                <a
                  href="#pending-invites"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Pending invites
                </a>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-md xl:justify-end">
              <Button
                onClick={() => {
                  resetCreateForm();
                  setCreateOpen(true);
                }}
              >
                Invite user account
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/hr/onboarding?source=users">Start HR onboarding</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/hr/staff">Open staff directory</Link>
              </Button>
              <Button asChild variant="outline">
                <Link
                  href="/admin/audit?entityType=USER&sourcePage=admin/users"
                >
                  View audit trail
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryTile
              label="Total accounts"
              value={totalUsers}
              note={`${rows.length} in the current filter view`}
            />
            <SummaryTile
              label="Active access"
              value={activeUsers}
              note={`${archivedUsers} archived account${archivedUsers === 1 ? "" : "s"}`}
            />
            <SummaryTile
              label="Pending invites"
              value={pendingInvites}
              note="Invite delivery and first-login onboarding still open"
            />
            <SummaryTile
              label="Missing HR links"
              value={missingHrProfiles}
              note={`${linkedHrProfiles} linked employee profile${linkedHrProfiles === 1 ? "" : "s"} ready`}
            />
          </div>

          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <p className="text-sm font-medium">Current access snapshot</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {totalUsers === 0
                ? "No staff user accounts have been created yet."
                : `${recentSignIns} account${recentSignIns === 1 ? "" : "s"} signed in during the last 30 days, ${protectedAdmins} protected admin account${protectedAdmins === 1 ? "" : "s"} remain locked, ${dormantElevatedUsers} elevated-access account${dormantElevatedUsers === 1 ? "" : "s"} look dormant, and role management is ${roleManagementEnabled ? "enabled" : "currently disabled"}.`}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card id="directory-controls">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <CardTitle className="text-base">Directory controls</CardTitle>
              <CardDescription>
                Narrow the staff identity list before updating roles, sessions, or HR links.
              </CardDescription>
            </div>
            <Badge variant="outline" className="rounded-full px-3 py-1">
              Showing {rows.length}
            </Badge>
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
            <label className="flex items-center gap-2 rounded-md border border-border/70 px-3 text-sm">
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
              Protected admins are locked via server configuration.
            </div>
          ) : null}
        </CardContent>
        <CardContent className="pt-0">
          <div className="flex flex-wrap gap-2">
            {quickFilterButtons.map((item) => (
              <Button
                key={item.key}
                type="button"
                variant={quickFilter === item.key ? "default" : "outline"}
                size="sm"
                aria-pressed={quickFilter === item.key}
                onClick={() => setQuickFilter(item.key)}
              >
                {item.label} ({item.count})
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access and HR sync</CardTitle>
          <CardDescription>
            Use this page for account access and invite delivery. Keep HR profiles linked before payroll or portal work.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <ul className="list-disc pl-4 space-y-1">
            <li>
              Use this page for user access only. Start employee setup from HR onboarding, then send the invite here.
            </li>
            <li>
              Invites are sent by email first, then SMS and WhatsApp if needed. New users verify their contact details and reset their password on first login.
            </li>
            <li>
              Role changes and access are Admin‑only for now. You can expand roles later as the team
              grows.
            </li>
          </ul>
          <p className="text-xs text-muted-foreground">
            HR is the source of truth for employee profiles. This page can still auto-link or backfill a minimal HR profile for continuity, but that should be treated as a repair path, not the main hiring flow.
          </p>
          <p className="text-xs text-muted-foreground">
            If an older bootstrapped admin or staff account is missing an HR profile, use
            <span className="font-medium"> Create HR profile</span> from the directory or run the
            bulk backfill below.
          </p>
          <div className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={backfillEmployeeProfiles}
              disabled={backfillSubmitting}
            >
              {backfillSubmitting ? "Backfilling..." : "Backfill HR profiles"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card id="directory">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Directory</CardTitle>
          <CardDescription>
            Review access, role history, HR profile readiness, and session controls in one table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load users."}
            </p>
          ) : isFetching ? (
            <p className="text-sm text-muted-foreground">Loading users...</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users found.</p>
          ) : (
            <div className="space-y-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  Selected: {selectedIds.size}
                </Badge>
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  Quick view: {quickFilterButtons.find((item) => item.key === quickFilter)?.label || "All accounts"}
                </Badge>
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
              <div className="space-y-3 md:hidden">
                {rows.map((row) => {
                  const user = row.user;
                  const isProtectedAdmin = !!user.isProtected;
                  const isSelected = selectedIds.has(user.id);
                  const hasPendingInvite = inviteByUserId.has(user.id);
                  const dormantElevated = isDormantElevatedUser(user);
                  return (
                    <div key={user.id} className="rounded-2xl border border-border/70 bg-background/80 p-4 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
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
                            <div className="font-medium">{user.name || "-"}</div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="rounded-full">
                              {user.role}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn(
                                "rounded-full",
                                user.archived
                                  ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                                  : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
                              )}
                            >
                              {user.archived ? "Archived" : "Active"}
                            </Badge>
                            {isProtectedAdmin ? (
                              <Badge variant="outline" className="rounded-full border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                                Protected admin
                              </Badge>
                            ) : null}
                            {hasPendingInvite ? (
                              <Badge variant="outline" className="rounded-full border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
                                Pending invite
                              </Badge>
                            ) : null}
                            {dormantElevated ? (
                              <Badge variant="outline" className="rounded-full border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                Dormant elevated access
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        {roleManagementEnabled ? (
                          <Select
                            value={user.role}
                            disabled={isProtectedAdmin}
                            onValueChange={(value) => updateRole(user.id, value)}
                          >
                            <SelectTrigger className="h-8 w-32">
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
                        ) : null}
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                        <div>Email: {user.email || "-"}</div>
                        <div>Phone: {user.phone || "-"}</div>
                        <div>
                          Last seen: {formatRelativeTime(user.lastLoginAt)}
                          {user.lastLoginAt ? ` (${new Date(user.lastLoginAt).toLocaleString()})` : ""}
                        </div>
                        <div>HR profile: {user.employeeId ? `Ready (${user.employeeId})` : "Missing HR profile"}</div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {user.employeeId ? (
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/admin/hr/staff/${user.employeeId}`}>
                              Open staff profile
                            </Link>
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={ensuringProfileUserId === user.id}
                            onClick={() => ensureEmployeeProfile(user.id)}
                          >
                            {ensuringProfileUserId === user.id ? "Creating HR profile..." : "Create HR profile"}
                          </Button>
                        )}
                        {hasPendingInvite ? (
                          <Button variant="ghost" size="sm" onClick={() => resendInvite(user.id)}>
                            Reset invite
                          </Button>
                        ) : null}
                        {!user.employeeId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={ensuringProfileUserId === user.id}
                            onClick={() => ensureEmployeeProfile(user.id)}
                          >
                            Fix HR link
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isProtectedAdmin}
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
                          onClick={() => forceLogout(user.id)}
                        >
                          Force logout
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/admin/audit?entityType=USER&entityId=${user.id}&sourcePage=admin/users`}>
                            View history
                          </Link>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden overflow-x-auto md:block">
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
                    <TableHead>HR profile</TableHead>
                    <TableHead>Actions</TableHead>
                    <TableHead>Access</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const user = row.user;
                    const isProtectedAdmin =
                      !!user.isProtected;
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
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium">{user.name || "-"}</div>
                            <div className="flex flex-wrap gap-2">
                              {user.isProtected ? (
                                <Badge variant="outline" className="rounded-full border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                                  Protected admin
                                </Badge>
                              ) : null}
                              {inviteByUserId.has(user.id) ? (
                                <Badge variant="outline" className="rounded-full border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200">
                                  Pending invite
                                </Badge>
                              ) : null}
                              {isDormantElevatedUser(user) ? (
                                <Badge variant="outline" className="rounded-full border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                                  Dormant elevated access
                                </Badge>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{user.email || "-"}</TableCell>
                        <TableCell>{user.phone || "-"}</TableCell>
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
                                  "-"}
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
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="text-xs text-muted-foreground">
                            <div className="font-medium text-foreground">{formatRelativeTime(user.lastLoginAt)}</div>
                            <div>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "No completed login yet"}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              "rounded-full",
                              user.archived
                                ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                                : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200",
                            )}
                          >
                            {user.archived ? "Archived" : "Active"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {user.employeeId ? (
                            <div className="space-y-1 text-xs">
                              <div className="font-medium text-emerald-700 dark:text-emerald-400">
                                Ready
                              </div>
                              <div className="text-muted-foreground break-all">
                                {user.employeeId}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1 text-xs">
                              <div className="font-medium text-amber-700 dark:text-amber-400">
                                Missing HR profile
                              </div>
                              <div className="text-muted-foreground">
                                Employee portal and staff profile are unavailable until linked.
                              </div>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            {user.employeeId ? (
                              <Button asChild variant="outline" size="sm">
                                <Link href={`/admin/hr/staff/${user.employeeId}`}>
                                  Open staff profile
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={ensuringProfileUserId === user.id}
                                onClick={() => ensureEmployeeProfile(user.id)}
                              >
                                {ensuringProfileUserId === user.id
                                  ? "Creating HR profile..."
                                  : "Create HR profile"}
                              </Button>
                            )}
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
                            {!user.employeeId ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={ensuringProfileUserId === user.id}
                                onClick={() => ensureEmployeeProfile(user.id)}
                              >
                                Fix HR link
                              </Button>
                            ) : null}
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="pending-invites">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pending invites</CardTitle>
          <CardDescription>
            Track accounts that were created but still have not completed invite acceptance and first login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inviteRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active invites.</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3 md:hidden">
                {inviteRows.map((invite) => {
                  const url = buildInviteUrl(invite.userId);
                  const urgency = getInviteUrgency(invite.expiresAt);
                  return (
                    <div key={invite.id} className="rounded-2xl border border-border/70 bg-background/80 p-4 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-medium">{invite.user.name || "-"}</div>
                          <div className="text-sm text-muted-foreground">{invite.user.email || "-"}</div>
                        </div>
                        <Badge variant="outline" className={cn("rounded-full", urgency.className)}>
                          {urgency.label}
                        </Badge>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
                        <div>Role: {invite.user.role}</div>
                        <div>Created: {new Date(invite.createdAt).toLocaleString()}</div>
                        <div>Expires: {new Date(invite.expiresAt).toLocaleString()}</div>
                        <div>{urgency.detail}</div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
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
                    </div>
                  );
                })}
              </div>
              <div className="hidden overflow-x-auto md:block">
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
                    const urgency = getInviteUrgency(invite.expiresAt);
                    return (
                      <TableRow key={invite.id}>
                        <TableCell>{invite.user.name || "-"}</TableCell>
                        <TableCell>{invite.user.email || "-"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="rounded-full">
                              {invite.user.role}
                            </Badge>
                            <Badge variant="outline" className={cn("rounded-full", urgency.className)}>
                              {urgency.label}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell>{new Date(invite.createdAt).toLocaleString()}</TableCell>
                        <TableCell>
                          <div className="text-xs text-muted-foreground">
                            <div className="font-medium text-foreground">{urgency.detail}</div>
                            <div>{new Date(invite.expiresAt).toLocaleString()}</div>
                          </div>
                        </TableCell>
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
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite user account</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Use HR onboarding for the employee record first. This dialog is for portal or admin access and will send an invite link plus verification code by email and SMS (WhatsApp fallback).
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
