"use client";

/* eslint-disable @next/next/no-img-element */

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { MoreVertical, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { getProductStockBadge } from "../stockBadge";
import type { AdminProduct } from "../types";

export function ProductsDesktopTable({
  products,
  total,
  search,
  canShowCost,
  columnWidths,
  selectedIds,
  allVisibleSelected,
  sortField,
  sortDir,
  addProductAction,
  onToggleSelectAllVisible,
  onToggleSelected,
  onSortColumn,
  onStartResize,
  onEdit,
  onDelete,
  onArchiveToggle,
  onClearFilters,
}: {
  products: AdminProduct[];
  total: number;
  search: string;
  canShowCost: boolean;
  columnWidths: Record<string, number>;
  selectedIds: Set<string>;
  allVisibleSelected: boolean;
  sortField: "updatedAt" | "price" | "stock" | "name";
  sortDir: "asc" | "desc";
  addProductAction: ReactNode;
  onToggleSelectAllVisible: () => void;
  onToggleSelected: (id: string) => void;
  onSortColumn: (field: "updatedAt" | "price" | "stock" | "name") => void;
  onStartResize: (key: string, event: MouseEvent) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onArchiveToggle: (product: AdminProduct, archived: boolean) => Promise<void>;
  onClearFilters: () => void;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="flex items-center justify-between py-3">
        <CardTitle className="text-base font-semibold">Products</CardTitle>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </CardHeader>
      <CardContent className="p-0">
        <div className="hidden lg:block">
          <div className="overflow-x-auto">
            <Table className="admin-products-table table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[36px] relative" style={{ width: columnWidths.select }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allVisibleSelected}
                      onChange={onToggleSelectAllVisible}
                      aria-label="Select all visible products"
                    />
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("select", event)} />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none relative" style={{ width: columnWidths.name }} onClick={() => onSortColumn("name")}>
                    Name {sortField === "name" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("name", event)} />
                  </TableHead>
                  <TableHead className="relative" style={{ width: columnWidths.category }}>
                    Category
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("category", event)} />
                  </TableHead>
                  <TableHead className="relative" style={{ width: columnWidths.supplier }}>
                    Supplier
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("supplier", event)} />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none relative" style={{ width: columnWidths.price }} onClick={() => onSortColumn("price")}>
                    Price {sortField === "price" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("price", event)} />
                  </TableHead>
                  {canShowCost ? (
                    <TableHead className="relative" style={{ width: columnWidths.cost }}>
                      Cost
                      <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("cost", event)} />
                    </TableHead>
                  ) : null}
                  {canShowCost ? (
                    <TableHead className="relative" style={{ width: columnWidths.margin }}>
                      Margin
                      <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("margin", event)} />
                    </TableHead>
                  ) : null}
                  <TableHead className="cursor-pointer select-none relative" style={{ width: columnWidths.stock }} onClick={() => onSortColumn("stock")}>
                    Stock {sortField === "stock" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("stock", event)} />
                  </TableHead>
                  <TableHead className="cursor-pointer select-none relative" style={{ width: columnWidths.updated }} onClick={() => onSortColumn("updatedAt")}>
                    Updated {sortField === "updatedAt" ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("updated", event)} />
                  </TableHead>
                  <TableHead className="text-right relative" style={{ width: columnWidths.actions }}>
                    Actions
                    <div className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize" onMouseDown={(event) => onStartResize("actions", event)} />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(p.id)}
                        onChange={() => onToggleSelected(p.id)}
                        aria-label={`Select ${p.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {p.imageUrl ? (
                          <img src={p.imageUrl} alt="" className="h-8 w-8 rounded object-cover border flex-shrink-0" />
                        ) : (
                          <div className="h-8 w-8 rounded border bg-muted flex-shrink-0" />
                        )}
                        <div className="space-y-1 min-w-0">
                          {(() => {
                            const q = (search || "").trim();
                            const name: string = p.name || "";
                            const isPrefix = q.length > 0 && name.toLowerCase().startsWith(q.toLowerCase());
                            const prefix = isPrefix ? name.slice(0, q.length) : "";
                            const rest = isPrefix ? name.slice(q.length) : name;
                            const stockBadge = getProductStockBadge(Number(p.stock || 0));
                            const approvalThreshold =
                              typeof p.approvalThresholdQty === "number" && p.approvalThresholdQty > 0
                                ? p.approvalThresholdQty
                                : null;
                            return (
                              <span className={p.archived ? "opacity-60 line-through" : undefined}>
                                {isPrefix ? (
                                  <>
                                    <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                                    <span>{rest}</span>
                                  </>
                                ) : (
                                  <span>{name}</span>
                                )}
                                {stockBadge ? <span className={`ml-2 text-xs border rounded px-1.5 py-0.5 ${stockBadge.className}`}>{stockBadge.label}</span> : null}
                                {approvalThreshold ? <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">Approval ≥ {approvalThreshold}</span> : null}
                                {p.requiresLotTracking || p.requiresExpiryDate ? <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">Regulated</span> : null}
                                {p.archived ? <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span> : null}
                              </span>
                            );
                          })()}
                          {p.sku ? <div className="text-xs text-muted-foreground">SKU: {p.sku}</div> : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {PRODUCT_CATEGORY_LABELS[(p.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized"}
                    </TableCell>
                    <TableCell>{p.supplier || "Unknown"}</TableCell>
                    <TableCell>{formatCurrency(Number(p.price))}</TableCell>
                    {canShowCost ? <TableCell>{formatCurrency(Number(p.cost || 0))}</TableCell> : null}
                    {canShowCost ? (
                      <TableCell>
                        {(() => {
                          const price = Number(p.price || 0);
                          const cost = Number(p.cost || 0);
                          const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
                          const minMargin = typeof p.minMarginPct === "number" ? p.minMarginPct : null;
                          const belowMin = minMargin != null && Number.isFinite(minMargin) && marginPct < minMargin;
                          const belowCost = price > 0 && price < cost;
                          const color = belowCost || belowMin ? "text-red-600" : "text-emerald-600";
                          return (
                            <span className={color} title={minMargin != null ? `Min ${minMargin}%` : undefined}>
                              {Number.isFinite(marginPct) ? `${marginPct.toFixed(1)}%` : "0.0%"}
                            </span>
                          );
                        })()}
                      </TableCell>
                    ) : null}
                    <TableCell>{p.stock}</TableCell>
                    <TableCell title={new Date(p.updatedAt).toLocaleString()}>
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right w-[200px] overflow-visible">
                      <div className="flex w-full items-center justify-end">
                        <DropdownMenu>
                          <Tooltip content="Edit or delete this product">
                            <DropdownMenuTrigger asChild>
                              <Button variant="outline" size="sm">
                                Actions <MoreVertical className="ml-1 h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                          </Tooltip>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => onEdit(p.id)}>Edit</DropdownMenuItem>
                            <DropdownMenuItem asChild>
                              <Link href={`/admin/stock-adjustments?productId=${encodeURIComponent(p.id)}&q=${encodeURIComponent(p.sku || p.name)}`}>
                                Adjust inventory
                              </Link>
                            </DropdownMenuItem>
                            {!p.archived ? (
                              <DropdownMenuItem asChild>
                                <a href={`/products/${p.id}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                                  View on storefront
                                  <ExternalLink className="h-3 w-3 ml-auto opacity-60" />
                                </a>
                              </DropdownMenuItem>
                            ) : null}
                            {p.archived ? (
                              <DropdownMenuItem onClick={() => { void onArchiveToggle(p, false); }}>
                                Unarchive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                disabled={Number(p.stock || 0) > 0}
                                onClick={() => { void onArchiveToggle(p, true); }}
                              >
                                {Number(p.stock || 0) > 0 ? "Archive (stock must be 0)" : "Archive"}
                              </DropdownMenuItem>
                            )}
                            {(p.orderCount ?? 0) === 0 ? (
                              <DropdownMenuItem variant="destructive" onClick={() => onDelete(p.id)}>
                                Delete
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                                Delete hidden (order history)
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {products.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canShowCost ? 10 : 8} className="text-center py-6 text-muted-foreground">
                      <div className="flex flex-col items-center gap-3">
                        <span>No products found.</span>
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button size="sm" variant="outline" onClick={onClearFilters}>
                            Clear filters
                          </Button>
                          {addProductAction}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
