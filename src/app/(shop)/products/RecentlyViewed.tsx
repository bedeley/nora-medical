"use client";

import { useEffect, useState } from "react";
import { getRecentlyViewed } from "@/lib/recently-viewed";
import ProductCard from "./ProductCard";

interface ProductSummary {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  category: string | null;
  brand: string | null;
  price: number;
  stock: number;
}

export default function RecentlyViewed({ currentId }: { currentId?: string }) {
  const [products, setProducts] = useState<ProductSummary[]>([]);

  useEffect(() => {
    const ids = getRecentlyViewed().filter((id) => id !== currentId).slice(0, 8);
    if (ids.length === 0) return;

    fetch(`/api/products?ids=${ids.join(",")}`)
      .then((r) => r.json())
      .then((data: { items?: ProductSummary[] }) => {
        const items = data?.items ?? [];
        // Preserve the localStorage order
        const byId = new Map(items.map((p) => [p.id, p]));
        const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as ProductSummary[];
        setProducts(ordered);
      })
      .catch(() => {
        // Silently ignore — recently viewed is non-critical
      });
  }, [currentId]);

  if (products.length === 0) return null;

  return (
    <section className="max-w-5xl mx-auto mt-10 border-t pt-6">
      <h2 className="text-sm font-semibold mb-3">Recently viewed</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
        {products.map((p) => (
          <div key={p.id} className="shrink-0 w-44">
            <ProductCard
              id={p.id}
              name={p.name}
              description={p.description}
              imageUrl={p.imageUrl}
              category={p.category ?? undefined}
              brand={p.brand ?? undefined}
              price={p.price}
              stock={p.stock}
              inStock={p.stock > 0}
              lowStock={p.stock > 0 && p.stock <= 3}
              variant="mini"
            />
          </div>
        ))}
      </div>
    </section>
  );
}
