import { prisma } from "@/lib/prisma";
import ProductCard from "./ProductCard";
import ProductFilters from "./ProductFilters";
import Pagination from "./Pagination";
import { Metadata } from "next";

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
  return {
    title: q
      ? `Search results for "${q}" – Nora Hospital Supplies`
      : "All Products – Nora Hospital Supplies",
    description: q
      ? `Browse search results for "${q}" at Nora Hospital Supplies. Find the medical equipment and products you need.`
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
  const page = Number(params.page || 1);
  const pageSize = 12;

  // ✅ Dynamic Prisma filter
  const where: NonNullable<Parameters<typeof prisma.product.findMany>[0]>["where"] = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { description: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  // ✅ Query products and count in parallel
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      // Sort by last change so inventory updates (sales/purchases) bubble items to the top
      orderBy: { updatedAt: "desc" },
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
    price: Number(p.price),
    stock: p.stock,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));

  return (
    <section className="container mx-auto py-8">
      <div className="max-w-5xl mx-auto">
        <ProductFilters />
      </div>

      {plainItems.length > 0 ? (
        <>
          <div className="mt-8 max-w-5xl mx-auto">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {plainItems.map((p: (typeof plainItems)[number]) => (
              <ProductCard
                key={p.id}
                id={p.id}
                name={p.name}
                description={p.description}
                imageUrl={p.imageUrl}
                price={p.price}
                inStock={typeof p.stock === 'number' ? p.stock > 0 : true}
                lowStock={typeof p.stock === 'number' ? p.stock > 0 && p.stock <= 3 : false}
                isNew={(() => { try { return (Date.now() - Date.parse(p.createdAt)) < 1000*60*60*24*30 } catch { return false } })()}
                variant="auto"
              />
            ))}
          </div>
          </div>

          <Pagination total={total} page={page} pageSize={pageSize} />
        </>
      ) : (
        <p className="text-center text-muted-foreground mt-10">
          No products found.
        </p>
      )}
    </section>
  );
}
