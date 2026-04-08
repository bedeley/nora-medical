"use client";

import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type HistoryItem = {
  id: string;
  status: string;
  total: number | string;
  createdAt: string | Date;
  items: Array<{
    id: string;
    quantity: number;
    price: number | string;
    product: { name: string } | null;
  }>;
};

type OrdersResponse = {
  items: HistoryItem[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function OrderHistoryPage() {
  const { data: balance } = useQuery({
    queryKey: ["balance", "self"],
    queryFn: () => fetcher("/api/balance?self=1"),
    refetchInterval: 2000,
  });
  const { data: orders } = useQuery<OrdersResponse>({
    queryKey: ["orders"],
    queryFn: () => fetcher("/api/orders"),
    refetchInterval: 2000,
  });
  const orderItems = orders?.items ?? [];

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Order History</h1>

      {balance && (
        <Card className="border-none shadow-md py-3">
          <CardHeader className="py-3">
            <CardTitle>Your Balance Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm py-3">
            <p>
              <strong>Total Purchases:</strong>{" "}
              {formatCurrency(balance.totalDue)}
            </p>
            <p>
              <strong>Total Paid:</strong> {formatCurrency(balance.totalPaid)}
            </p>
            <p>
              <strong>Balance Remaining:</strong>{" "}
              {formatCurrency(balance.balance)}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {orderItems.map((order) => (
          <Card
            key={order.id}
            className="border-none shadow-md py-3"
          >
            <CardHeader className="py-3">
              <CardTitle className="text-sm">
                Order {formatIdReadable(order.id)}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm py-3">
              <p>
                <strong>Status:</strong> {order.status}
              </p>
              <p>
                <strong>Total:</strong> {formatCurrency(Number(order.total || 0))}
              </p>
              <p>
                <strong>Created:</strong>{" "}
                {new Date(order.createdAt).toLocaleString()}
              </p>
              <div className="mt-2">
                <h4 className="font-medium mb-1">Items:</h4>
                <ul className="list-disc ml-4">
                  {order.items.map((it) => (
                    <li key={it.id}>
                      {it.quantity} × {it.product?.name ?? "Unknown item"} —{" "}
                      {formatCurrency(Number(it.price) * it.quantity)}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-3 flex justify-end">
                <a
                  href={`/orders/${order.id}/receipt`}
                  className="text-sm underline"
                  title="View printable receipt"
                >
                  View receipt
                </a>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
