"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import { getProductStockBadge } from "../stockBadge";
import type { AdminProduct } from "../types";

export function ProductsMobileList({
  products,
  search,
  canShowCost,
  selectedIds,
  addProductAction,
  onToggleSelected,
  onEdit,
  onArchiveToggle,
  onDelete,
  onClearFilters,
}: {
  products: AdminProduct[];
  search: string;
  canShowCost: boolean;
  selectedIds: Set<string>;
  addProductAction: ReactNode;
  onToggleSelected: (id: string) => void;
  onEdit: (id: string) => void;
  onArchiveToggle: (product: AdminProduct, archived: boolean) => Promise<void>;
  onDelete: (id: string) => void;
  onClearFilters: () => void;
}) {
  return (
    <div className="space-y-3 lg:hidden">
      {products.map((product) => (
        <div key={product.id} className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={selectedIds.has(product.id)}
              onChange={() => onToggleSelected(product.id)}
              aria-label={`Select ${product.name}`}
            />
            <div className="font-semibold">
              {(() => {
                const query = search.trim();
                const name = product.name || "";
                const isPrefix = query.length > 0 && name.toLowerCase().startsWith(query.toLowerCase());
                const prefix = isPrefix ? name.slice(0, query.length) : "";
                const rest = isPrefix ? name.slice(query.length) : name;
                const stockBadge = getProductStockBadge(Number(product.stock || 0));
                const approvalThreshold =
                  typeof product.approvalThresholdQty === "number" && product.approvalThresholdQty > 0
                    ? product.approvalThresholdQty
                    : null;

                return (
                  <span className={product.archived ? "opacity-60 line-through" : undefined}>
                    {isPrefix ? (
                      <>
                        <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                        <span>{rest}</span>
                      </>
                    ) : (
                      <span>{name}</span>
                    )}
                    {stockBadge ? (
                      <span className={`ml-2 text-xs border rounded px-1.5 py-0.5 ${stockBadge.className}`}>
                        {stockBadge.label}
                      </span>
                    ) : null}
                    {approvalThreshold ? (
                      <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">Approval &gt;= {approvalThreshold}</span>
                    ) : null}
                    {product.requiresLotTracking || product.requiresExpiryDate ? (
                      <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">Regulated</span>
                    ) : null}
                    {product.archived ? (
                      <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span>
                    ) : null}
                  </span>
                );
              })()}
              {product.sku ? <div className="text-xs text-muted-foreground font-normal">SKU: {product.sku}</div> : null}
            </div>
            <div className="text-xs text-muted-foreground" title={new Date(product.updatedAt).toLocaleString()}>
              {new Date(product.updatedAt).toLocaleDateString()}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="uppercase tracking-wide text-muted-foreground">Price</p>
              <p className="font-semibold">{formatCurrency(Number(product.price))}</p>
            </div>
            <div>
              <p className="uppercase tracking-wide text-muted-foreground">Category</p>
              <p className="font-semibold">
                {PRODUCT_CATEGORY_LABELS[(product.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized"}
              </p>
            </div>
            <div>
              <p className="uppercase tracking-wide text-muted-foreground">Supplier</p>
              <p className="font-semibold">{product.supplier || "Unknown"}</p>
            </div>
            {canShowCost ? (
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Cost</p>
                <p className="font-semibold">{formatCurrency(Number(product.cost || 0))}</p>
              </div>
            ) : null}
            {canShowCost ? (
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Margin</p>
                {(() => {
                  const price = Number(product.price || 0);
                  const cost = Number(product.cost || 0);
                  const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
                  const minMargin = typeof product.minMarginPct === "number" ? product.minMarginPct : null;
                  const belowMin = minMargin != null && Number.isFinite(minMargin) && marginPct < minMargin;
                  const belowCost = price > 0 && price < cost;
                  const color =
                    belowCost || belowMin ? "text-red-600 font-semibold" : "text-emerald-600 font-semibold";

                  return (
                    <p className={color} title={minMargin != null ? `Min ${minMargin}%` : undefined}>
                      {Number.isFinite(marginPct) ? `${marginPct.toFixed(1)}%` : "0.0%"}
                    </p>
                  );
                })()}
              </div>
            ) : null}
            <div>
              <p className="uppercase tracking-wide text-muted-foreground">Stock</p>
              <p className="font-semibold">{product.stock}</p>
            </div>
          </div>

          <div className="grid gap-2 pt-1 sm:grid-cols-2">
            <Button size="sm" variant="secondary" className="w-full" onClick={() => onEdit(product.id)}>
              Edit
            </Button>
            <Button size="sm" variant="outline" className="w-full" asChild>
              <Link href={`/admin/stock-adjustments?productId=${encodeURIComponent(product.id)}&q=${encodeURIComponent(product.sku || product.name)}`}>
                Adjust inventory
              </Link>
            </Button>
            {!product.archived ? (
              <a
                href={`/products/${product.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 h-8 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent w-full"
              >
                Storefront <ExternalLink className="h-3 w-3 opacity-60" />
              </a>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!product.archived && Number(product.stock || 0) > 0}
              onClick={() => {
                void onArchiveToggle(product, !product.archived);
              }}
            >
              {product.archived ? "Unarchive" : Number(product.stock || 0) > 0 ? "Archive (stock must be 0)" : "Archive"}
            </Button>
            {(product.orderCount ?? 0) === 0 ? (
              <Button size="sm" variant="destructive" className="w-full sm:col-span-2" onClick={() => onDelete(product.id)}>
                Delete
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground sm:col-span-2">Delete hidden because this product has order history.</p>
            )}
          </div>
        </div>
      ))}

      {products.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          <p>No products found.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
            {addProductAction}
          </div>
        </div>
      ) : null}
    </div>
  );
}
