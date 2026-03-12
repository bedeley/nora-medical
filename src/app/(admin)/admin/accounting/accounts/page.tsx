"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  subtype?: string | null;
  description?: string | null;
  parentAccountId?: string | null;
  isActive: boolean;
};

type AppSettingResponse = {
  key: string;
  value: Record<string, string> | null;
};

const accountTypes: Array<LedgerAccount["type"]> = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
];
const SYSTEM_ACCOUNT_CODES = new Set([
  "1000",
  "1010",
  "1020",
  "1100",
  "1200",
  "2000",
  "2100",
  "2200",
  "3000",
  "4000",
  "5000",
  "6000",
  "6100",
  "6990",
]);

export default function AccountingAccountsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useClientQuery<LedgerAccount[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetch("/api/admin/accounting/accounts").then((r) => r.json()),
  });
  const { data: postingRulesData } = useClientQuery<AppSettingResponse>({
    queryKey: ["accounting", "posting-rules", "accounts-map"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.posting.accounts").then((r) => r.json()),
  });
  const accounts = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const postingRuleCodes = useMemo(() => {
    const value = postingRulesData?.value;
    if (!value || typeof value !== "object") return new Set<string>();
    return new Set(Object.values(value).filter((code): code is string => Boolean(code)));
  }, [postingRulesData]);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<LedgerAccount["type"]>("ASSET");
  const [subtype, setSubtype] = useState("");
  const [description, setDescription] = useState("");
  const [parentAccountId, setParentAccountId] = useState("");
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"ALL" | LedgerAccount["type"]>("ALL");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ALL");
  const [systemOnly, setSystemOnly] = useState(false);
  const [postingRulesOnly, setPostingRulesOnly] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<LedgerAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editSubtype, setEditSubtype] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editParentAccountId, setEditParentAccountId] = useState("");
  const [updating, setUpdating] = useState(false);

  const parentOptions = useMemo(() => accounts.filter((a) => a.isActive), [accounts]);
  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts.filter((acc) => {
      if (typeFilter !== "ALL" && acc.type !== typeFilter) return false;
      if (statusFilter === "ACTIVE" && !acc.isActive) return false;
      if (statusFilter === "INACTIVE" && acc.isActive) return false;
      if (systemOnly && !SYSTEM_ACCOUNT_CODES.has(acc.code)) return false;
      if (postingRulesOnly && !postingRuleCodes.has(acc.code)) return false;
      if (!q) return true;
      return (
        acc.code.toLowerCase().includes(q) ||
        acc.name.toLowerCase().includes(q) ||
        String(acc.subtype || "").toLowerCase().includes(q)
      );
    });
  }, [accounts, search, typeFilter, statusFilter, systemOnly, postingRulesOnly, postingRuleCodes]);

  const createAccount = async () => {
    if (!code.trim() || !name.trim()) {
      toast.error("Code and name are required.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          type,
          subtype: subtype.trim() || undefined,
          description: description.trim() || undefined,
          parentAccountId: parentAccountId || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to create account");
      }
      toast.success("Account created.");
      setCode("");
      setName("");
      setSubtype("");
      setDescription("");
      setParentAccountId("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "accounts"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create account.");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (acc: LedgerAccount) => {
    setEditTarget(acc);
    setEditName(acc.name || "");
    setEditSubtype(acc.subtype || "");
    setEditDescription(acc.description || "");
    setEditParentAccountId(acc.parentAccountId || "");
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (!editTarget) return;
    if (!editName.trim()) {
      toast.error("Account name is required.");
      return;
    }
    try {
      setUpdating(true);
      const res = await fetch("/api/admin/accounting/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editTarget.id,
          name: editName.trim(),
          subtype: editSubtype.trim() || null,
          description: editDescription.trim() || null,
          parentAccountId: editParentAccountId || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update account.");
      toast.success("Account updated.");
      setEditOpen(false);
      setEditTarget(null);
      queryClient.invalidateQueries({ queryKey: ["accounting", "accounts"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update account.");
    } finally {
      setUpdating(false);
    }
  };

  const toggleArchive = async (acc: LedgerAccount) => {
    try {
      setUpdating(true);
      const res = await fetch("/api/admin/accounting/accounts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: acc.id,
          isActive: !acc.isActive,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update account status.");
      toast.success(acc.isActive ? "Account archived." : "Account activated.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "accounts"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update account status.");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Chart of Accounts</h1>
        <p className="text-sm text-muted-foreground">
          Manage ledger accounts used across reporting.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create account</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Code (e.g., 1000)" value={code} onChange={(e) => setCode(e.target.value)} />
          <Input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)} />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as LedgerAccount["type"])}
          >
            {accountTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Input placeholder="Subtype (optional)" value={subtype} onChange={(e) => setSubtype(e.target.value)} />
          <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={parentAccountId}
            onChange={(e) => setParentAccountId(e.target.value)}
          >
            <option value="">No parent</option>
            {parentOptions.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.code} · {acc.name}
              </option>
            ))}
          </select>
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createAccount} disabled={saving}>
              {saving ? "Saving..." : "Add account"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              placeholder="Search code/name/subtype"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as "ALL" | LedgerAccount["type"])}
            >
              <option value="ALL">All types</option>
              {accountTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "ALL" | "ACTIVE" | "INACTIVE")}
            >
              <option value="ALL">All status</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
            <Button
              variant={systemOnly ? "default" : "outline"}
              onClick={() => setSystemOnly((v) => !v)}
            >
              System only
            </Button>
            <Button
              variant={postingRulesOnly ? "default" : "outline"}
              onClick={() => setPostingRulesOnly((v) => !v)}
            >
              Used in posting rules only
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSearch("");
                setTypeFilter("ALL");
                setStatusFilter("ALL");
                setSystemOnly(false);
                setPostingRulesOnly(false);
              }}
            >
              Clear filters
            </Button>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading accounts...</p>
          ) : filteredAccounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounts yet.</p>
          ) : (
            <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Subtype</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((acc) => (
                  <TableRow key={acc.id}>
                    <TableCell className="font-mono">{acc.code}</TableCell>
                    <TableCell>{acc.name}</TableCell>
                    <TableCell>{acc.type}</TableCell>
                    <TableCell>{acc.subtype || "-"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {SYSTEM_ACCOUNT_CODES.has(acc.code) ? (
                          <Badge variant="outline">System</Badge>
                        ) : null}
                        {postingRuleCodes.has(acc.code) ? (
                          <Badge variant="secondary">Used in Posting Rules</Badge>
                        ) : null}
                        {!SYSTEM_ACCOUNT_CODES.has(acc.code) && !postingRuleCodes.has(acc.code) ? (
                          <span className="text-muted-foreground">-</span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>{acc.isActive ? "Active" : "Inactive"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(acc)}
                          disabled={SYSTEM_ACCOUNT_CODES.has(acc.code) || updating}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleArchive(acc)}
                          disabled={SYSTEM_ACCOUNT_CODES.has(acc.code) || updating}
                        >
                          {acc.isActive ? "Archive" : "Activate"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <Input value={editTarget?.code || ""} disabled />
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Account name" />
            <Input value={editSubtype} onChange={(e) => setEditSubtype(e.target.value)} placeholder="Subtype (optional)" />
            <Input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Description (optional)" />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={editParentAccountId}
              onChange={(e) => setEditParentAccountId(e.target.value)}
            >
              <option value="">No parent</option>
              {parentOptions
                .filter((acc) => acc.id !== editTarget?.id)
                .map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.code} · {acc.name}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={updating}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={updating}>
              {updating ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
