"use client";

import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatCurrency } from "@/lib/currency";
import {
  addToGuestCart,
  getGuestCart,
  removeGuestCartItem,
  updateGuestCartItem,
} from "@/lib/guest-cart";

interface ProductCardProps {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  price: number | string; // allow both numeric and string prices
  // Optional enhancements (safe defaults)
  brand?: string;
  unit?: string; // e.g., "Box of 100"
  compareAtPrice?: number | string; // old price for discounts
  isNew?: boolean;
  lowStock?: boolean;
  inStock?: boolean;
  variant?: "standard" | "compact" | "auto";
}

export default function ProductCard({
  id,
  name,
  description,
  imageUrl,
  price,
  brand,
  unit,
  compareAtPrice,
  isNew,
  lowStock,
  inStock = true,
  variant = "auto",
}: ProductCardProps) {
  const { data: session } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const normalizedImageUrl = (imageUrl || "").trim();
  const [imgSrc, setImgSrc] = useState<string>(normalizedImageUrl || "/placeholder.png");
  const resolvedVariant = variant === "auto" ? "compact" : variant;
  const isCompact = resolvedVariant === "compact";

  // Normalize and format price safely
  const numericPrice = Number(price) || 0;
  const formattedPrice = formatCurrency(numericPrice);
  const numericCompare = Number(compareAtPrice || 0) || 0;
  const onSale = numericCompare > numericPrice;
  const discountPct = onSale
    ? Math.max(0, Math.round(((numericCompare - numericPrice) / numericCompare) * 100))
    : 0;

  // Preload cart data for faster updates
  useQuery({
    queryKey: ["cart"],
    queryFn: () => fetch("/api/cart").then((r) => r.json()),
    staleTime: 15000,
    refetchOnWindowFocus: false,
  });

  async function addToCart() {
    try {
      setLoading(true);
      if (!session) {
        addToGuestCart(id, 1);
        queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
      } else {
        const res = await fetch("/api/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: id, quantity: 1 }),
        });

        if (!res.ok) {
          toast.error("Could not add item to cart.");
          return;
        }

        queryClient.invalidateQueries({ queryKey: ["cart"] });
      }
      toast.success(`${name} added to cart.`, {
        action: {
          label: "Undo",
          onClick: async () => {
            if (!session) {
              const current = getGuestCart().find(
                (it) => it.productId === id,
              );
              const nextQty = (current?.quantity ?? 1) - 1;
              if (nextQty > 0) {
                updateGuestCartItem(id, nextQty);
              } else {
                removeGuestCartItem(id);
              }
              queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
            } else {
              await fetch(`/api/cart/item/${id}`, { method: "DELETE" });
              queryClient.invalidateQueries({ queryKey: ["cart"] });
            }
            toast("Item removed from cart");
          },
        },
      });
    } catch (err) {
      console.error(err);
      toast.error("An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="cursor-pointer h-full">
      <Card
        className={`bg-card text-card-foreground rounded-none border-none shadow-sm transition-shadow duration-300 hover:shadow-lg flex h-full flex-col ${isCompact ? "text-sm" : ""}`}
        onClick={() => router.push(`/products/${id}`)}
      >
        <CardHeader className="p-0">
          <div className="relative overflow-hidden h-44 bg-white">
            <Image
              src={imgSrc}
              alt={name}
              fill
              sizes="(max-width: 768px) 50vw, 25vw"
              className="object-contain object-center"
              onError={() => setImgSrc("/placeholder.png")}
            />

            {(isNew || lowStock || onSale) && (
              <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                {isNew && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground">New</span>
                )}
                {lowStock && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">Low Stock</span>
                )}
                {onSale && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 border border-rose-200">{discountPct}% off</span>
                )}
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className={`flex-1 ${isCompact ? "p-3" : "p-4"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {brand && (
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5 line-clamp-1">
                  {brand}
                </p>
              )}
              <h3 className={isCompact ? "text-sm font-semibold line-clamp-1" : "text-base font-semibold line-clamp-1"}>
                {name}
              </h3>
              {unit && (
                <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{unit}</p>
              )}
            </div>
            <div className="text-right whitespace-nowrap">
              {onSale && (
                <p className="text-xs text-muted-foreground line-through">{formatCurrency(numericCompare)}</p>
              )}
              <p className={onSale ? "text-base font-semibold text-rose-600" : "text-base font-semibold"}>
                {formattedPrice}
              </p>
            </div>
          </div>
          {description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-2">
              {description}
            </p>
          )}
          {!inStock && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 inline-block mt-2">
              Out of stock
            </p>
          )}
        </CardContent>

        <CardFooter className={isCompact ? "p-3 pt-0" : "p-4 pt-0"}>
          <div className="w-full">
            <Button
              size={isCompact ? "sm" : "default"}
              className="w-full"
              onClick={(e) => {
                e.stopPropagation();
                void addToCart();
              }}
              disabled={loading || !inStock}
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                  </svg>
                  Adding...
                </span>
              ) : (
                "Add to Cart"
              )}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
