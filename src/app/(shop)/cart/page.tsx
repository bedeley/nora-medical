"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";
import Link from "next/link";
// framer-motion removed to avoid layout jitter on /cart
import { ADMIN_PHONE } from "@/lib/config";
import { useSession } from "next-auth/react";
import {
  clearGuestCart,
  getGuestCart,
  updateGuestCartItem,
  removeGuestCartItem,
  type GuestCartItem,
} from "@/lib/guest-cart";

type CartItem = {
  id: string;
  quantity: number;
  updatedAt?: string | Date | null;
  product: {
    id: string;
    name: string;
    imageUrl: string | null;
    price: number | string;
  };
};

type BalanceSummary = {
  totalDue: number;
  totalPaid: number;
  balance: number;
  paymentsTotal?: number;
  unappliedFunds?: number;
  cashRefunds?: number;
  updatedAt: string | Date;
};

export default function CartPage() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ["account", "me"],
    queryFn: () => fetch("/api/account/me").then((r) => r.json()),
    refetchInterval: 15000,
  });
  const { data: balanceData } = useQuery<BalanceSummary>({
    queryKey: ["balance", "self"],
    queryFn: () =>
      fetch("/api/balance?self=1").then((r) => r.json() as Promise<BalanceSummary>),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [tempQty, setTempQty] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [momoPhone, setMomoPhone] = useState("");
  const [momoAmount, setMomoAmount] = useState("");
  const [momoProcessing, setMomoProcessing] = useState(false);
  const [confirmPlaceOrderOpen, setConfirmPlaceOrderOpen] = useState(false);
  const [confirmMomoOpen, setConfirmMomoOpen] = useState(false);
  const qtyTimers = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});

  // Server-backed cart for signed-in users
  const { data, error } = useQuery({
    queryKey: ["cart"],
    queryFn: () => fetch("/api/cart").then((r) => r.json()),
    // Avoid frequent auto-refresh to prevent layout jitter
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const serverItems: CartItem[] = (data?.items || []).map(
    (it: {
      id: string;
      quantity: number | string;
      updatedAt?: string | Date | null;
      product: { id: string; name: string; imageUrl: string | null; price: number | string };
    }) => ({
      id: String(it.id),
      quantity: Number(it.quantity) || 0,
      updatedAt: it.updatedAt ?? null,
      product: {
        id: String(it.product.id),
        name: String(it.product.name),
        imageUrl: it.product.imageUrl ?? null,
        price: it.product.price,
      },
    })
  );

  // Guest cart (localStorage) for users who are not signed in
  const { data: guestRaw = [] } = useQuery<GuestCartItem[]>({
    queryKey: ["guest-cart"],
    queryFn: async () => getGuestCart(),
    refetchOnWindowFocus: false,
  });

  const guestProductIds = useMemo(
    () => guestRaw.map((it) => it.productId),
    [guestRaw],
  );

  const { data: guestProductsData } = useQuery({
    queryKey: ["guest-cart-products", guestProductIds.join(",")],
    enabled: guestProductIds.length > 0,
    queryFn: async () => {
      const ids = guestProductIds.join(",");
      if (!ids) {
        return {
          items: [] as Array<{
            id: string;
            name: string;
            imageUrl: string | null;
            price: number | string;
          }>,
        };
      }
      const res = await fetch(`/api/products?ids=${encodeURIComponent(ids)}`);
      if (!res.ok) {
        throw new Error("Failed to load products for guest cart");
      }
      return (await res.json()) as {
        items: Array<{
          id: string;
          name: string;
          imageUrl: string | null;
          price: number | string;
        }>;
      };
    },
    refetchOnWindowFocus: false,
  });

  const guestItems: CartItem[] = useMemo(() => {
    if (!guestRaw.length) return [];
    const guestProducts = guestProductsData?.items ?? [];
    const map = new Map(
      guestProducts.map((p) => [
        p.id,
        {
          id: String(p.id),
          name: String(p.name),
          imageUrl: p.imageUrl,
          price: p.price,
        },
      ]),
    );
    return guestRaw
      .map((g) => {
        const p = map.get(g.productId);
        if (!p) return null;
        return {
          id: g.productId,
          quantity: g.quantity,
          updatedAt: g.updatedAt,
          product: p,
        } as CartItem;
      })
      .filter((it): it is CartItem => Boolean(it));
  }, [guestRaw, guestProductsData]);

  // Automatically merge guest cart into server cart once user signs in
  const [mergeAttempted, setMergeAttempted] = useState(false);
  useEffect(() => {
    if (!session) return;
    if (!guestRaw.length) return;
    if (mergeAttempted) return;
    setMergeAttempted(true);

    const doMerge = async () => {
      try {
        for (const item of guestRaw) {
          const res = await fetch("/api/cart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              productId: item.productId,
              quantity: item.quantity,
            }),
          });
          if (!res.ok) {
            // If any item fails, log and continue with others
            console.error("Failed to merge guest cart item", item.productId);
          }
        }
        clearGuestCart();
        queryClient.invalidateQueries({ queryKey: ["cart"] });
        queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
      } catch (e) {
        console.error("Failed to merge guest cart", e);
      }
    };

    void doMerge();
  }, [session, guestRaw, mergeAttempted, queryClient]);

  const isSignedIn = Boolean(session);
  const items: CartItem[] = isSignedIn ? serverItems : guestItems;
  const itemsSorted = items;

  const subtotal = items.reduce(
    (s, it) => s + Number(it.product.price) * it.quantity,
    0
  );

  const creditAvailable = Math.max(
    0,
    Number(balanceData?.unappliedFunds ?? 0),
  );

  async function placeOrder() {
    if (!isSignedIn) {
      toast.info("Please sign in or create an account to checkout.", {
        action: {
          label: "Sign in",
          onClick: () => {
            window.location.href = `/login?next=${encodeURIComponent("/cart")}`;
          },
        },
      });
    return;
    }
    try {
      setPlacing(true);
      const res = await fetch("/api/orders", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({} as { error?: string })));
        const msg = data?.error || "Could not place order";
        toast.error(msg);
        return;
      }
      await res.json();
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      toast.success("Order placed successfully.", {
        description: `Please call the admin at ${ADMIN_PHONE} to confirm your order.`,
        action: {
          label: "View Orders",
          onClick: () => {
            window.location.href = "/orders?placed=1";
          },
        },
      });
    } catch (e) {
      console.error(e);
      toast.error("Failed to place order. Please try again.");
    } finally {
      setPlacing(false);
    }
  }

  async function placeOrderAndPayMomo() {
    if (!isSignedIn) {
      toast.info("Please sign in or create an account to checkout.", {
        action: {
          label: "Sign in",
          onClick: () => {
            window.location.href = `/login?next=${encodeURIComponent("/cart")}`;
          },
        },
      });
      return;
    }
    try {
      setMomoProcessing(true);
      // Validate MoMo phone BEFORE creating the order to avoid
      // clearing the cart when the provided number is invalid.
      const normalizePhone = (input: string) => {
        const cleaned = (input || "").trim().replace(/[^\d+]/g, "");
        if (/^0\d{9}$/.test(cleaned)) return "+233" + cleaned.slice(1);
        return cleaned;
      };
      const isValidPhone = (input: string) => {
        const p = normalizePhone(input);
        return /^\+?\d{10,15}$/.test(p);
      };

      const candidatePhone = momoPhone || me?.phone || "";
      if (!isValidPhone(candidatePhone)) {
        toast.error("Invalid phone number");
        return;
      }
      const phone = normalizePhone(candidatePhone);
      // New single-call checkout endpoint that only creates the order
      const amountCandidate = (() => {
        const n = Number((momoAmount || "").replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) return n;
        return subtotal;
      })();
      const payAmount = Math.max(0.01, Math.min(subtotal, amountCandidate));

      type CheckoutResponse = {
        error?: string;
        warning?: string;
        orderId?: string;
        paymentId?: string;
        applied?: boolean;
        simulated?: boolean;
      };
      const ires = await fetch("/api/orders/checkout/momo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, provider: "mtn", amount: payAmount }),
      });
      const ij = (await ires
        .json()
        .catch(() => ({} as CheckoutResponse))) as CheckoutResponse;
      if (!ires.ok) {
        toast.error(ij?.error || "Checkout failed");
        return;
      }
      const orderId = ij?.orderId as string | undefined;
      const paymentId = ij?.paymentId as string | undefined;
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      if (ij?.applied) {
        const oid = ij?.orderId as string | undefined;
        toast.success(`Payment confirmed.${ij?.simulated ? ' (simulated)' : ''}`, {
          action: oid ? { label: 'View Receipt', onClick: () => { window.location.href = `/orders/${oid}/receipt`; } } : undefined,
        });
        if (oid) {
          window.location.href = `/orders/${oid}/receipt`;
          return;
        }
        window.location.href = '/orders?placed=1';
        return;
      }
      const baseMsg = ij?.warning ? "Order created, but MoMo could not be initiated." : "Order created. Approve MoMo prompt on your phone.";
      toast.success(baseMsg, {
        action: {
          label: "View Orders",
          onClick: () => { window.location.href = "/orders?placed=1"; },
        },
      });
      if (paymentId) await pollMomoUntilSettled(paymentId, orderId);
    } catch (e) {
      console.error(e);
      toast.error("Could not complete MoMo payment.");
    } finally {
      setMomoProcessing(false);
    }
  }

  async function pollMomoUntilSettled(paymentId: string, orderId?: string) {
    let attempts = 0;
    const maxAttempts = 24; // ~2 minutes
    type MomoStatus = { status?: string };
    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const r = await fetch(`/api/payments/momo/status/${paymentId}`);
        const j = (await r.json().catch(() => ({} as MomoStatus))) as MomoStatus;
        if (r.ok) {
          const status = String(j?.status || '').toUpperCase();
          if (status === 'SUCCESSFUL') {
            toast.success('Payment confirmed.', {
              action: orderId ? { label: 'View Receipt', onClick: () => { window.location.href = `/orders/${orderId}/receipt`; } } : undefined,
            });
            if (orderId) {
              window.location.href = `/orders/${orderId}/receipt`;
            } else {
              window.location.href = '/orders?placed=1';
            }
            return;
          }
          if (status === 'FAILED') {
            toast.error('MoMo payment failed.');
            return;
          }
        }
      } catch {}
      await new Promise((res) => setTimeout(res, 5000));
    }
  }

  async function removeItem(itemId: string, productId: string, name: string, quantity: number) {
    try {
      setRemovingIds((s) => new Set(s).add(itemId));
      if (!isSignedIn) {
        removeGuestCartItem(productId);
        queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
      } else {
        const res = await fetch(`/api/cart/item/${itemId}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed");
        queryClient.invalidateQueries({ queryKey: ["cart"] });
      }
      toast.warning(`${name} removed.`, {
        action: {
          label: "Undo",
          onClick: async () => {
            if (!isSignedIn) {
              // Restore previous quantity for guest carts
              updateGuestCartItem(productId, quantity);
              queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
            } else {
              await fetch("/api/cart", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productId, quantity: 1 }),
              });
              queryClient.invalidateQueries({ queryKey: ["cart"] });
            }
            toast.success(`${name} restored to cart`);
          },
        },
      });
    } catch (e) {
      console.error(e);
      toast.error("Could not remove item");
    } finally {
      setRemovingIds((s) => {
        const n = new Set(s);
        n.delete(itemId);
        return n;
      });
    }
  }

  async function updateQty(id: string, quantity: number, productId?: string) {
    if (!Number.isFinite(quantity) || quantity < 1) return;
    try {
      setUpdatingIds((s) => new Set(s).add(id));
      if (!isSignedIn) {
        // For guest carts, ids are productIds; update localStorage and sync query cache
        const targetProductId = productId ?? id;
        updateGuestCartItem(targetProductId, quantity);
        queryClient.setQueryData<GuestCartItem[] | undefined>(
          ["guest-cart"],
          () => getGuestCart(),
        );
      } else {
        const targetProductId = productId ?? id;
        const res = await fetch(`/api/cart`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId: targetProductId, quantity }),
        });
        if (!res.ok) {
          const j = await res
            .json()
            .catch(async () => ({ error: await res.text().catch(() => "") }));
          const msg = j?.error || "Failed to update cart";
          toast.error(msg);
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["cart"] });
      }
      toast.info("Cart updated");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update cart";
      toast.error(msg);
    } finally {
      setUpdatingIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      // Keep temp value during editing; clear on blur instead
    }
  }

  function scheduleQtyUpdate(id: string, quantity: number, productId?: string) {
    const existing = qtyTimers.current[id];
    if (existing) {
      try { clearTimeout(existing); } catch {}
    }
    qtyTimers.current[id] = setTimeout(() => {
      updateQty(id, quantity, productId);
    }, 300);
  }

  async function clearCart() {
    try {
      setClearing(true);
      if (!isSignedIn) {
        clearGuestCart();
        queryClient.invalidateQueries({ queryKey: ["guest-cart"] });
      } else {
        const res = await fetch("/api/cart/clear", { method: "POST" });
        const j = (await res.json().catch(() => ({} as { error?: string })));
        if (!res.ok) {
          const msg = j?.error || "Failed to clear cart";
          toast.error(msg);
          return;
        }
        // Optimistically clear local cache to avoid stale view
        queryClient.setQueryData(["cart"], { items: [], total: 0 });
        await queryClient.invalidateQueries({ queryKey: ["cart"] });
      }
      setTempQty({});
      setUpdatingIds(new Set());
      toast.info("Cart cleared");
    } finally {
      setClearing(false);
    }
  }

  if (error) {
    toast.error("Error loading your cart");
    return (
      <div className="text-center py-20 text-red-500">
        Error loading cart. Please refresh.
      </div>
    );
  }

  if (!items.length)
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground mb-4">Your cart is empty.</p>
        <Link href="/products">
          <Button>Shop Products</Button>
        </Link>
      </div>
    );

  return (
    <section className="grid gap-6">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold">Your Cart</h1>

        {/* ✅ Clear Cart confirmation dialog */}
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={clearing}>
              Clear Cart
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Clear all items?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              This will remove <strong>all items</strong> from your cart. Are
              you sure you want to continue?
            </p>
            <div className="flex gap-2 justify-end mt-4">
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button
                  variant="destructive"
                  onClick={async () => {
                    await clearCart();
                  }}
                >
                  Confirm
                </Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {/* Mobile: stacked card layout to avoid horizontal scrolling */}
      <div className="grid gap-3 md:hidden">
        {itemsSorted.map((it) => (
          <div key={it.id} className="flex gap-3 border-t pt-3 first:border-t-0">
            <Image
              src={it.product.imageUrl || "/placeholder.png"}
              alt={it.product.name}
              width={64}
              height={64}
              unoptimized
              onError={(e) => {
                const target = e.currentTarget;
                target.src = "/placeholder.png";
              }}
              className="rounded-md object-cover flex-shrink-0"
            />
            <div className="flex-1 space-y-2">
              <div>
                <div className="font-medium">{it.product.name}</div>
                <div className="text-sm text-muted-foreground">
                  {formatCurrency(Number(it.product.price))} each
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Qty</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className="w-20 cursor-pointer"
                        value={tempQty[it.id] ?? String(it.quantity)}
                        onFocus={(e) => {
                          try {
                            (e.target as HTMLInputElement).select();
                          } catch {}
                          setTempQty((prev) => ({
                            ...prev,
                            [it.id]: String(it.quantity),
                          }));
                        }}
                        onClick={(e) => {
                          try {
                            (e.target as HTMLInputElement).select();
                          } catch {}
                        }}
                        onChange={(e) => {
                          const raw = e.target.value || "";
                          let digits = raw.replace(/\D+/g, "").slice(0, 3);
                          if (digits) {
                            const capped = Math.min(100, Number(digits));
                            digits = String(capped);
                          }
                          setTempQty((prev) => ({ ...prev, [it.id]: digits }));
                          const next = Number(digits);
                          if (
                            digits &&
                            Number.isFinite(next) &&
                            next >= 1 &&
                            next <= 100
                          ) {
                            scheduleQtyUpdate(it.id, next, it.product.id);
                          }
                        }}
                        onBlur={async () => {
                          const cur = tempQty[it.id];
                          if (cur) {
                            const existing = qtyTimers.current[it.id];
                            if (existing) {
                              try {
                                clearTimeout(existing);
                              } catch {}
                            }
                            const v = Math.min(100, Math.max(1, Number(cur)));
                            await updateQty(it.id, v, it.product.id);
                            queryClient.invalidateQueries({
                              queryKey: ["cart"],
                            });
                          }
                          setTempQty((prev) => {
                            const n = { ...prev };
                            delete n[it.id];
                            return n;
                          });
                        }}
                        disabled={
                          updatingIds.has(it.id) || removingIds.has(it.id)
                        }
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      side="bottom"
                      className="max-h-60 overflow-y-auto"
                    >
                      {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                        <DropdownMenuItem
                          key={n}
                          onClick={async () => {
                            setTempQty((prev) => ({
                              ...prev,
                              [it.id]: String(n),
                            }));
                            const existing = qtyTimers.current[it.id];
                            if (existing) {
                              try {
                                clearTimeout(existing);
                              } catch {}
                            }
                            await updateQty(it.id, n, it.product.id);
                            queryClient.invalidateQueries({
                              queryKey: ["cart"],
                            });
                            setTempQty((prev) => {
                              const x = { ...prev };
                              delete x[it.id];
                              return x;
                            });
                          }}
                        >
                          {n}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="text-sm font-semibold">
                  {formatCurrency(Number(it.product.price) * it.quantity)}
                </div>
              </div>
              <div className="flex justify-end">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={removingIds.has(it.id)}
                    >
                      Remove
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Remove item?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                      Are you sure you want to remove{" "}
                      <strong>{it.product.name}</strong> from your cart?
                    </p>
                    <div className="flex gap-2 justify-end mt-4">
                      <DialogClose asChild>
                        <Button variant="secondary">Cancel</Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button
                          variant="destructive"
                          onClick={() =>
                            removeItem(
                              it.id,
                              it.product.id,
                              it.product.name,
                              it.quantity
                            )
                          }
                          disabled={removingIds.has(it.id)}
                        >
                          Confirm
                        </Button>
                      </DialogClose>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: tabular layout */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b">
              <th>Item</th>
              <th>Price</th>
              <th>Qty</th>
              <th>Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {itemsSorted.map((it) => (
                <tr
                  key={it.id}
                  className="border-t"
                >
                  <td className="flex items-center gap-3 py-2">
                    <Image
                      src={it.product.imageUrl || "/placeholder.png"}
                      alt={it.product.name}
                      width={50}
                      height={50}
                      unoptimized
                      onError={(e) => {
                        const target = e.currentTarget;
                        target.src = "/placeholder.png";
                      }}
                      className="rounded-md object-cover"
                    />
                    <span>{it.product.name}</span>
                  </td>
                  <td>{formatCurrency(Number(it.product.price))}</td>
                  <td>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          className="w-20 cursor-pointer"
                          value={tempQty[it.id] ?? String(it.quantity)}
                          onFocus={(e) => {
                            try { (e.target as HTMLInputElement).select(); } catch {}
                            setTempQty((prev) => ({ ...prev, [it.id]: String(it.quantity) }));
                          }}
                          onClick={(e) => {
                            // Select on click as well
                            try { (e.target as HTMLInputElement).select(); } catch {}
                          }}
                          onChange={(e) => {
                            const raw = e.target.value || "";
                            let digits = raw.replace(/\D+/g, "").slice(0, 3); // max 3 chars
                            if (digits) {
                              const capped = Math.min(100, Number(digits));
                              digits = String(capped);
                            }
                            setTempQty((prev) => ({ ...prev, [it.id]: digits }));
                            const next = Number(digits);
                            if (digits && Number.isFinite(next) && next >= 1 && next <= 100) {
                              scheduleQtyUpdate(it.id, next, it.product.id);
                            }
                          }}
                          onBlur={async () => {
                            const cur = tempQty[it.id];
                            if (cur) {
                              const existing = qtyTimers.current[it.id];
                              if (existing) { try { clearTimeout(existing); } catch {} }
                              const v = Math.min(100, Math.max(1, Number(cur)));
                              await updateQty(it.id, v, it.product.id);
                              queryClient.invalidateQueries({ queryKey: ["cart"] });
                            }
                            setTempQty((prev) => {
                              const n = { ...prev };
                              delete n[it.id];
                              return n;
                            });
                          }}
                          disabled={updatingIds.has(it.id) || removingIds.has(it.id)}
                        />
                      </DropdownMenuTrigger>
                       <DropdownMenuContent align="start" side="bottom" className="max-h-60 overflow-y-auto">
                        {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                          <DropdownMenuItem
                            key={n}
                            onClick={async () => {
                              setTempQty((prev) => ({ ...prev, [it.id]: String(n) }));
                              const existing = qtyTimers.current[it.id];
                              if (existing) { try { clearTimeout(existing); } catch {} }
                              await updateQty(it.id, n, it.product.id);
                              queryClient.invalidateQueries({ queryKey: ["cart"] });
                              setTempQty((prev) => {
                                const x = { ...prev };
                                delete x[it.id];
                                return x;
                              });
                            }}
                          >
                            {n}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                  <td className="font-semibold">
                    {formatCurrency(Number(it.product.price) * it.quantity)}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="destructive" size="sm" disabled={removingIds.has(it.id)}>
                            Remove
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Remove item?</DialogTitle>
                          </DialogHeader>
                          <p className="text-sm text-muted-foreground">
                            Are you sure you want to remove <strong>{it.product.name}</strong> from your cart?
                          </p>
                          <div className="flex gap-2 justify-end mt-4">
                            <DialogClose asChild>
                              <Button variant="secondary">Cancel</Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button
                                variant="destructive"
                                onClick={() =>
                                  removeItem(
                                    it.id,
                                    it.product.id,
                                    it.product.name,
                                    it.quantity,
                                  )
                                }
                                disabled={removingIds.has(it.id)}
                              >
                                Confirm
                              </Button>
                            </DialogClose>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end text-sm">
        <div className="min-w-[280px] grid gap-1">
          <div className="flex justify-between">
            <span>Items</span>
            <span>{items.length}</span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCurrency(subtotal)}</span>
          </div>
          <div className="mt-3 grid gap-2">
            {!isSignedIn && items.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                You can add items as a guest, but you need to{" "}
                <Link href="/login" className="underline font-medium">
                  sign in or create an account
                </Link>{" "}
                to place your order.
              </p>
            )}
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-muted-foreground">
                Call <strong>{ADMIN_PHONE}</strong> to arrange payment or pay now with MoMo.
              </p>
              <Dialog open={confirmPlaceOrderOpen} onOpenChange={setConfirmPlaceOrderOpen}>
                <DialogTrigger asChild>
                  <Button disabled={!items.length || placing}>
                    Place Order
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Review and confirm order</DialogTitle>
                  </DialogHeader>
                  <div className="text-sm space-y-3">
                    <p className="text-muted-foreground">
                      Please review your order details before placing it and arranging payment with admin.
                    </p>
                    <div className="rounded-md border p-3 bg-muted/40 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">Items</span>
                        <span className="font-medium">{items.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">Order total</span>
                        <span className="font-semibold">{formatCurrency(subtotal)}</span>
                      </div>
                    </div>
                    {creditAvailable > 0 && (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 space-y-1">
                        <p className="font-medium">
                          Store credit available:{" "}
                          <span className="font-semibold">
                            {formatCurrency(creditAvailable)}
                          </span>
                          .
                        </p>
                        <p>
                          For this order, your store credit will be applied
                          automatically once the order is created. Any remaining
                          balance will still need to be paid with cash or MoMo.
                        </p>
                      </div>
                    )}
                    {itemsSorted.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        <span className="font-medium">Includes:</span>{" "}
                        {itemsSorted
                          .slice(0, 3)
                          .map((it) => it.product.name)
                          .join(", ")}
                        {itemsSorted.length > 3 ? "…" : ""}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <DialogClose asChild>
                      <Button variant="secondary">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button
                        onClick={() => {
                          void placeOrder();
                        }}
                        disabled={placing}
                      >
                        Confirm
                      </Button>
                    </DialogClose>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
              <Input
                placeholder="MoMo number"
                value={momoPhone}
                onChange={(e) => setMomoPhone(e.target.value)}
                className="max-w-xs"
              />
              <Input
                placeholder="Amount (optional)"
                inputMode="decimal"
                value={momoAmount}
                onChange={(e) => setMomoAmount(e.target.value)}
                className="w-36"
              />
              <Dialog open={confirmMomoOpen} onOpenChange={setConfirmMomoOpen}>
                <DialogTrigger asChild>
                  <Button disabled={!items.length || momoProcessing}>
                    {momoProcessing ? 'Processing…' : 'Place Order + Pay with MoMo'}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Confirm MoMo payment</DialogTitle>
                  </DialogHeader>
                  <div className="text-sm space-y-3">
                    <p className="text-muted-foreground">
                      You are about to place this order and initiate a Mobile Money (MoMo) payment.
                      Please review the key details below before continuing.
                    </p>
                    <div className="rounded-md border p-3 bg-muted/40 space-y-1">
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">Items</span>
                        <span className="font-medium">{items.length}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">Cart total</span>
                        <span className="font-semibold">{formatCurrency(subtotal)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">MoMo number</span>
                        <span className="font-medium break-all">
                          {momoPhone || me?.phone || "Not provided"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-xs text-muted-foreground">Payment amount</span>
                        <span className="font-medium">
                          {momoAmount
                            ? momoAmount
                            : formatCurrency(subtotal)}
                        </span>
                      </div>
                    </div>
                    {creditAvailable > 0 && (
                      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 space-y-1">
                        <p className="font-medium">
                          Store credit available:{" "}
                          <span className="font-semibold">
                            {formatCurrency(creditAvailable)}
                          </span>
                          .
                        </p>
                        <p>
                          For this purchase, your store credit will be applied
                          first and any remaining amount will then be charged to
                          this MoMo payment.
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <DialogClose asChild>
                      <Button variant="secondary">Cancel</Button>
                    </DialogClose>
                    <DialogClose asChild>
                      <Button
                        onClick={() => {
                          void placeOrderAndPayMomo();
                        }}
                        disabled={momoProcessing}
                      >
                        Confirm &amp; Pay
                      </Button>
                    </DialogClose>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
