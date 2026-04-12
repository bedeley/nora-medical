"use client";

import type { RefObject } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";
import { SORT_OPTIONS, type ProductsSavedFilter, type SupplierOption } from "../types";

export function ProductsFiltersCard({
  searchInput,
  searchInputRef,
  onSearchInputChange,
  onClearSearch,
  pageSize,
  onPageSizeChange,
  categoryFilter,
  onCategoryFilterChange,
  supplierFilter,
  onSupplierFilterChange,
  assignableSuppliers,
  stockFilter,
  onStockFilterChange,
  sortField,
  sortDir,
  onSortSelection,
  includeArchived,
  onIncludeArchivedChange,
  isAdmin,
  showCost,
  onShowCostChange,
  savedFilters,
  onOpenSaveFilter,
  onApplySavedFilter,
  onRemoveSavedFilter,
  onClearFilters,
  hasActiveFilters,
  activeFilterCount,
  productsLength,
  total,
}: {
  searchInput: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchInputChange: (value: string) => void;
  onClearSearch: () => void;
  pageSize: number;
  onPageSizeChange: (value: number) => void;
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  supplierFilter: string;
  onSupplierFilterChange: (value: string) => void;
  assignableSuppliers: SupplierOption[];
  stockFilter: "all" | "low" | "out";
  onStockFilterChange: (value: "all" | "low" | "out") => void;
  sortField: "updatedAt" | "price" | "stock" | "name";
  sortDir: "asc" | "desc";
  onSortSelection: (value: string) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (checked: boolean) => void;
  isAdmin: boolean;
  showCost: boolean;
  onShowCostChange: (checked: boolean) => void;
  savedFilters: ProductsSavedFilter[];
  onOpenSaveFilter: () => void;
  onApplySavedFilter: (entry: ProductsSavedFilter) => void;
  onRemoveSavedFilter: (id: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
  productsLength: number;
  total: number;
}) {
  return (
    <Card className="shadow-sm">
      <CardContent className="pt-4 pb-3 px-4 space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name or SKU… (press / to focus)"
              className="pl-8 h-9"
              value={searchInput}
              ref={searchInputRef}
              data-testid="products-search-input"
              onChange={(event) => onSearchInputChange(event.target.value)}
            />
            {searchInput ? (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={onClearSearch}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm w-[90px] flex-shrink-0"
            value={pageSize}
            onChange={(event) => onPageSizeChange(parseInt(event.target.value, 10))}
            title="Rows per page"
          >
            <option value={10}>10 rows</option>
            <option value={25}>25 rows</option>
            <option value={50}>50 rows</option>
            <option value={100}>100 rows</option>
          </select>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <select
            className={`h-8 rounded-md border px-2 text-sm bg-background transition-colors ${categoryFilter ? "border-primary text-foreground font-medium" : "border-input text-muted-foreground"}`}
            value={categoryFilter}
            onChange={(event) => onCategoryFilterChange(event.target.value)}
          >
            <option value="">All categories</option>
            {PRODUCT_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className={`h-8 rounded-md border px-2 text-sm bg-background transition-colors ${supplierFilter ? "border-primary text-foreground font-medium" : "border-input text-muted-foreground"}`}
            value={supplierFilter}
            onChange={(event) => onSupplierFilterChange(event.target.value)}
          >
            <option value="">All suppliers</option>
            {assignableSuppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 rounded-md border border-input overflow-hidden h-8">
            {(["all", "low", "out"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`px-2.5 text-xs h-full transition-colors ${stockFilter === value ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"}`}
                onClick={() => onStockFilterChange(value)}
              >
                {value === "all" ? "All stock" : value === "low" ? "Low" : "Out"}
              </button>
            ))}
          </div>
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={`${sortField}-${sortDir}`}
            onChange={(event) => onSortSelection(event.target.value)}
            aria-label="Sort products"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer hover:text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={includeArchived}
              onChange={(event) => onIncludeArchivedChange(event.target.checked)}
            />
            Include archived
          </label>
          {isAdmin ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer hover:text-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={showCost}
                onChange={(event) => onShowCostChange(event.target.checked)}
              />
              Show cost & margin
            </label>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground">
                  Saved filters
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuItem onClick={onOpenSaveFilter} className="text-xs">
                  Save current view…
                </DropdownMenuItem>
                {savedFilters.length > 0 ? (
                  <>
                    <div className="my-1 border-t" />
                    {savedFilters.map((entry) => (
                      <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-3 text-xs pr-1">
                        <button type="button" className="flex-1 text-left" onClick={() => onApplySavedFilter(entry)}>
                          {entry.name}
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive p-0.5"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemoveSavedFilter(entry.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            {hasActiveFilters ? (
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground" onClick={onClearFilters}>
                <X className="h-3 w-3 mr-1" />
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span>Showing {productsLength} of {total}</span>
          <span>•</span>
          <span>{SORT_OPTIONS.find((option) => option.value === `${sortField}-${sortDir}`)?.label || "Recently updated"}</span>
          <span>•</span>
          <span>{activeFilterCount === 0 ? "Default view" : `${activeFilterCount} active filter${activeFilterCount === 1 ? "" : "s"}`}</span>
        </div>
      </CardContent>
    </Card>
  );
}
