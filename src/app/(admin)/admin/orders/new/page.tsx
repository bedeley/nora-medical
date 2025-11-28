"use client";

export const dynamic = "force-dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import Link from "next/link";
import { formatCurrency } from "@/lib/currency";

type CustomerRow = { user: { id: string; name: string | null; email: string; phone?: string | null } };
type ProductRow = { id: string; name: string; price: number | string; archived?: boolean };

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function NewAdminOrderPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: customersData } = useClientQuery({ queryKey: ["admin","customers"], queryFn: () => fetcher("/api/admin/customers") });
  const { data: productsData } = useClientQuery({
    queryKey: ["products", { pageSize: 200, includeArchived: 1 }],
    queryFn: () => fetcher("/api/products?pageSize=200&includeArchived=1"),
  });

  const customers: CustomerRow[] = customersData?.rows || [];
  const products: ProductRow[] = useMemo(
    () => (productsData?.items || []) as ProductRow[],
    [productsData],
  );

  const [userId, setUserId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("1");
  const [items, setItems] = useState<{ productId: string; name: string; price: number; quantity: number }[]>([]);
  const [initialPayment, setInitialPayment] = useState<string>("");
  const [deliveryStatus, setDeliveryStatus] = useState<
    "NOT_SET" | "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED"
  >("NOT_SET");

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [products, productId]
  );

  const total = items.reduce((s, it) => s + it.price * it.quantity, 0);

  function addItem() {
    if (!selectedProduct) {
      toast.error("Select a product");
      return;
    }
    const qty = Math.max(1, Number(quantity || 1));
    if (Number.isNaN(qty) || qty <= 0) {
      toast.error("Quantity must be at least 1");
      return;
    }
    setItems((prev) => {
      const existing = prev.find((it) => it.productId === selectedProduct.id);
      if (existing) {
        return prev.map((it) => (it.productId === selectedProduct.id ? { ...it, quantity: it.quantity + qty } : it));
      }
      return [
        ...prev,
        {
          productId: selectedProduct.id,
          name: selectedProduct.name,
          price: Number(selectedProduct.price),
          quantity: qty,
        },
      ];
    });
    setQuantity("1");
    setProductId("");
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.productId !== id));
  }

  async function submit() {
    if (items.length === 0) {
      toast.error("Add at least one item");
      return;
    }
    const payload: {
      items: { productId: string; quantity: number }[];
      initialPayment?: number;
      deliveryStatus?: typeof deliveryStatus;
      userId?: string;
    } = {
      items: items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
    };
    const initPay = Number(initialPayment || 0);
    if (initPay > 0) payload.initialPayment = initPay;
    if (deliveryStatus && deliveryStatus !== "NOT_SET") payload.deliveryStatus = deliveryStatus;
    try {
      const url = "/api/admin/orders";
      if (!userId) {
        toast.error("Select a customer");
        return;
      }
      payload.userId = userId;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j?.error || "Failed to create order");
        return;
      }
      toast.success("Order created");
      queryClient.invalidateQueries({ queryKey: ["admin","orders"] });
      router.push(`/admin/orders/${j.orderId}`);
    } catch {
      toast.error("Unexpected error");
    }
  }

  return (
    <div className="container mx-auto py-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Create Order (Admin)</h1>
        <Link href="/admin/orders"><Button variant="secondary">Back</Button></Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Order Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Customer</label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a customer" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((row) => (
                    <SelectItem key={row.user.id} value={row.user.id}>
                      {row.user.name || row.user.email} {row.user.phone ? `- ${row.user.phone}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Initial Payment (optional)</label>
              <Input type="number" min="0" step="0.01" value={initialPayment} onChange={(e) => setInitialPayment(e.target.value)} />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium mb-1">Product</label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} - {formatCurrency(Number(p.price))} {p.archived ? "(archived)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Quantity</label>
              <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div>
              <Button onClick={addItem}>Add Item</Button>
            </div>
          </div>

          {items.length > 0 && (
            <div className="mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2">Item</th>
                    <th className="text-right py-2">Qty</th>
                    <th className="text-right py-2">Price</th>
                    <th className="text-right py-2">Total</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.productId} className="border-b last:border-0">
                      <td className="py-2">{it.name}</td>
                      <td className="text-right py-2">{it.quantity}</td>
                      <td className="text-right py-2">{formatCurrency(it.price)}</td>
                      <td className="text-right py-2">{formatCurrency(it.price * it.quantity)}</td>
                      <td className="py-2 text-right"><Button variant="outline" size="sm" onClick={() => removeItem(it.productId)}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-end mt-4">
                <div className="w-64 text-sm">
                  <div className="flex justify-between py-1 font-semibold">
                    <span>Total</span>
                    <span>{formatCurrency(total)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Delivery Status</label>
              <Select
                value={deliveryStatus}
                onValueChange={(
                  v:
                    | "NOT_SET"
                    | "NOT_DELIVERED"
                    | "PARTIALLY_DELIVERED"
                    | "DELIVERED"
                    | "RETURNED",
                ) => setDeliveryStatus(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Default: Not Delivered" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NOT_SET">Not set</SelectItem>
                  <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
                  <SelectItem value="PARTIALLY_DELIVERED">Partially Delivered</SelectItem>
                  <SelectItem value="DELIVERED">Delivered</SelectItem>
                  <SelectItem value="RETURNED">Returned</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={submit}>Create Order</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
