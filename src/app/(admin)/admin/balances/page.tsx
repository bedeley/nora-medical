"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Balance = {
  id: string;
  totalDue: number;
  totalPaid: number;
  balance: number;
  updatedAt: string | Date;
  user?: { name?: string | null; email?: string | null; phone?: string | null } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function AdminBalancesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [intervalMs, setIntervalMs] = useState<number>(3000);
  const [search, setSearch] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const initialized = useRef(false);

  // Initialize from URL
  useEffect(() => {
    if (initialized.current) return;
    const raw = searchParams.get("interval");
    const n = raw ? Number(raw) : 3000;
    if (!Number.isNaN(n) && n >= 0) setIntervalMs(n);
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect to URL
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams.toString());
    const nextInterval = intervalMs && intervalMs > 0 ? String(intervalMs) : "0";
    const currentInterval = params.get("interval") || "0";
    if (currentInterval === nextInterval) return;
    params.set("interval", nextInterval);
    const next = `${pathname}?${params.toString()}`;
    router.replace(next, { scroll: false });
  }, [intervalMs, pathname, router, searchParams]);

  const { data, error, isLoading } = useClientQuery<Balance[]>({
    queryKey: ["admin", "balances", { intervalMs }],
    queryFn: () => fetcher("/api/balance"),
    refetchInterval: intervalMs || false,
    staleTime: 0,
    gcTime: 0,
  });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data || [])
      .filter((b) => (dueOnly ? b.balance > 0.005 : true))
      .filter((b) => {
        if (!term) return true;
        const name = String(b.user?.name || "").toLowerCase();
        const email = String(b.user?.email || "").toLowerCase();
        const phone = String(b.user?.phone || "").toLowerCase();
        return name.includes(term) || email.includes(term) || phone.includes(term);
      })
      .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
  }, [data, dueOnly, search]);

  const summary = useMemo(() => {
    const totalDue = filtered.reduce((sum, b) => sum + Number(b.totalDue || 0), 0);
    const totalPaid = filtered.reduce((sum, b) => sum + Number(b.totalPaid || 0), 0);
    const totalBalance = filtered.reduce((sum, b) => sum + Number(b.balance || 0), 0);
    const dueCount = filtered.filter((b) => b.balance > 0.005).length;
    return { totalDue, totalPaid, totalBalance, dueCount };
  }, [filtered]);

  const emailStatement = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/customers/${id}/statement/email`, {
        method: "POST",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to email statement.");
      toast.success("Statement emailed.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to email statement.");
    }
  };

  if (error) {
    return (
      <section className="container mx-auto py-8">
        <h1 className="text-2xl font-semibold mb-2">Customer Balances</h1>
        <p className="text-red-600">Failed to load balances.</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 space-y-6">
      <header className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customer Balances</h1>
          <p className="text-sm text-muted-foreground">
            Review outstanding balances across customers.
          </p>
        </div>
      </header>

      <Card className="shadow-sm">
        <CardHeader className="py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, email, phone"
            className="w-full sm:w-64"
          />
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={dueOnly}
              onChange={(e) => setDueOnly(e.target.checked)}
            />
            Due only
          </label>
          <label htmlFor="refresh-interval" className="text-muted-foreground">
            Refresh:
          </label>
          <select
            id="refresh-interval"
            className="border rounded px-2 py-1 bg-background"
            value={String(intervalMs)}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            title="Auto-refresh interval"
          >
            <option value="0">Off</option>
            <option value="3000">3s</option>
            <option value="5000">5s</option>
            <option value="10000">10s</option>
            <option value="30000">30s</option>
          </select>
          <Button
            size="sm"
            variant="outline"
            title="Copy current URL with refresh setting"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success("Link copied");
              } catch (e) {
                console.error(e);
                toast.error("Could not copy link");
              }
            }}
          >
            Copy Link
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="py-3">
          <CardTitle className="text-base font-semibold">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Total due</div>
            <div className="text-lg font-semibold">{formatCurrency(summary.totalDue)}</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Total paid</div>
            <div className="text-lg font-semibold">{formatCurrency(summary.totalPaid)}</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Outstanding</div>
            <div className="text-lg font-semibold">{formatCurrency(summary.totalBalance)}</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs text-muted-foreground">Customers due</div>
            <div className="text-lg font-semibold">{summary.dueCount}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="flex items-center justify-between py-3">
          <CardTitle className="text-base font-semibold">Balances</CardTitle>
          <span className="text-xs text-muted-foreground">
            {isLoading ? "—" : `${filtered.length} customers`}
          </span>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Total Due</TableHead>
            <TableHead>Total Paid</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead>Last Updated</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-6">
                Loading...
              </TableCell>
            </TableRow>
          ) : filtered.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-6">
                <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
                  <span>No balances found.</span>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.location.reload()}
                    >
                      Refresh
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.location.assign("/admin/customers")}
                    >
                      View customers
                    </Button>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.user?.name ?? "-"}</TableCell>
                <TableCell>{b.user?.email ?? "-"}</TableCell>
                <TableCell>{b.user?.phone ?? "-"}</TableCell>
                <TableCell>{formatCurrency(b.totalDue)}</TableCell>
                <TableCell>{formatCurrency(b.totalPaid)}</TableCell>
                <TableCell
                  className={
                    b.balance > 0
                      ? "text-red-600 font-semibold"
                      : "text-green-600"
                  }
                >
                  {formatCurrency(b.balance)}
                </TableCell>
                <TableCell>
                  {new Date(b.updatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <a href={`/admin/customers/${b.id}/view`}>View</a>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(`/api/admin/customers/${b.id}/statement?format=pdf`, "_blank")}
                    >
                      Statement PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(`/api/admin/customers/${b.id}/statement?format=csv`, "_blank")}
                    >
                      Statement CSV
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => emailStatement(b.id)}
                    >
                      Email statement
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}

export default function AdminBalancesPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8">
          <h1 className="text-2xl font-semibold mb-2">Customer Balances</h1>
          <p className="text-sm text-muted-foreground">Loading balances…</p>
        </section>
      }
    >
      <AdminBalancesContent />
    </Suspense>
  );
}
