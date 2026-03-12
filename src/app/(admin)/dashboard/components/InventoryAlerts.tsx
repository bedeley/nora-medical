"use client";

import { useClientQuery } from "@/hooks/use-client-query";
import Link from "next/link";
import { formatCurrency } from "@/lib/currency";
import { AlertTriangle, CheckCircle, Download } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type InventoryAlert = {
  id: string;
  productId: string;
  name: string;
  price: number | string;
  stock: number;
  updatedAt: string | Date;
  type: string;
  severity: "critical" | "warning";
  message: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function InventoryAlerts() {
  const { data, error, isLoading } = useClientQuery<InventoryAlert[]>({
    queryKey: ["admin","inventory-alerts"],
    queryFn: () => fetcher("/api/admin/inventory-alerts"),
    refetchInterval: 7000,
  });

  const exportCSV = () => {
    if (!data || data.length === 0)
      return alert("No inventory alerts to export.");

    // Convert array to CSV string
    const headers = ["Product", "Price", "Stock", "Type", "Message", "Last Updated"];
    const rows = data.map((p) => {
      return [
        `"${p.name}"`,
        `"${formatCurrency(Number(p.price))}"`,
        p.stock,
        p.type,
        `"${p.message.replace(/"/g, '""')}"`,
        new Date(p.updatedAt).toLocaleString(),
      ].join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    // Create and click a temporary download link
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `inventory-alerts-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (error)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inventory Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-500">Error loading inventory data.</p>
        </CardContent>
      </Card>
    );

  if (isLoading || !data)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inventory Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Loading inventory...</p>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CardTitle>Inventory Alerts</CardTitle>
          {data.length === 0 && (
            <Badge variant="success" className="flex items-center gap-1">
              <CheckCircle className="h-4 w-4" /> All good
            </Badge>
          )}
        </div>

        {/* ✅ CSV Export Button */}
        {data.length > 0 && (
          <Button
            onClick={exportCSV}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
          >
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        )}
      </CardHeader>

      <CardContent>
        {data.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            <p>No low-stock products detected.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/inventory">View inventory</Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/admin/purchases">Add purchase</Link>
              </Button>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Price</TableHead>
              <TableHead>Stock</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>{formatCurrency(Number(p.price))}</TableCell>
                  <TableCell>{p.stock}</TableCell>
                  <TableCell>
                    {p.severity === "critical" ? (
                      <Badge
                        variant="destructive"
                        className="flex items-center gap-1"
                      >
                        <AlertTriangle className="h-3 w-3" /> Critical
                      </Badge>
                    ) : (
                      <Badge
                        variant="warning"
                        className="flex items-center gap-1"
                      >
                        <AlertTriangle className="h-3 w-3" /> {p.type.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{p.message}</TableCell>
                  <TableCell>
                    {new Date(p.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/inventory-planning/${p.productId}`}>View planning</Link>
                      </Button>
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/admin/purchases?product=${p.productId}`}>Add purchase</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
