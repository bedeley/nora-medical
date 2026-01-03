"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  user?: { name?: string | null; email?: string | null } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function AdminBalancesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [intervalMs, setIntervalMs] = useState<number>(3000);
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
    if (intervalMs && intervalMs > 0) params.set("interval", String(intervalMs));
    else params.set("interval", "0");
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
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
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
        <CardHeader className="flex items-center justify-between py-3">
          <CardTitle className="text-base font-semibold">Balances</CardTitle>
          <span className="text-xs text-muted-foreground">
            {isLoading || !data ? "—" : `${data.length} customers`}
          </span>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Total Due</TableHead>
            <TableHead>Total Paid</TableHead>
            <TableHead>Balance</TableHead>
            <TableHead>Last Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading || !data ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-6">
                Loading...
              </TableCell>
            </TableRow>
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center py-6">
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
            data.map((b) => (
              <TableRow key={b.id}>
                <TableCell>{b.user?.name ?? "-"}</TableCell>
                <TableCell>{b.user?.email ?? "-"}</TableCell>
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
