"use client";

import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";

type MarginRiskRow = {
  productId: string;
  name: string;
  sku: string;
  price: number;
  cost: number;
  marginPct: number;
  minMarginPct: number;
  shortfall: number;
};

type Payload = {
  rows: MarginRiskRow[];
  total: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function MarginRisk() {
  const { data, isLoading, error } = useClientQuery<Payload>({
    queryKey: ["admin", "margin-risk"],
    queryFn: () => fetcher("/api/admin/margin-risk?limit=10"),
    refetchInterval: false,
  });

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Margin risk</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">Failed to load margin risk items.</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Margin risk</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading margin alerts…</p>
        </CardContent>
      </Card>
    );
  }

  if (!data.rows.length) {
    return (
      <Card>
        <CardHeader className="flex items-center gap-2">
          <CardTitle>Margin risk</CardTitle>
          <Badge variant="success">All good</Badge>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No products are below their minimum margin targets.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Margin risk</CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/products">Review pricing</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Margin</TableHead>
              <TableHead>Min</TableHead>
              <TableHead>Shortfall</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.productId}>
                <TableCell>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-muted-foreground">SKU: {row.sku || "—"}</div>
                </TableCell>
                <TableCell>{formatCurrency(row.price)}</TableCell>
                <TableCell>{formatCurrency(row.cost)}</TableCell>
                <TableCell className="text-amber-600">{row.marginPct.toFixed(1)}%</TableCell>
                <TableCell>{row.minMarginPct.toFixed(1)}%</TableCell>
                <TableCell className="text-red-600">-{row.shortfall.toFixed(1)}%</TableCell>
                <TableCell>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/admin/products?edit=${row.productId}`}>Edit</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
