"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebounce } from "use-debounce";
import { toast } from "sonner";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type SortKey = "price" | "stock" | "totalValue" | "salesValue" | "costValue";

type Row = {
  id: string;
  name: string;
  price: number;
  cost?: number;
  stock: number;
  totalValue: number;
  avgPurchaseCost?: number | null;
  lastPurchaseCost?: number | null;
  lastPurchaseDate?: string | null;
  lastPurchaseSupplier?: string | null;
  lastPurchaseNote?: string | null;
};

function InventoryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const { data, isLoading } = useClientQuery<{ rows: Row[] }>({
    queryKey: ["admin", "inventory"],
    queryFn: () => fetcher("/api/admin/inventory"),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const rows: Row[] = useMemo(() => data?.rows || [], [data]);
  const [q, setQ] = useState("");
  const [qDeb] = useDebounce(q, 300);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [minStock, setMinStock] = useState<string>("");
  const [maxStock, setMaxStock] = useState<string>("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [valuationMode, setValuationMode] = useState<"sales" | "cost">("sales");
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoRow, setInfoRow] = useState<Row | null>(null);
  const [updatedAtText, setUpdatedAtText] = useState<string>("");

  // Initialize from URL
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const q0 = sp.get("q") || "";
    const ms0 = sp.get("minStock") || "";
    const xs0 = sp.get("maxStock") || "";
    const mp0 = sp.get("minPrice") || "";
    const xp0 = sp.get("maxPrice") || "";
    const sk0 = sp.get("sortKey") as
      | "price"
      | "stock"
      | "totalValue"
      | "salesValue"
      | "costValue"
      | null;
    const sd0 = sp.get("sortDir") as "asc" | "desc" | null;
    setQ(q0);
    setMinStock(ms0);
    setMaxStock(xs0);
    setMinPrice(mp0);
    setMaxPrice(xp0);
    if (sk0 && ["price", "stock", "totalValue", "salesValue", "costValue"].includes(sk0)) {
      setSortKey(sk0);
    }
    if (sd0 && ["asc", "desc"].includes(sd0)) setSortDir(sd0);
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect to URL (avoid using searchParams as a dependency to prevent loops)
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    else params.delete("q");
    if (minStock) params.set("minStock", minStock);
    else params.delete("minStock");
    if (maxStock) params.set("maxStock", maxStock);
    else params.delete("maxStock");
    if (minPrice) params.set("minPrice", minPrice);
    else params.delete("minPrice");
    if (maxPrice) params.set("maxPrice", maxPrice);
    else params.delete("maxPrice");
    if (sortKey) params.set("sortKey", sortKey);
    else params.delete("sortKey");
    if (sortKey) params.set("sortDir", sortDir);
    else params.delete("sortDir");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [q, minStock, maxStock, minPrice, maxPrice, sortKey, sortDir, pathname, router]);

  // Client-only updated timestamp to avoid hydration mismatch
  useEffect(() => {
    setUpdatedAtText(new Date().toLocaleTimeString());
  }, [rows.length]);

  // Type-to-focus: focus search when typing outside inputs
  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!el || !(el as HTMLElement).tagName) return false;
      const tag = String((el as HTMLElement).tagName).toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      try {
        return !!(el as HTMLElement).isContentEditable;
      } catch {
        return false;
      }
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const el = searchRef.current;
        if (el) {
          el.value = '';
          setQ('');
          try { el.setSelectionRange(0, 0); } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (!k || k.length !== 1) return;
      const el = searchRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + k + el.value.slice(end);
      el.value = next;
      setQ(next);
      try {
        el.setSelectionRange(start + 1, start + 1);
      } catch {}
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, {
        capture: true,
      } as EventListenerOptions);
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const filteredRows = useMemo(() => {
    const ms = Number(minStock);
    const xs = Number(maxStock);
    const mp = Number(minPrice);
    const xp = Number(maxPrice);
    const hasMinStock = !Number.isNaN(ms) && minStock !== "";
    const hasMaxStock = !Number.isNaN(xs) && maxStock !== "";
    const hasMinPrice = !Number.isNaN(mp) && minPrice !== "";
    const hasMaxPrice = !Number.isNaN(xp) && maxPrice !== "";
    const ql = qDeb.trim().toLowerCase();
    return rows.filter((r) => {
      const price = Number(r.price || 0);
      const stock = Number(r.stock || 0);
      const nameOk = !ql || r.name.toLowerCase().includes(ql);
      const stockMinOk = !hasMinStock || stock >= ms;
      const stockMaxOk = !hasMaxStock || stock <= xs;
      const priceMinOk = !hasMinPrice || price >= mp;
      const priceMaxOk = !hasMaxPrice || price <= xp;
      return nameOk && stockMinOk && stockMaxOk && priceMinOk && priceMaxOk;
    });
  }, [rows, qDeb, minStock, maxStock, minPrice, maxPrice]);

  const sortedRows = useMemo(() => {
    const base = filteredRows;
    if (!sortKey) return base;
    const arr = [...base];
    arr.sort((a, b) => {
      const salesA = Number(a.price || 0) * Number(a.stock || 0);
      const salesB = Number(b.price || 0) * Number(b.stock || 0);
      const costA = Number(a.cost || 0) * Number(a.stock || 0);
      const costB = Number(b.cost || 0) * Number(b.stock || 0);
      const va =
        sortKey === "salesValue"
          ? salesA
          : sortKey === "costValue"
          ? costA
          : Number((a as Record<string, unknown>)[sortKey] ?? 0);
      const vb =
        sortKey === "salesValue"
          ? salesB
          : sortKey === "costValue"
          ? costB
          : Number((b as Record<string, unknown>)[sortKey] ?? 0);
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [filteredRows, sortKey, sortDir]);

  const totals = useMemo(() => {
    let priceValue = 0;
    let costValue = 0;
    for (const r of sortedRows) {
      const pv = Number(r.price || 0) * Number(r.stock || 0);
      const unitCost =
        typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
          ? r.avgPurchaseCost
          : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
          ? r.lastPurchaseCost
          : Number(r.cost || 0);
      const cv = unitCost * Number(r.stock || 0);
      priceValue += pv;
      costValue += cv;
    }
    return { priceValue, costValue };
  }, [sortedRows]);

  function downloadCSV() {
    const headers = ["Item", "Price", "Cost", "Stock", "Expected Total Sales Value", "Cost of Purchase"];
    const lines = [headers.join(",")];
    for (const r of sortedRows) {
      const pv = Number(r.price || 0) * Number(r.stock || 0);
      const unitCost =
        typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
          ? r.avgPurchaseCost
          : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
          ? r.lastPurchaseCost
          : Number(r.cost || 0);
      const cv = unitCost * Number(r.stock || 0);
      lines.push([
        JSON.stringify(r.name),
        Number(r.price || 0).toFixed(2),
        Number(r.cost || 0).toFixed(2),
        String(r.stock ?? 0),
        pv.toFixed(2),
        cv.toFixed(2),
      ].join(","));
    }
    lines.push(["Totals", "", "", "", totals.priceValue.toFixed(2), totals.costValue.toFixed(2)].join(","));
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full">
          <CardTitle>Inventory Valuation</CardTitle>
          <p className="text-sm text-muted-foreground">Realtime snapshot</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
          {(() => {
            const count = [
              q ? 1 : 0,
              minStock ? 1 : 0,
              maxStock ? 1 : 0,
              minPrice ? 1 : 0,
              maxPrice ? 1 : 0,
              sortKey ? 1 : 0,
            ].reduce((a, b) => a + b, 0);
            return count > 0 ? (
              <Badge variant="secondary" title="Active filters and sort">
                {count} active
              </Badge>
            ) : null;
          })()}
          <div className="flex flex-wrap items-center gap-1 mr-2">
            <Button
              size="sm"
              variant={valuationMode === "sales" ? "default" : "outline"}
              onClick={() => setValuationMode("sales")}
              title="Show Sales valuation total (Price x Stock)"
            >
              Sales
            </Button>
            <Button
              size="sm"
              variant={valuationMode === "cost" ? "default" : "outline"}
              onClick={() => setValuationMode("cost")}
              title="Show Cost valuation total (Cost x Stock)"
            >
              Cost
            </Button>

            <div className="w-full sm:w-auto text-sm text-muted-foreground">
              Valuation Total:{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(valuationMode === "sales" ? totals.priceValue : totals.costValue)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground underline decoration-dotted cursor-help"
              title={`Expected Sales = Price x Stock. Cost of Purchase = Unit Purchase Cost x Stock. P/L = (Expected Sales - Cost of Purchase).\nUse Sales/Cost buttons to switch the total shown. Click column headers to sort.`}
            >
              What is this?
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={downloadCSV}>
            Export CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
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
          <p className="text-sm text-muted-foreground" suppressHydrationWarning>
            Updated: {updatedAtText || "—"}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.some((r) => Number(r.stock || 0) < 0) && (
          <div className="mb-3 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
            Warning: One or more products have negative stock. Please review purchases and sales.
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 mb-4">
          <Input
            placeholder="Search item name..."
            value={q}
            ref={searchRef}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            className="sm:max-w-xs"
          />
          <Input
            placeholder="Min stock"
            type="number"
            inputMode="numeric"
            value={minStock}
            onChange={(e) => setMinStock(e.target.value)}
            className="sm:max-w-[140px]"
          />
          <Input
            placeholder="Max stock"
            type="number"
            inputMode="numeric"
            value={maxStock}
            onChange={(e) => setMaxStock(e.target.value)}
            className="sm:max-w-[140px]"
          />
          <Input
            placeholder="Min price"
            type="number"
            inputMode="decimal"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            className="sm:max-w-[160px]"
          />
          <Input
            placeholder="Max price"
            type="number"
            inputMode="decimal"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            className="sm:max-w-[160px]"
          />
          <Button
            variant="ghost"
            onClick={() => {
              setQ("");
              setMinStock("");
              setMaxStock("");
              setMinPrice("");
              setMaxPrice("");
              setSortKey(null);
              setSortDir("desc");
            }}
          >
            Reset
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Item</TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("price")}
                >
                  Price{sortIndicator("price")}
                </TableHead>
                <TableHead className="text-center">Cost</TableHead>
                <TableHead className="text-center">Last Unit Cost</TableHead>
                <TableHead className="text-center">Last Purchase</TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("stock")}
                >
                  Stock{sortIndicator("stock")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("salesValue")}
                >
                  Expected Total Sales Value{sortIndicator("salesValue")}
                </TableHead>
                <TableHead
                  className="text-center cursor-pointer select-none"
                  onClick={() => toggleSort("costValue")}
                >
                  Cost of Purchase{sortIndicator("costValue")}
                </TableHead>
                <TableHead className="text-center">Expected P/L</TableHead>
                <TableHead className="text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                    Loading inventory...
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
                    No products found.
                  </TableCell>
                </TableRow>
              )}
              {sortedRows.map((r) => (
                <TableRow key={r.id} className="odd:bg-muted/30">
                  <TableCell className="font-medium text-center">{String(r.name || "").replace(/^./, (c) => c.toUpperCase())}</TableCell>
                  <TableCell className="text-center">{formatCurrency(Number(r.price || 0))}</TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-2">
                      <Input
                        className="w-24 h-8"
                        type="number"
                        step="0.01"
                        value={Number(r.cost ?? 0).toFixed(2)}
                        readOnly
                        disabled
                        title="Cost is managed via Purchases"
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    {typeof r.lastPurchaseCost === "number" ? (
                      <Tooltip
                        content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
                      >
                        <span title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}>
                          {Number(r.lastPurchaseCost).toFixed(2)}
                        </span>
                      </Tooltip>
                    ) : (
                      "-"
                    )}
                    {r.lastPurchaseDate && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-1 align-middle"
                        aria-label="Show last purchase details"
                        title="Show last purchase details"
                        onClick={() => { setInfoRow(r); setInfoOpen(true); }}
                      >
                        <Info className="w-3 h-3" />
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {r.lastPurchaseDate ? (
                      <Tooltip
                        content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
                      >
                        <span title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}>
                          {new Date(r.lastPurchaseDate).toLocaleDateString()}
                        </span>
                      </Tooltip>
                    ) : (
                      "-"
                    )}
                    {r.lastPurchaseDate && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-1 align-middle"
                        aria-label="Show last purchase details"
                        title="Show last purchase details"
                        onClick={() => { setInfoRow(r); setInfoOpen(true); }}
                      >
                        <Info className="w-3 h-3" />
                      </Button>
                    )}
                  </TableCell>
                  <TableCell className="text-center">{r.stock}</TableCell>
                  {(() => {
                    const pv = Number(r.price || 0) * Number(r.stock || 0);
                    const unitCost =
                      typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
                        ? r.avgPurchaseCost
                        : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
                        ? r.lastPurchaseCost
                        : Number(r.cost || 0);
                    const cv = unitCost * Number(r.stock || 0);
                    const diff = pv - cv;
                    return (
                      <>
                        <TableCell
                          className="text-center"
                          title={`Expected Total Sales Value = Price × Stock = ${Number(r.price || 0).toFixed(2)} × ${Number(r.stock || 0)} = ${pv.toFixed(2)}`}
                        >
                          <Tooltip content={`Expected Total Sales Value = Price x Stock = ${Number(r.price || 0).toFixed(2)} x ${Number(r.stock || 0)} = ${pv.toFixed(2)}`}>
                            <span>{formatCurrency(pv)}</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell
                          className="text-center"
                          title={`Cost of Purchase = Unit Purchase Cost × Stock = ${unitCost.toFixed(2)} × ${Number(r.stock || 0)} = ${cv.toFixed(2)}`}
                        >
                          <Tooltip content={`Cost of Purchase = Unit Purchase Cost x Stock = ${unitCost.toFixed(2)} x ${Number(r.stock || 0)} = ${cv.toFixed(2)}`}>
                            <span>{formatCurrency(cv)}</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell
                          className={`text-center font-medium ${diff >= 0 ? "text-green-600" : "text-red-600"}`}
                          title={`Expected P/L = Expected Sales - Cost of Purchase = ${pv.toFixed(2)} - ${cv.toFixed(2)} = ${diff.toFixed(2)}`}
                          >
                          <Tooltip content={`P/L = Expected Sales - Cost of Purchase = ${pv.toFixed(2)} - ${cv.toFixed(2)} = ${diff.toFixed(2)}`}>
                            <span>{formatCurrency(diff)}</span>
                          </Tooltip>
                        </TableCell>
                      </>
                    );
                  })()}
                  <TableCell className="text-center">
                    <a
                      href={`/admin/purchases?product=${encodeURIComponent(r.id)}#new`}
                      className="text-primary underline-offset-2 hover:underline"
                      title="Add Purchase for this product"
                    >
                      Add Purchase
                    </a>
                  </TableCell>
                </TableRow>
              ))}
              {sortedRows.length > 0 && (
                <TableRow className="border-t-2 border-border bg-muted/30">
                  <TableCell colSpan={6} className="text-center font-semibold py-2">
                    Totals
                  </TableCell>
                  <TableCell className="text-center font-semibold py-2">{formatCurrency(totals.priceValue)}</TableCell>
                  <TableCell className="text-center font-semibold py-2">{formatCurrency(totals.costValue)}</TableCell>
                  <TableCell className="py-2" />
                  <TableCell className="py-2" />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Last Purchase Details</DialogTitle>
          </DialogHeader>
          {infoRow && (
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{String(infoRow.name || "").replace(/^./, (c) => c.toUpperCase())}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{infoRow.lastPurchaseDate ? new Date(infoRow.lastPurchaseDate).toLocaleDateString() : "-"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Last Unit Cost</span><span>{typeof infoRow.lastPurchaseCost === 'number' ? Number(infoRow.lastPurchaseCost).toFixed(2) : "-"}</span></div>
              {infoRow.lastPurchaseSupplier ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{infoRow.lastPurchaseSupplier}</span></div>
              ) : null}
              {infoRow.lastPurchaseNote ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Note</span><span>{infoRow.lastPurchaseNote}</span></div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function Inventory() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle>Inventory</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading inventory…</p>
          </CardContent>
        </Card>
      }
    >
      <InventoryContent />
    </Suspense>
  );
}







