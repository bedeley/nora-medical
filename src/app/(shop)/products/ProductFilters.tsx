"use client";

import { Input } from "@/components/ui/input";
import { useRouter, useSearchParams } from "next/navigation";
import { useDebouncedCallback } from "use-debounce";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PRODUCT_CATEGORY_LABELS, PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";

export default function ProductFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ✅ Local state ensures controlled input and correct hydration
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [category, setCategory] = useState(searchParams.get("category") || "");
  const [sort, setSort] = useState(searchParams.get("sort") || "newest");
  const [minPrice, setMinPrice] = useState(searchParams.get("minPrice") || "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("maxPrice") || "");
  const [stock, setStock] = useState(searchParams.get("stock") || "");

  // ✅ Keep state in sync when navigating back/forward
  useEffect(() => {
    setQuery(searchParams.get("q") || "");
    setCategory(searchParams.get("category") || "");
    setSort(searchParams.get("sort") || "newest");
    setMinPrice(searchParams.get("minPrice") || "");
    setMaxPrice(searchParams.get("maxPrice") || "");
    setStock(searchParams.get("stock") || "");
  }, [searchParams]);

  const handleSearch = useDebouncedCallback((term: string) => {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    if (term.trim()) params.set("q", term.trim());
    else params.delete("q");
    params.delete("view");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  }, 400);

  const handleCategoryChange = (value: string) => {
    setCategory(value);
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    if (value) {
      params.set("category", value);
    } else {
      params.delete("category");
    }
    params.delete("view");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleSortChange = (value: string) => {
    setSort(value);
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    if (value && value !== "newest") {
      params.set("sort", value);
    } else {
      params.delete("sort");
    }
    params.delete("view");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handleStockChange = (value: string) => {
    setStock(value);
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    if (value) params.set("stock", value);
    else params.delete("stock");
    params.delete("view");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };


  const applyPrice = (nextMin = minPrice, nextMax = maxPrice) => {
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    if (nextMin) params.set("minPrice", nextMin);
    else params.delete("minPrice");
    if (nextMax) params.set("maxPrice", nextMax);
    else params.delete("maxPrice");
    params.delete("view");
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  const handlePrice = useDebouncedCallback((nextMin: string, nextMax: string) => {
    applyPrice(nextMin, nextMax);
  }, 400);

  const clearAll = () => {
    setQuery("");
    setCategory("");
    setSort("newest");
    setMinPrice("");
    setMaxPrice("");
    setStock("");
    const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
    params.delete("q");
    params.delete("category");
    params.delete("sort");
    params.delete("minPrice");
    params.delete("maxPrice");
    params.delete("stock");
    params.delete("pageSize");
    params.delete("page");
    router.push(`?${params.toString()}`);
  };

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
        const el = inputRef.current;
        if (el) {
          el.value = '';
          setQuery('');
          handleSearch('');
          try { el.setSelectionRange(0, 0); } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (!k || k.length !== 1) return;
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + k + el.value.slice(end);
      el.value = next;
      setQuery(next);
      handleSearch(next);
      try {
        el.setSelectionRange(start + 1, start + 1);
      } catch {}
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, {
        capture: true,
      } as EventListenerOptions);
  }, [handleSearch]);



  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            autoFocus
            value={query}
            placeholder="Search products..."
            className="pl-9"
            onChange={(e) => {
              setQuery(e.target.value);
              handleSearch(e.target.value);
            }}
          />
        </div>
        <select
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
          aria-label="Filter by category"
          className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm text-foreground sm:w-52"
        >
          <option value="">All categories</option>
          {PRODUCT_CATEGORY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={stock}
          onChange={(e) => handleStockChange(e.target.value)}
          aria-label="Filter by stock status"
          className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm text-foreground sm:w-44"
        >
          <option value="">All stock</option>
          <option value="in">In stock</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
        <select
          value={sort}
          onChange={(e) => handleSortChange(e.target.value)}
          aria-label="Sort products"
          className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm text-foreground sm:w-48"
        >
          <option value="newest">Newest</option>
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
          <option value="name-asc">Name: A-Z</option>
          <option value="name-desc">Name: Z-A</option>
        </select>
        <div className="flex w-full max-w-md items-center gap-2 sm:w-auto">
          <Input
            value={minPrice}
            onChange={(e) => {
              const next = e.target.value;
              setMinPrice(next);
              handlePrice(next, maxPrice);
            }}
            placeholder="Min"
            inputMode="decimal"
            className="h-10 w-full sm:w-20"
          />
          <Input
            value={maxPrice}
            onChange={(e) => {
              const next = e.target.value;
              setMaxPrice(next);
              handlePrice(minPrice, next);
            }}
            placeholder="Max"
            inputMode="decimal"
            className="h-10 w-full sm:w-20"
          />
          <button
            type="button"
            className="h-10 rounded-md border px-2 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => {
              setMinPrice("");
              setMaxPrice("");
              applyPrice("", "");
            }}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {PRODUCT_CATEGORY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`rounded-full border px-2 py-1 ${category === option.value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => handleCategoryChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {(query || category || stock || minPrice || maxPrice || (sort && sort !== "newest")) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {query && (
            <button
              type="button"
              className="rounded-full border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => handleSearch("")}
            >
              Search: {query} ×
            </button>
          )}
          {category && (
            <button
              type="button"
              className="rounded-full border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => handleCategoryChange("")}
            >
              Category: {PRODUCT_CATEGORY_LABELS[category as keyof typeof PRODUCT_CATEGORY_LABELS]} ×
            </button>
          )}
          {stock && (
            <button
              type="button"
              className="rounded-full border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => handleStockChange("")}
            >
              Stock: {stock} ×
            </button>
          )}
          {(minPrice || maxPrice) && (
            <button
              type="button"
              className="rounded-full border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setMinPrice("");
                setMaxPrice("");
                applyPrice("", "");
              }}
            >
              Price: {minPrice || "0"}-{maxPrice || "∞"} ×
            </button>
          )}
          {sort && sort !== "newest" && (
            <button
              type="button"
              className="rounded-full border px-2 py-1 text-muted-foreground hover:text-foreground"
              onClick={() => handleSortChange("newest")}
            >
              Sort: {sort.replace("-", " ")} ×
            </button>
          )}
          <button
            type="button"
            className="rounded-full border px-2 py-1 font-semibold text-primary hover:text-primary"
            onClick={clearAll}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
