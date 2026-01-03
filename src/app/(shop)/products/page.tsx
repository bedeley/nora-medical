import { prisma } from "@/lib/prisma";
import ProductCard from "./ProductCard";
import ProductFilters from "./ProductFilters";
import PageSizeSelect from "./PageSizeSelect";
import BackToTop from "./BackToTop";
import Pagination from "./Pagination";
import { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";

export const dynamic = "force-dynamic";

/**
 * 🧠 Dynamic SEO Metadata
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}): Promise<Metadata> {
  const params = await searchParams;
  const q = (params.q as string) || "";
  const rawCategory = String(params.category || "").toLowerCase();
  const category = PRODUCT_CATEGORIES.includes(rawCategory as (typeof PRODUCT_CATEGORIES)[number])
    ? rawCategory
    : "";
  const categoryLabel = category
    ? PRODUCT_CATEGORY_LABELS[category as (typeof PRODUCT_CATEGORIES)[number]]
    : "";
  return {
    title: q
      ? `Search results for "${q}"${categoryLabel ? ` in ${categoryLabel}` : ""} – Noralls Medical Supplies`
      : categoryLabel
      ? `${categoryLabel} Products – Noralls Medical Supplies`
      : "All Products – Noralls Medical Supplies",
    description: q
      ? `Browse search results for "${q}" at Noralls Medical Supplies. Find the medical equipment and products you need.`
      : categoryLabel
      ? `Shop ${categoryLabel.toLowerCase()} supplies at Noralls Medical Supplies.`
      : "Shop medical and hospital supplies. Browse our full product catalog, including surgical, diagnostic, and healthcare essentials.",
  };
}

/**
 * 🛒 Main Product Listing Page
 */
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[]>>;
}) {
  const params = await searchParams;
  const q = (params.q as string) || "";
  const rawCategory = String(params.category || "").toLowerCase();
  const category = PRODUCT_CATEGORIES.includes(rawCategory as (typeof PRODUCT_CATEGORIES)[number])
    ? rawCategory
    : "";
  const rawSort = String(params.sort || "").toLowerCase();
  const sort = ["newest", "price-asc", "price-desc", "name-asc", "name-desc"].includes(rawSort)
    ? rawSort
    : "newest";
  const rawPageSize = Number(params.pageSize || 24);
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(Math.max(Math.floor(rawPageSize), 4), 48)
    : 24;
  const rawStock = String(params.stock || "").toLowerCase();
  const stockFilter = rawStock === "in" || rawStock === "low" || rawStock === "out" ? rawStock : "";
  const minPriceRaw = params.minPrice;
  const maxPriceRaw = params.maxPrice;
  const minPrice =
    typeof minPriceRaw === "string" && minPriceRaw.trim() !== ""
      ? Number(minPriceRaw)
      : NaN;
  const maxPrice =
    typeof maxPriceRaw === "string" && maxPriceRaw.trim() !== ""
      ? Number(maxPriceRaw)
      : NaN;
  const minPriceValue = Number.isFinite(minPrice) ? minPrice : null;
  const maxPriceValue = Number.isFinite(maxPrice) ? maxPrice : null;
  const page = Number(params.page || 1);

  // ✅ Dynamic Prisma filter
  const where: NonNullable<Parameters<typeof prisma.product.findMany>[0]>["where"] = {
    archived: false,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(category ? { category } : {}),
    ...(stockFilter === "in"
      ? { stock: { gt: 0 } }
      : stockFilter === "out"
      ? { stock: { lte: 0 } }
      : stockFilter === "low"
      ? { stock: { gt: 0, lte: 3 } }
      : {}),
    ...(minPriceValue != null || maxPriceValue != null
      ? {
          price: {
            ...(minPriceValue != null ? { gte: minPriceValue } : {}),
            ...(maxPriceValue != null ? { lte: maxPriceValue } : {}),
          },
        }
      : {}),
  };

  // ✅ Query products and count in parallel
  const orderBy =
    sort === "price-asc"
      ? { price: "asc" as const }
      : sort === "price-desc"
      ? { price: "desc" as const }
      : sort === "name-asc"
      ? { name: "asc" as const }
      : sort === "name-desc"
      ? { name: "desc" as const }
      : { updatedAt: "desc" as const };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      // Sort by last change so inventory updates (sales/purchases) bubble items to the top
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.product.count({ where }),
  ]);

  // ✅ Transform Prisma output for serialization
  const plainItems = items.map((p: (typeof items)[number]) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl || "/placeholder.png",
    category: p.category ?? null,
    brand: p.brand ?? null,
    supplier: p.supplier ?? null,
    price: Number(p.price),
    stock: p.stock,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  const now = Date.now();
  const thirtyDaysMs = 1000 * 60 * 60 * 24 * 30;
  const highlightNew = plainItems.filter((p) => {
    try {
      return now - Date.parse(p.createdAt) < thirtyDaysMs;
    } catch {
      return false;
    }
  }).slice(0, 4);
  const highlightLowStock = plainItems.filter(
    (p) => typeof p.stock === "number" && p.stock > 0 && p.stock <= 3,
  ).slice(0, 4);

  // Avoid showing highlight products twice by excluding them from the main grid
  const highlightedIds = new Set([
    ...highlightNew.map((p) => p.id),
    ...highlightLowStock.map((p) => p.id),
  ]);
  const mainGridItems =
    highlightedIds.size > 0
      ? plainItems.filter((p) => !highlightedIds.has(p.id))
      : plainItems;

  const gridClass = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4";

  return (
    <section className="container mx-auto py-8">
      <div className="max-w-5xl mx-auto mb-6 text-center">
        <h1 className="text-2xl sm:text-3xl font-semibold">All Products</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Browse our full catalog of clinical essentials and hospital-grade supplies.
        </p>
      </div>
      <div className="static sm:sticky sm:top-0 z-20 bg-background/95 backdrop-blur border-y py-2 sm:py-4">
        <div className="max-w-5xl mx-auto py-2 sm:py-4">
          <ProductFilters />
        </div>
      </div>

      {plainItems.length > 0 ? (
        <>
          {(highlightNew.length > 0 || highlightLowStock.length > 0) && (
            <div className="mt-8 max-w-5xl mx-auto space-y-4">
              {highlightNew.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold mb-2">
                    New arrivals
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {highlightNew.map((p) => (
                      <ProductCard
                        key={`new-${p.id}`}
                        id={p.id}
                        name={p.name}
                        description={p.description}
                        imageUrl={p.imageUrl}
                        category={p.category ?? undefined}
                        brand={p.brand ?? undefined}
                        price={p.price}
                        inStock={typeof p.stock === "number" ? p.stock > 0 : true}
                        lowStock={typeof p.stock === "number" ? p.stock > 0 && p.stock <= 3 : false}
                        isNew
                        variant="compact"
                      />
                    ))}
                  </div>
                </div>
              )}

              {highlightLowStock.length > 0 && (
                <div>
                  <h2 className="text-sm font-semibold mb-2">
                    Low stock (going fast)
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {highlightLowStock.map((p) => (
                      <ProductCard
                        key={`low-${p.id}`}
                        id={p.id}
                        name={p.name}
                        description={p.description}
                        imageUrl={p.imageUrl}
                        category={p.category ?? undefined}
                        brand={p.brand ?? undefined}
                        price={p.price}
                        inStock={typeof p.stock === "number" ? p.stock > 0 : true}
                        lowStock
                        isNew={(() => { try { return now - Date.parse(p.createdAt) < thirtyDaysMs; } catch { return false; } })()}
                        variant="compact"
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {mainGridItems.length > 0 && (
            <div className="mt-10 max-w-5xl mx-auto border-t pt-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold">All products</h2>
                {(q || category || sort !== "newest") ? (
                  <span className="text-xs text-muted-foreground">
                    {total} item{total === 1 ? "" : "s"} found
                  </span>
                ) : null}
              </div>
              <div className={gridClass}>
                {mainGridItems.map((p) => (
                  <ProductCard
                    key={p.id}
                    id={p.id}
                    name={p.name}
                    description={p.description}
                    imageUrl={p.imageUrl}
                    category={p.category ?? undefined}
                    brand={p.brand ?? undefined}
                    price={p.price}
                    inStock={typeof p.stock === "number" ? p.stock > 0 : true}
                    lowStock={typeof p.stock === "number" ? p.stock > 0 && p.stock <= 3 : false}
                    isNew={(() => { try { return now - Date.parse(p.createdAt) < thirtyDaysMs; } catch { return false; } })()}
                    variant="auto"
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-col-reverse items-center justify-between gap-3 text-sm sm:flex-row max-w-5xl mx-auto">
            <Pagination total={total} page={page} pageSize={pageSize} />
            <div className="w-full sm:w-auto sm:ml-auto">
              <PageSizeSelect defaultValue={pageSize} />
            </div>
          </div>
        </>
      ) : (
        <div className="mt-10 flex flex-col items-center gap-3 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          <p>No products found for the current search.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/products">Clear search</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      )}
      <BackToTop />
    </section>
  );
}
