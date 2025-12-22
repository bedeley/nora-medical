"use client";

import Image from "next/image";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/currency";

interface Product {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  price: number;
  stock: number;
  createdAt: string;
  updatedAt: string;
}

export default function ProductPage() {
  const smsEnabled =
    (process.env.NEXT_PUBLIC_SMS_NOTIFICATIONS_ENABLED || "").toLowerCase() === "1";
  const { data: session } = useSession();
  const router = useRouter();
  const params = useParams();
  const id = String((params as { id?: string }).id || "");
  const [loading, setLoading] = useState(false);
  // Keep image state hook stable across renders
  const [imgSrc, setImgSrc] = useState<string>("/placeholder.png");
  const queryClient = useQueryClient();
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifyPhone, setNotifyPhone] = useState("");
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyDone, setNotifyDone] = useState(false);

  // ✅ Fetch product from API (treat non-2xx as errors)
  const { data, error, isLoading } = useQuery<Product>({
    queryKey: ["product", id],
    queryFn: async () => {
      const r = await fetch(`/api/products/${id}`);
      if (!r.ok) {
        const txt = await r.text().catch(() => "Failed to load product");
        throw new Error(txt || "Failed to load product");
      }
      return (await r.json()) as Product;
    },
    enabled: !!id,
    staleTime: 60000,
  });

  // Update image when data arrives/changes
  useEffect(() => {
    setImgSrc(data?.imageUrl || "/placeholder.png");
  }, [data]);

  useEffect(() => {
    const sessionEmail = String(session?.user?.email || "");
    const sessionPhone = String((session?.user as { phone?: string })?.phone || "");
    if (!notifyEmail && sessionEmail) setNotifyEmail(sessionEmail);
    if (!notifyPhone && sessionPhone) setNotifyPhone(sessionPhone);
  }, [session, notifyEmail, notifyPhone]);

  // ✅ Early return for loading/error states
  if (isLoading)
    return (
      <section className="container mx-auto py-20 text-center text-muted-foreground">
        Loading product...
      </section>
    );

  if (error || !data)
    return (
      <section className="container mx-auto py-20 text-center text-red-500">
        Failed to load product.
      </section>
    );

  const product = data; // ✅ Now fully defined (TypeScript knows this)

  const numericPrice = Number(product.price) || 0;
  const formattedPrice = formatCurrency(numericPrice);
  const stock = Number(product.stock ?? 0);
  const lowStock = stock > 0 && stock <= 5;

  async function addToCart() {
    if (!session) {
      toast.info("Please sign in to add items to your cart.");
      router.push("/account");
      return;
    }

    try {
      setLoading(true);
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, quantity: 1 }),
      });

      if (!res.ok) {
        const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(j?.error || "Could not add item to cart.");
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["cart"] });
      toast.success(`${product.name} added to cart.`, {
        action: {
          label: "Undo",
          onClick: async () => {
            await fetch(`/api/cart/item/${product.id}`, { method: "DELETE" });
            queryClient.invalidateQueries({ queryKey: ["cart"] });
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

  async function subscribeBackInStock() {
    if (notifyLoading) return;
    if (!notifyEmail && !notifyPhone) {
      toast.error("Enter an email or phone number.");
      return;
    }
    try {
      setNotifyLoading(true);
      const res = await fetch(`/api/products/${product.id}/stock-alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: notifyEmail || undefined,
          phone: notifyPhone || undefined,
        }),
      });
      const j = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(j?.error || "Could not subscribe to stock alerts.");
        return;
      }
      setNotifyDone(true);
      toast.success("You will be notified when this item is back in stock.");
    } catch (err) {
      console.error(err);
      toast.error("Could not subscribe to stock alerts.");
    } finally {
      setNotifyLoading(false);
    }
  }

  return (
    <section className="container mx-auto py-10">
      <div className="grid md:grid-cols-2 gap-10 items-start">
        {/* ✅ Product Image */}
        <div className="relative aspect-square w-full bg-muted overflow-hidden">
          <Image
            src={imgSrc}
            alt={product.name || "Product image"}
            fill
            sizes="(max-width: 768px) 80vw, 40vw"
            className="object-cover"
            onError={() => setImgSrc("/placeholder.png")}
          />
        </div>

        {/* ✅ Product Info */}
        <div className="flex flex-col gap-4">
          <h1 className="text-3xl font-semibold">{product.name}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {product.description}
          </p>

          <div className="flex items-center gap-3 mt-2">
            <p className="text-2xl font-bold">{formattedPrice}</p>
            {stock <= 0 ? (
              <span className="text-red-500 text-sm font-medium">
                Out of stock
              </span>
            ) : lowStock ? (
              <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 text-xs font-medium">
                Low stock &mdash; only {stock} left
              </span>
            ) : (
              <span className="text-green-600 text-sm font-medium">
                In stock
              </span>
            )}
          </div>

          <Button
            onClick={addToCart}
            disabled={stock === 0 || loading}
            className="w-full sm:w-auto mt-6"
          >
            {loading ? "Adding..." : "Add to Cart"}
          </Button>

          {stock <= 0 && (
            <div className="mt-6 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="font-medium text-slate-900">
                Get notified when this item is back in stock
              </p>
              <p className="mt-1 text-slate-600">
                Leave your email (and optionally your phone) and we’ll alert you when it’s available.
              </p>
              <div className={`mt-3 grid gap-2 ${smsEnabled ? "sm:grid-cols-2" : ""}`}>
                <Input
                  type="email"
                  placeholder="Email address"
                  value={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.value)}
                />
                {smsEnabled && (
                  <Input
                    type="tel"
                    placeholder="Phone (optional)"
                    value={notifyPhone}
                    onChange={(e) => setNotifyPhone(e.target.value)}
                  />
                )}
              </div>
              <Button
                className="mt-3 w-full sm:w-auto"
                variant="outline"
                onClick={subscribeBackInStock}
                disabled={notifyLoading || notifyDone}
              >
                {notifyDone ? "You're on the list" : notifyLoading ? "Subscribing..." : "Notify me"}
              </Button>
              {!smsEnabled && (
                <p className="mt-2 text-xs text-slate-500">
                  SMS alerts will be available once SMS is configured.
                </p>
              )}
            </div>
          )}

          <div className="border-t mt-6 pt-4 text-sm text-muted-foreground">
            <p>
              For inquiries or bulk orders, call{" "}
              <a href={ADMIN_PHONE_TEL} className="text-primary font-medium hover:underline">
                {ADMIN_PHONE}
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
