"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type BankAccount = {
  id: string;
  name: string;
  bankName?: string | null;
  currency: string;
  isActive: boolean;
};

type TransactionRow = {
  id: string;
  postedAt: string;
  amount: number | string;
  type: "DEBIT" | "CREDIT";
  description?: string | null;
  reference?: string | null;
  matched: boolean;
  bankAccountId: string;
  bankAccount: {
    id: string;
    name: string;
    bankName?: string | null;
    currency: string;
    isActive: boolean;
  };
};

type ResponseShape = {
  total: number;
  page: number;
  pageSize: number;
  rows: TransactionRow[];
};

function bankDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { timeZone: "UTC" });
}

async function fetchJsonOrThrow<T>(input: string): Promise<T> {
  const res = await fetch(input, { cache: "no-store" });
  const payload = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
  if (!res.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error || `Request failed (${res.status})`)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export default function AllBankTransactionsPage() {
  const searchParams = useSearchParams();
  const initialBankAccountId = String(searchParams.get("bankAccountId") || searchParams.get("bankId") || "").trim();
  const [q, setQ] = useState("");
  const [bankAccountId, setBankAccountId] = useState(initialBankAccountId);
  const [matched, setMatched] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => {
    setBankAccountId(initialBankAccountId);
    setPage(1);
  }, [initialBankAccountId]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (bankAccountId) p.set("bankAccountId", bankAccountId);
    if (matched !== "all") p.set("matched", matched === "matched" ? "1" : "0");
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    return p.toString();
  }, [q, bankAccountId, matched, from, to, page, pageSize]);

  const {
    data: banksData,
    isError: banksIsError,
    error: banksError,
  } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetchJsonOrThrow<BankAccount[]>("/api/admin/accounting/banks"),
  });
  const banks = useMemo(
    () => (Array.isArray(banksData) ? banksData : []),
    [banksData],
  );
  const selectedBank = useMemo(
    () => banks.find((bank) => bank.id === bankAccountId) || null,
    [banks, bankAccountId],
  );

  const {
    data,
    isLoading,
    isError,
    error,
  } = useClientQuery<ResponseShape>({
    queryKey: ["accounting", "all-bank-transactions", params],
    queryFn: () => fetchJsonOrThrow<ResponseShape>(`/api/admin/accounting/banks/all-transactions?${params}`),
  });

  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const total = Number(data?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">All Banks Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Read-only global search across all bank accounts.
          </p>
          {selectedBank ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Scoped from bank context: <span className="font-medium text-foreground">{selectedBank.name}</span>
            </p>
          ) : null}
        </div>
        <Button asChild size="sm" variant="outline">
          <Link
            href={
              bankAccountId
                ? `/admin/accounting/banks?bankId=${encodeURIComponent(bankAccountId)}`
                : "/admin/accounting/banks"
            }
          >
            Back to bank-scoped page
          </Link>
        </Button>
      </div>

      {banksIsError ? (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {banksError instanceof Error ? banksError.message : "Failed to load bank accounts."}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <label className="space-y-1 xl:col-span-2">
              <span className="text-xs font-medium text-muted-foreground">Search</span>
              <Input
                placeholder="Search description, reference, bank..."
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Bank account</span>
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={bankAccountId}
                onChange={(e) => {
                  setBankAccountId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All banks</option>
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {bank.name} ({bank.currency})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Match status</span>
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={matched}
                onChange={(e) => {
                  setMatched(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">Matched + unmatched</option>
                <option value="matched">Matched only</option>
                <option value="unmatched">Unmatched only</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">From date</span>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">To date</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-xs"
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              <option value="25">25 / page</option>
              <option value="50">50 / page</option>
              <option value="100">100 / page</option>
              <option value="200">200 / page</option>
            </select>
            <span className="text-xs text-muted-foreground">{total} total row(s)</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isError ? (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error instanceof Error ? error.message : "Failed to load transactions."}
            </div>
          ) : null}
          {isLoading ? <p className="text-muted-foreground">Loading transactions...</p> : null}
          {!isLoading && !isError && rows.length === 0 ? (
            <p className="text-muted-foreground">No transactions found.</p>
          ) : null}
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
              <div className="space-y-0.5">
                <div className="font-medium">
                  {bankDate(row.postedAt)} - {row.description || row.reference || "Transaction"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.bankAccount.name}
                  {row.bankAccount.bankName ? ` · ${row.bankAccount.bankName}` : ""}
                  {!row.bankAccount.isActive ? " · inactive" : ""} · {row.type} ·{" "}
                  {row.matched ? "matched" : "unmatched"} · ref: {row.reference || "-"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span>
                  {row.type === "CREDIT" ? "+" : "-"} {Number(row.amount).toFixed(2)}
                </span>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/accounting/banks?bankId=${encodeURIComponent(row.bankAccountId)}`}>
                    Open bank context
                  </Link>
                </Button>
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
            <span>
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
