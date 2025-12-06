"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatIdReadable } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";

type AuditRow = {
  id: string;
  actor?: { id: string; email: string | null; name: string | null; role: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as AuditRow[];
};

export default function AdminAuditPage() {
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const params = new URLSearchParams();
  if (entityType) params.set("entityType", entityType);
  if (entityId) params.set("entityId", entityId);
  if (action) params.set("action", action);
  if (actorId) params.set("actorId", actorId);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const queryKey = ["admin", "audit", entityType, entityId, action, actorId, start, end];

  const { data, error, isFetching } = useClientQuery({
    queryKey,
    queryFn: () => fetcher(`/api/admin/audit?${params.toString()}`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const rows = useMemo(
    () => (Array.isArray(data) ? data : []),
    [data],
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(50);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedRows = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return rows.slice(startIndex, startIndex + pageSize);
  }, [rows, currentPage, pageSize]);

  return (
    <section className="container mx-auto py-6 max-w-5xl space-y-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Recent admin, staff, and accountant activity across orders, payments, inventory, and expenses.
          </p>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Entity type</label>
          <Input
            placeholder="ORDER, PAYMENT, PURCHASE..."
            value={entityType}
            onChange={(e) => setEntityType(e.target.value.toUpperCase())}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Entity ID</label>
          <Input
            placeholder="Order or payment ID"
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Action</label>
          <Input
            placeholder="ORDER_UPDATE, PAYMENT_CREATE..."
            value={action}
            onChange={(e) => setAction(e.target.value.toUpperCase())}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Actor ID</label>
          <Input
            placeholder="Admin user ID"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">From (date)</label>
          <Input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">To (date)</label>
          <Input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Quick entity filter</label>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Button
              type="button"
              variant={entityType === "ORDER" ? "default" : "outline"}
              size="sm"
              onClick={() => setEntityType("ORDER")}
            >
              Orders
            </Button>
            <Button
              type="button"
              variant={entityType === "PAYMENT" ? "default" : "outline"}
              size="sm"
              onClick={() => setEntityType("PAYMENT")}
            >
              Payments
            </Button>
            <Button
              type="button"
              variant={entityType === "PURCHASE" ? "default" : "outline"}
              size="sm"
              onClick={() => setEntityType("PURCHASE")}
            >
              Purchases
            </Button>
            <Button
              type="button"
              variant={entityType === "EXPENSE" ? "default" : "outline"}
              size="sm"
              onClick={() => setEntityType("EXPENSE")}
            >
              Expenses
            </Button>
            <Button
              type="button"
              variant={entityType === "" ? "default" : "outline"}
              size="sm"
              onClick={() => setEntityType("")}
            >
              All
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-red-600">
          Failed to load audit log: {(error as Error).message}
        </p>
      ) : null}

      <div className="border rounded-md overflow-x-auto">
        <Table className="min-w-[900px] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">When</TableHead>
              <TableHead className="w-[200px]">Actor</TableHead>
              <TableHead className="w-[140px]">Action</TableHead>
              <TableHead className="w-[140px]">Entity</TableHead>
              <TableHead className="w-[260px]">Meta</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                  {isFetching ? "Loading activity…" : "No activity found for the current filters."}
                </TableCell>
              </TableRow>
            ) : (
              paginatedRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                  <TableCell>
                    {row.actor ? (
                      <div className="space-y-0.5">
                        <div className="font-medium text-xs">
                          {row.actor.name || row.actor.email || row.actor.id}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {row.actor.email}
                          {row.actor.role ? ` · ${row.actor.role}` : ""}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">System</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-[11px]">{row.action}</span>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-0.5">
                      <span className="font-mono text-[11px]">{row.entityType}</span>
                      <div className="text-[11px] text-muted-foreground break-all">
                        {formatIdReadable(row.entityId)}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {row.meta ? (
                      <div className="max-w-xs break-words text-[11px] text-muted-foreground">
                        {Object.entries(row.meta)
                          .slice(0, 4)
                          .map(([k, v]) => {
                            let display = String(v);
                            if (typeof v === "string" && /id$/i.test(k)) {
                              display = formatIdReadable(v);
                            } else if (
                              (k === "refundAmount" || /amount$/i.test(k)) &&
                              (typeof v === "number" ||
                                (typeof v === "string" && !Number.isNaN(Number(v))))
                            ) {
                              display = formatCurrency(Number(v));
                            }
                            return (
                              <div key={k}>
                                <span className="font-medium">{k}:</span>{" "}
                                <span>{display}</span>
                              </div>
                            );
                          })}
                        {Object.keys(row.meta).length > 4 ? (
                          <div className="italic">…</div>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-xs text-muted-foreground flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span>
            Page {currentPage} of {totalPages} ({total} event{total === 1 ? "" : "s"})
          </span>
          <div className="flex items-center gap-1">
            <span>Rows per page:</span>
            <select
              className="h-7 rounded border bg-background px-1 text-xs"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value) || 50;
                setPageSize(next);
                setPage(1);
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching}
            onClick={() => window.location.reload()}
          >
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}
