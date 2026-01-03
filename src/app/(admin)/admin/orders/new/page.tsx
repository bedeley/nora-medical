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
  const [taxRate, setTaxRate] = useState<string>("");
  const [errors, setErrors] = useState<{
    userId?: string;
    productId?: string;
    quantity?: string;
    items?: string;
    initialPayment?: string;
    taxRate?: string;
  }>({});
  const [deliveryStatus, setDeliveryStatus] = useState<
    "NOT_SET" | "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED"
  >("NOT_SET");

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [products, productId]
  );

  const subtotal = items.reduce((s, it) => s + it.price * it.quantity, 0);
  const taxRateNum = Number(taxRate || 0);
  const taxAmount =
    Number.isFinite(taxRateNum) && taxRateNum > 0 ? subtotal * (taxRateNum / 100) : 0;
  const total = subtotal + taxAmount;

  function addItem() {
    if (!selectedProduct) {
      setErrors((prev) => ({ ...prev, productId: "Select a product." }));
      return;
    }
    const qty = Math.max(1, Number(quantity || 1));
    if (Number.isNaN(qty) || qty <= 0) {
      setErrors((prev) => ({ ...prev, quantity: "Quantity must be at least 1." }));
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
    setErrors((prev) => ({ ...prev, productId: "", quantity: "", items: "" }));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.productId !== id));
  }

  async function submit() {
    const nextErrors: typeof errors = {};
    if (items.length === 0) {
      nextErrors.items = "Add at least one item.";
    }
    if (!userId) {
      nextErrors.userId = "Select a customer.";
    }
    if (initialPayment.trim()) {
      const initPay = Number(initialPayment || 0);
      if (!Number.isFinite(initPay) || initPay < 0) {
        nextErrors.initialPayment = "Enter a valid initial payment.";
      } else if (initPay > total) {
        nextErrors.initialPayment = "Initial payment cannot exceed the order total.";
      }
    }
    if (taxRate.trim()) {
      const rate = Number(taxRate || 0);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        nextErrors.taxRate = "Enter a tax rate between 0 and 100.";
      }
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    const payload: {
      items: { productId: string; quantity: number }[];
      initialPayment?: number;
      taxRate?: number;
      deliveryStatus?: typeof deliveryStatus;
      userId?: string;
    } = {
      items: items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
    };
    const initPay = Number(initialPayment || 0);
    if (initPay > 0) payload.initialPayment = initPay;
    if (Number.isFinite(taxRateNum) && taxRateNum > 0) payload.taxRate = taxRateNum;
    if (deliveryStatus && deliveryStatus !== "NOT_SET") payload.deliveryStatus = deliveryStatus;
    try {
      const url = "/api/admin/orders";
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
      setErrors({});
      router.push(`/admin/orders/${j.orderId}`);
    } catch {
      toast.error("Unexpected error");
    }
  }

  return (
    <div className="container mx-auto py-8 max-w-5xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Create Order</h1>
          <p className="text-sm text-muted-foreground">
            Build a new order and record optional upfront payment.
          </p>
        </div>
        <Link href="/admin/orders"><Button variant="secondary">Back</Button></Link>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Order Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Customer</label>
              <Select
                value={userId}
                onValueChange={(value) => {
                  setUserId(value);
                  if (errors.userId) setErrors((prev) => ({ ...prev, userId: "" }));
                }}
              >
                <SelectTrigger className={errors.userId ? "border-red-500" : undefined}>
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
              {errors.userId && <p className="mt-1 text-xs text-red-600">{errors.userId}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Initial Payment (optional)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={initialPayment}
                onChange={(e) => {
                  setInitialPayment(e.target.value);
                  if (errors.initialPayment) setErrors((prev) => ({ ...prev, initialPayment: "" }));
                }}
                aria-invalid={!!errors.initialPayment}
                className={errors.initialPayment ? "border-red-500" : undefined}
              />
              {errors.initialPayment && <p className="mt-1 text-xs text-red-600">{errors.initialPayment}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Tax Rate % (optional)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={taxRate}
                onChange={(e) => {
                  setTaxRate(e.target.value);
                  if (errors.taxRate) setErrors((prev) => ({ ...prev, taxRate: "" }));
                }}
                placeholder="0"
                aria-invalid={!!errors.taxRate}
                className={errors.taxRate ? "border-red-500" : undefined}
              />
              {errors.taxRate && <p className="mt-1 text-xs text-red-600">{errors.taxRate}</p>}
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="block text-sm font-medium mb-1">Product</label>
              <Select
                value={productId}
                onValueChange={(value) => {
                  setProductId(value);
                  if (errors.productId) setErrors((prev) => ({ ...prev, productId: "" }));
                }}
              >
                <SelectTrigger className={errors.productId ? "border-red-500" : undefined}>
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
              {errors.productId && <p className="mt-1 text-xs text-red-600">{errors.productId}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Quantity</label>
              <Input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  if (errors.quantity) setErrors((prev) => ({ ...prev, quantity: "" }));
                }}
                aria-invalid={!!errors.quantity}
                className={errors.quantity ? "border-red-500" : undefined}
              />
              {errors.quantity && <p className="mt-1 text-xs text-red-600">{errors.quantity}</p>}
            </div>
            <div>
              <Button onClick={addItem}>Add Item</Button>
            </div>
          </div>
          {errors.items && <p className="text-xs text-red-600">{errors.items}</p>}

          {items.length > 0 && (
            <div className="mt-4">
              <div className="space-y-3 md:hidden">
                {items.map((it) => (
                  <div key={it.productId} className="rounded-md border p-3 text-sm">
                    <div className="font-medium">{it.name}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <div>
                        <div>Qty</div>
                        <div className="text-foreground">{it.quantity}</div>
                      </div>
                      <div>
                        <div>Price</div>
                        <div className="text-foreground">{formatCurrency(it.price)}</div>
                      </div>
                      <div>
                        <div>Total</div>
                        <div className="text-foreground">{formatCurrency(it.price * it.quantity)}</div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() => removeItem(it.productId)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>

              <div className="hidden md:block">
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
                        <td className="py-2 text-right">
                          <Button variant="outline" size="sm" onClick={() => removeItem(it.productId)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end mt-4">
                <div className="w-full max-w-xs text-sm">
                  <div className="flex justify-between py-1">
                    <span>Subtotal</span>
                    <span>{formatCurrency(subtotal)}</span>
                  </div>
                  {taxAmount > 0 && (
                    <div className="flex justify-between py-1">
                      <span>Tax {taxRateNum ? `(${taxRateNum}%)` : ""}</span>
                      <span>{formatCurrency(taxAmount)}</span>
                    </div>
                  )}
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
