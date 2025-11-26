"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";
import Link from "next/link";
// framer-motion removed to avoid layout jitter on /cart
import { ADMIN_PHONE } from "@/lib/config";

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

export default function CartPage() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({
    queryKey: ["account", "me"],
    queryFn: () => fetch("/api/account/me").then((r) => r.json()),
    refetchInterval: 15000,
  });

  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [tempQty, setTempQty] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [momoPhone, setMomoPhone] = useState("");
  const [momoAmount, setMomoAmount] = useState("");
  const [momoProcessing, setMomoProcessing] = useState(false);
  const qtyTimers = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});
  const { data, error } = useQuery({
    queryKey: ["cart"],
    queryFn: () => fetch("/api/cart").then((r) => r.json()),
    // Avoid frequent auto-refresh to prevent layout jitter
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const items: CartItem[] = (data?.items || []).map(
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
  const itemsSorted = useMemo(() => {
    try {
      return [...items].sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return tb - ta;
      });
    } catch {
      return items;
    }
  }, [items]);

  const subtotal = items.reduce(
    (s, it) => s + Number(it.product.price) * it.quantity,
    0
  );

  async function placeOrder() {
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

  async function removeItem(itemId: string, productId: string, name: string) {
    try {
      setRemovingIds((s) => new Set(s).add(itemId));
      const res = await fetch(`/api/cart/item/${itemId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      toast.warning(`${name} removed.`, {
        action: {
          label: "Undo",
          onClick: async () => {
            await fetch("/api/cart", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ productId, quantity: 1 }),
            });
            queryClient.invalidateQueries({ queryKey: ["cart"] });
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

  async function updateQty(id: string, quantity: number) {
    if (!Number.isFinite(quantity) || quantity < 1) return;
    try {
      setUpdatingIds((s) => new Set(s).add(id));
      await fetch(`/api/cart/item/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      toast.info("Cart updated");
    } finally {
      setUpdatingIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      // Keep temp value during editing; clear on blur instead
    }
  }

  function scheduleQtyUpdate(id: string, quantity: number) {
    const existing = qtyTimers.current[id];
    if (existing) {
      try { clearTimeout(existing); } catch {}
    }
    qtyTimers.current[id] = setTimeout(() => {
      updateQty(id, quantity);
    }, 300);
  }

  async function clearCart() {
    try {
      setClearing(true);
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
      setTempQty({});
      setUpdatingIds(new Set());
      toast.info("Cart cleared");
    } finally {
      setClearing(false);
    }
  }

  // Gate cart access for unverified accounts: force them through the account
  // verification flow before using the cart.
  if (me && !me.phoneVerifiedAt) {
    return (
      <section className="container mx-auto py-12">
        <h1 className="text-2xl font-semibold mb-2">Verify Your Account</h1>
        <p className="text-sm text-muted-foreground mb-4">
          Your account is not fully verified yet. Please request a verification code
          on the Account page and enter it there before using the cart.
        </p>
        <Link href="/account?verify=1" className="underline text-sm">
          Go to verification page
        </Link>
      </section>
    );
  }

  if (error) {
    toast.error("Error loading your cart");
    return (
      <div className="text-center py-20 text-red-500">
        Error loading cart. Please refresh.
      </div>
    );
  }

  if (data && !items.length)
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

      <div className="overflow-x-auto">
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
                              scheduleQtyUpdate(it.id, next);
                            }
                          }}
                          onBlur={async () => {
                            const cur = tempQty[it.id];
                            if (cur) {
                              const existing = qtyTimers.current[it.id];
                              if (existing) { try { clearTimeout(existing); } catch {} }
                              const v = Math.min(100, Math.max(1, Number(cur)));
                              await updateQty(it.id, v);
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
                              await updateQty(it.id, n);
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
                                onClick={() => removeItem(it.id, it.product.id, it.product.name)}
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground">
                Call <strong>{ADMIN_PHONE}</strong> to arrange payment or pay now with MoMo.
              </p>
              <Button onClick={placeOrder} disabled={!items.length || placing}>
                Place Order
              </Button>
            </div>
            <div className="flex items-center justify-end gap-2">
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
              <Button onClick={placeOrderAndPayMomo} disabled={!items.length || momoProcessing}>
                {momoProcessing ? 'Processing…' : 'Place Order + Pay with MoMo'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
