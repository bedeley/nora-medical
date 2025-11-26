"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
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
      <section>
        <h1 className="text-2xl font-semibold mb-4">Customer Balances</h1>
        <p className="text-red-600">Failed to load balances.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Customer Balances</h1>
        <div className="flex items-center gap-2 text-sm">
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
        </div>
      </div>
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
                No balances found.
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
    </section>
  );
}

export default function AdminBalancesPage() {
  return (
    <Suspense
      fallback={
        <section>
          <h1 className="text-2xl font-semibold mb-4">Customer Balances</h1>
          <p className="text-sm text-muted-foreground">Loading balances…</p>
        </section>
      }
    >
      <AdminBalancesContent />
    </Suspense>
  );
}
