"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

type AuditFilters = {
  actions: string[];
  entityTypes: string[];
  actors: { id: string; name: string | null; email: string | null; role: string }[];
};

type AuditSavedFilter = {
  id: string;
  name: string;
  state: {
    entityType: string;
    entityId: string;
    customerId: string;
    action: string;
    actorId: string;
    start: string;
    end: string;
    pageSize: number;
  };
};

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j as AuditRow[];
};

function AdminAuditContent() {
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const [entityType, setEntityType] = useState("");
  const [entityId, setEntityId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [savedFilters, setSavedFilters] = useState<AuditSavedFilter[]>([]);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    when: 180,
    actor: 240,
    action: 180,
    entity: 180,
    meta: 360,
  });
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const [tableClientWidth, setTableClientWidth] = useState(0);

  useEffect(() => {
    if (initialized.current) return;
    const et = searchParams.get("entityType") || "";
    const ei = searchParams.get("entityId") || "";
    const ci = searchParams.get("customerId") || "";
    const act = searchParams.get("action") || "";
    const actor = searchParams.get("actorId") || "";
    const s = searchParams.get("start") || "";
    const e = searchParams.get("end") || "";
    setEntityType(et.toUpperCase());
    setEntityId(ei);
    setCustomerId(ci);
    setAction(act.toUpperCase());
    setActorId(actor);
    setStart(s);
    setEnd(e);
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-audit-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as AuditSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-audit-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-audit-column-widths");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setColumnWidths((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-audit-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(120, startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [key]: next }));
    };
    const handleUp = () => {
      if (!resizing.current) return;
      resizing.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 160,
    };
    document.body.style.cursor = "col-resize";
  };

  const params = new URLSearchParams();
  if (entityType) params.set("entityType", entityType);
  if (entityId) params.set("entityId", entityId);
  if (customerId) params.set("customerId", customerId);
  if (action) params.set("action", action);
  if (actorId) params.set("actorId", actorId);
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const queryKey = ["admin", "audit", entityType, entityId, customerId, action, actorId, start, end];

  const { data: filterData } = useClientQuery({
    queryKey: ["admin", "audit", "filters"],
    queryFn: async () => {
      const r = await fetch("/api/admin/audit/filters");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
      return j as AuditFilters;
    },
    refetchInterval: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const filterActions = useMemo(() => filterData?.actions ?? [], [filterData]);
  const filterEntityTypes = useMemo(() => filterData?.entityTypes ?? [], [filterData]);
  const filterActors = useMemo(() => filterData?.actors ?? [], [filterData]);

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

  useEffect(() => {
    const updateWidths = () => {
      const container = tableWrapRef.current?.querySelector<HTMLDivElement>(
        '[data-slot="table-container"]',
      );
      if (!container) return;
      setTableScrollWidth(container.scrollWidth);
      setTableClientWidth(container.clientWidth);
    };
    const raf = window.requestAnimationFrame(updateWidths);
    window.addEventListener("resize", updateWidths);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateWidths);
    };
  }, [columnWidths, data]);

  useEffect(() => {
    const top = topScrollRef.current;
    const container = tableWrapRef.current?.querySelector<HTMLDivElement>(
      '[data-slot="table-container"]',
    );
    if (!top || !container) return;
    const syncTop = () => {
      if (container.scrollLeft !== top.scrollLeft) {
        container.scrollLeft = top.scrollLeft;
      }
    };
    const syncBottom = () => {
      if (top.scrollLeft !== container.scrollLeft) {
        top.scrollLeft = container.scrollLeft;
      }
    };
    top.addEventListener("scroll", syncTop);
    container.addEventListener("scroll", syncBottom);
    return () => {
      top.removeEventListener("scroll", syncTop);
      container.removeEventListener("scroll", syncBottom);
    };
  }, [tableScrollWidth]);

  const clearFilters = () => {
    setEntityType("");
    setEntityId("");
    setCustomerId("");
    setAction("");
    setActorId("");
    setPage(1);
  };

  const clearAll = () => {
    clearFilters();
    setStart("");
    setEnd("");
    setPage(1);
  };

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this saved filter");
    if (!name) return;
    const entry: AuditSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        entityType,
        entityId,
        customerId,
        action,
        actorId,
        start,
        end,
        pageSize,
      },
    };
    setSavedFilters((prev) => [entry, ...prev]);
  };

  const applySavedFilter = (entry: AuditSavedFilter) => {
    const s = entry.state;
    setEntityType(s.entityType);
    setEntityId(s.entityId);
    setCustomerId(s.customerId);
    setAction(s.action);
    setActorId(s.actorId);
    setStart(s.start);
    setEnd(s.end);
    setPageSize(s.pageSize);
    setPage(1);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const getColWidth = (id: string) => columnWidths[id] ?? 160;

  const toDateInput = (value: Date) => value.toISOString().slice(0, 10);
  const applyPreset = (preset: {
    entityType?: string;
    action?: string;
    days?: number;
  }) => {
    const today = new Date();
    const startDate = preset.days ? new Date(today.getTime() - preset.days * 24 * 60 * 60 * 1000) : null;
    setEntityType(preset.entityType ?? "");
    setAction(preset.action ?? "");
    setStart(startDate ? toDateInput(startDate) : "");
    setEnd(toDateInput(today));
    setPage(1);
  };

  return (
    <section className="container mx-auto py-6 max-w-5xl space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Audit Log</h1>
          <p className="text-sm text-muted-foreground">
            Recent admin, staff, and accountant activity across orders, payments, inventory, and expenses.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const exportParams = new URLSearchParams(params.toString());
              exportParams.set("format", "csv");
              window.open(`/api/admin/audit?${exportParams.toString()}`, "_blank");
            }}
          >
            Export CSV
          </Button>
        </div>
      </header>

      <Card className="shadow-md !border-none">
        <CardHeader className="flex items-center justify-between space-y-0 py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Saved filters
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={saveCurrentFilter}>
                  Save current filter
                </DropdownMenuItem>
                {savedFilters.length === 0 ? (
                  <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                ) : (
                  savedFilters.map((entry) => (
                    <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-4">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => applySavedFilter(entry)}
                      >
                        {entry.name}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeSavedFilter(entry.id);
                        }}
                      >
                        Remove
                      </Button>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAll}
            >
              Clear all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Entity type</label>
          <select
            className="h-9 w-full min-w-0 rounded border bg-background px-2 text-sm"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value.toUpperCase())}
          >
            <option value="">All</option>
            {filterEntityTypes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
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
          <label className="text-xs text-muted-foreground">Customer ID</label>
          <Input
            placeholder="Customer ID"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Action</label>
          <select
            className="h-9 w-full min-w-0 rounded border bg-background px-2 text-sm"
            value={action}
            onChange={(e) => setAction(e.target.value.toUpperCase())}
          >
            <option value="">All</option>
            {filterActions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Actor ID</label>
          <select
            className="h-9 w-full rounded border bg-background px-2 text-sm"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          >
            <option value="">All</option>
            <option value="system">System</option>
            {filterActors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.name || actor.email || actor.id}
              </option>
            ))}
          </select>
        </div>
          </div>

          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
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
            <div className="space-y-1 sm:col-span-2 lg:col-span-2">
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

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Quick action filter</label>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Button
                type="button"
                variant={entityType === "EXPENSE" && action === "" ? "default" : "outline"}
                size="sm"
                onClick={() => { setEntityType("EXPENSE"); setAction(""); }}
              >
                Expenses
              </Button>
              <Button
                type="button"
                variant={action === "ORDER_ITEM_DELIVERY_UPDATE" ? "default" : "outline"}
                size="sm"
                onClick={() => setAction("ORDER_ITEM_DELIVERY_UPDATE")}
              >
                Delivery
              </Button>
              <Button
                type="button"
                variant={action === "PAYMENT_REFUND" ? "default" : "outline"}
                size="sm"
                onClick={() => setAction("PAYMENT_REFUND")}
              >
                Refunds
              </Button>
              <Button
                type="button"
                variant={action === "PRODUCT_STOCK_UPDATE" ? "default" : "outline"}
                size="sm"
                onClick={() => setAction("PRODUCT_STOCK_UPDATE")}
              >
                Stock Updates
              </Button>
              <Button
                type="button"
                variant={action === "ORDER_CANCEL" ? "default" : "outline"}
                size="sm"
                onClick={() => setAction("ORDER_CANCEL")}
              >
                Cancellations
              </Button>
              <Button
                type="button"
                variant={action === "EXPENSE_CREATE" ? "default" : "outline"}
                size="sm"
                onClick={() => { setEntityType("EXPENSE"); setAction("EXPENSE_CREATE"); }}
              >
                Expense Create
              </Button>
              <Button
                type="button"
                variant={action === "EXPENSE_UPDATE" ? "default" : "outline"}
                size="sm"
                onClick={() => { setEntityType("EXPENSE"); setAction("EXPENSE_UPDATE"); }}
              >
                Expense Update
              </Button>
              <Button
                type="button"
                variant={action === "EXPENSE_DELETE" ? "default" : "outline"}
                size="sm"
                onClick={() => { setEntityType("EXPENSE"); setAction("EXPENSE_DELETE"); }}
              >
                Expense Delete
              </Button>
              <Button
                type="button"
                variant={action === "" ? "default" : "outline"}
                size="sm"
                onClick={() => setAction("")}
              >
                All
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Saved filters</label>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset({ days: 7 })}
              >
                All activity (7 days)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset({ entityType: "EXPENSE", days: 7 })}
              >
                Expenses (7 days)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset({ action: "PAYMENT_REFUND", days: 30 })}
              >
                Refunds (30 days)
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset({ action: "PRODUCT_STOCK_UPDATE", days: 7 })}
              >
                Stock updates (7 days)
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <p className="text-sm text-red-600">
          Failed to load audit log: {(error as Error).message}
        </p>
      ) : null}

      <Card className="shadow-md !border-none">
        <CardContent className="p-0">
          {tableScrollWidth > tableClientWidth + 2 ? (
            <div className="border-b px-4 py-2">
              <div ref={topScrollRef} className="overflow-x-auto">
                <div
                  className="h-2"
                  style={{ width: Math.max(tableScrollWidth, tableClientWidth) }}
                />
              </div>
            </div>
          ) : null}
          <div ref={tableWrapRef}>
            <Table className="min-w-[1100px] text-xs table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="relative" style={{ width: getColWidth("when") }}>
                    When
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("when", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("actor") }}>
                    Actor
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("actor", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("action") }}>
                    Action
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("action", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("entity") }}>
                    Entity
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("entity", event)}
                    />
                  </TableHead>
                  <TableHead className="relative" style={{ width: getColWidth("meta") }}>
                    Meta
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("meta", event)}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                      {isFetching ? (
                        "Loading activity…"
                      ) : (
                        <div className="flex flex-col items-center gap-3">
                          <span>No activity found for the current filters.</span>
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button size="sm" variant="outline" onClick={clearAll}>
                              Clear filters
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => applyPreset({ days: 7 })}
                            >
                              Last 7 days
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell style={{ width: getColWidth("when") }}>
                        <span className="block truncate">
                          {new Date(row.createdAt).toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell style={{ width: getColWidth("actor") }}>
                        {row.actor ? (
                          <div className="min-w-0 space-y-0.5">
                            <div className="font-medium text-xs truncate">
                              {row.actor.name || row.actor.email || row.actor.id}
                            </div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {row.actor.email}
                              {row.actor.role ? ` · ${row.actor.role}` : ""}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">System</span>
                        )}
                      </TableCell>
                      <TableCell style={{ width: getColWidth("action") }}>
                        <span className="block font-mono text-[11px] truncate">{row.action}</span>
                      </TableCell>
                      <TableCell style={{ width: getColWidth("entity") }}>
                        <div className="min-w-0 space-y-0.5">
                          <span className="block font-mono text-[11px] truncate">{row.entityType}</span>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {formatIdReadable(row.entityId)}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal break-words" style={{ width: getColWidth("meta") }}>
                        {row.meta ? (
                          <div className="min-w-0 max-w-full break-words text-[11px] text-muted-foreground">
                            {(() => {
                              const entries = Object.entries(row.meta).filter(([k]) => {
                                if (k === "productId" && row.meta?.name) return false;
                                if (
                                  k === "customerId" &&
                                  (row.meta?.customerName || row.meta?.customerEmail)
                                ) return false;
                                return true;
                              });
                              const reasonIdx = entries.findIndex(([k]) => k === "reason");
                              if (reasonIdx > 0) {
                                const [reasonEntry] = entries.splice(reasonIdx, 1);
                                entries.unshift(reasonEntry);
                              }
                              return entries.slice(0, 5).map(([k, v]) => {
                                let display = String(v);
                                const isChanges = k === "changes" && v && typeof v === "object";
                                if (isChanges) {
                                  const entries = Object.entries(v as Record<string, { from?: unknown; to?: unknown }>);
                                  display = entries
                                    .map(([field, change]) => {
                                      const from = change?.from ?? null;
                                      const to = change?.to ?? null;
                                      return `${field}: ${String(from)} -> ${String(to)}`;
                                    })
                                    .join(", ");
                                }
                                if (!isChanges && v && typeof v === "object") {
                                  try {
                                    display = JSON.stringify(v);
                                  } catch {
                                    display = String(v);
                                  }
                                }
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
                              });
                            })()}
                            {Object.keys(row.meta).length > 5 ? (
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
        </CardContent>
      </Card>

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

export default function AdminAuditPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading audit log…</div>}>
      <AdminAuditContent />
    </Suspense>
  );
}
