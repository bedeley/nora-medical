"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

type TaxCode = {
  id: string;
  name: string;
  rate: number | string;
  type: "OUTPUT" | "INPUT" | "EXEMPT" | "ZERO";
  isActive: boolean;
};

const taxTypes: Array<TaxCode["type"]> = ["OUTPUT", "INPUT", "EXEMPT", "ZERO"];

export default function TaxCodesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useClientQuery<TaxCode[]>({
    queryKey: ["accounting", "tax-codes"],
    queryFn: () => fetch("/api/admin/accounting/tax-codes").then((r) => r.json()),
  });
  const codes = Array.isArray(data) ? data : [];

  const [name, setName] = useState("");
  const [rate, setRate] = useState("");
  const [type, setType] = useState<TaxCode["type"]>("OUTPUT");
  const [saving, setSaving] = useState(false);

  const createCode = async () => {
    if (!name.trim()) {
      toast.error("Tax code name is required.");
      return;
    }
    const numericRate = Number(rate);
    if (!Number.isFinite(numericRate) || numericRate < 0) {
      toast.error("Enter a valid VAT rate.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/tax-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          rate: numericRate,
          type,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to create tax code");
      }
      toast.success("Tax code created.");
      setName("");
      setRate("");
      setType("OUTPUT");
      queryClient.invalidateQueries({ queryKey: ["accounting", "tax-codes"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create tax code.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">VAT &amp; Tax Codes</h1>
        <p className="text-sm text-muted-foreground">
          Maintain VAT rates and tax categories.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add tax code</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Name (e.g., VAT 15%)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Rate %"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as TaxCode["type"])}
          >
            {taxTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createCode} disabled={saving}>
              {saving ? "Saving..." : "Add tax code"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tax codes</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading tax codes...</p>
          ) : codes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tax codes yet.</p>
          ) : (
            <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.map((code) => (
                  <TableRow key={code.id}>
                    <TableCell>{code.name}</TableCell>
                    <TableCell>{code.type}</TableCell>
                    <TableCell>{Number(code.rate).toFixed(2)}%</TableCell>
                    <TableCell>{code.isActive ? "Active" : "Inactive"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
