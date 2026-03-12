"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/currency";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  subtype?: string | null;
  debit: number;
  credit: number;
};

type BalanceSheetResponse = {
  assets: AccountRow[];
  liabilities: AccountRow[];
  equity: AccountRow[];
  totals: {
    assets: number;
    liabilities: number;
    equity: number;
    liabilitiesPlusEquity: number;
  };
  asOf: string;
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

function prevDay(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function displayNet(row: AccountRow, positiveDebit: boolean) {
  return positiveDebit ? row.debit - row.credit : row.credit - row.debit;
}

function liabilityCreditBalance(row: AccountRow) {
  return Math.max(displayNet(row, false), 0);
}

function liabilityDebitBalance(row: AccountRow) {
  return Math.max(-displayNet(row, false), 0);
}

function isCurrentAccount(row: AccountRow, section: "ASSET" | "LIABILITY") {
  const subtype = (row.subtype || "").toLowerCase();
  if (subtype.includes("non-current") || subtype.includes("noncurrent") || subtype.includes("long-term")) {
    return false;
  }
  if (subtype.includes("current") || subtype.includes("short-term")) {
    return true;
  }
  if (section === "ASSET") {
    return ["1000", "1010", "1020", "1030", "1040", "1100", "1200"].includes(row.code);
  }
  return row.code.startsWith("2");
}

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [showSignedValues, setShowSignedValues] = useState(false);
  const hasUserEdited = useRef(false);

  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);
  const currentOpenPeriod = useMemo(() => {
    const today = new Date();
    return periods.find((period) => {
      if (period.status !== "OPEN") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return today >= startDate && today <= endDate;
    });
  }, [periods]);

  useEffect(() => {
    if (hasUserEdited.current) return;
    if (!currentOpenPeriod) return;
    setAsOf(currentOpenPeriod.endDate.slice(0, 10));
  }, [currentOpenPeriod]);

  const { data, isLoading } = useClientQuery<BalanceSheetResponse>({
    queryKey: ["accounting", "reports", "balance-sheet", { asOf }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (asOf) params.set("asOf", asOf);
      return fetch(`/api/admin/accounting/reports/balance-sheet?${params.toString()}`).then((r) => r.json());
    },
  });

  const prevAsOf = useMemo(() => (asOf ? prevDay(asOf) : ""), [asOf]);
  const { data: previousData } = useClientQuery<BalanceSheetResponse>({
    queryKey: ["accounting", "reports", "balance-sheet", "previous", prevAsOf],
    queryFn: () => {
      const params = new URLSearchParams();
      if (prevAsOf) params.set("asOf", prevAsOf);
      return fetch(`/api/admin/accounting/reports/balance-sheet?${params.toString()}`).then((r) => r.json());
    },
    enabled: Boolean(prevAsOf),
  });

  const assets = data?.assets || [];
  const liabilities = data?.liabilities || [];
  const equity = data?.equity || [];
  const currentAssetsRows = assets.filter((row) => isCurrentAccount(row, "ASSET"));
  const nonCurrentAssetsRows = assets.filter((row) => !isCurrentAccount(row, "ASSET"));
  const currentLiabilityRows = liabilities.filter((row) => isCurrentAccount(row, "LIABILITY"));
  const nonCurrentLiabilityRows = liabilities.filter((row) => !isCurrentAccount(row, "LIABILITY"));
  const liabilitiesCreditTotal = liabilities.reduce((sum, row) => sum + liabilityCreditBalance(row), 0);
  const liabilitiesDebitOffsetTotal = liabilities.reduce((sum, row) => sum + liabilityDebitBalance(row), 0);

  const isClosedAsOf = useMemo(() => {
    if (!asOf) return false;
    const asOfDate = new Date(`${asOf}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return asOfDate >= startDate && asOfDate <= endDate;
    });
  }, [periods, asOf]);

  const renderRows = (rows: AccountRow[], positiveDebit: boolean, section: "ASSET" | "LIABILITY" | "EQUITY") =>
    rows.map((row) => (
      <div key={row.accountId} className="flex justify-between gap-2">
        <Link
          className="underline underline-offset-2"
          href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${asOf ? `&end=${encodeURIComponent(asOf)}` : ""}`}
        >
          {row.code} · {row.name}
        </Link>
        {section === "LIABILITY" && !showSignedValues ? (
          <span className={displayNet(row, positiveDebit) < 0 ? "text-amber-700" : undefined}>
            {displayNet(row, positiveDebit) < 0 ? "Dr " : ""}
            {formatCurrency(Math.abs(displayNet(row, positiveDebit)))}
          </span>
        ) : section === "EQUITY" && !showSignedValues ? (
          (() => {
            const net = displayNet(row, positiveDebit);
            const isCurrentPeriodPL =
              String(row.code || "").toUpperCase() === "CPL" ||
              /current period/i.test(String(row.name || ""));
            if (isCurrentPeriodPL) {
              return (
                <span className={net < 0 ? "text-rose-700 font-semibold" : "text-emerald-700 font-semibold"}>
                  {net < 0 ? "Loss " : "Profit "}
                  {formatCurrency(Math.abs(net))}
                </span>
              );
            }
            return <span>{formatCurrency(Math.abs(net))}</span>;
          })()
        ) : (
          <span>
            {formatCurrency(
              showSignedValues || section === "ASSET"
                ? displayNet(row, positiveDebit)
                : Math.abs(displayNet(row, positiveDebit)),
            )}
          </span>
        )}
      </div>
    ));

  const query = new URLSearchParams(asOf ? { asOf } : {}).toString();
  const currentAssets = data?.totals?.assets || 0;
  const priorAssets = previousData?.totals?.assets || 0;
  const assetsDelta = currentAssets - priorAssets;
  const liquidityOverdraftCodes = new Set(["1000", "1010", "1020", "1030", "1040"]);
  const liquidityCurrentAssets = currentAssetsRows.reduce((sum, row) => {
    const net = displayNet(row, true);
    if (liquidityOverdraftCodes.has(row.code)) {
      return sum + (net > 0 ? net : 0);
    }
    return sum + Math.max(net, 0);
  }, 0);
  const overdraftReclass = currentAssetsRows.reduce((sum, row) => {
    if (!liquidityOverdraftCodes.has(row.code)) return sum;
    const net = displayNet(row, true);
    return sum + (net < 0 ? Math.abs(net) : 0);
  }, 0);
  const liquidityCurrentLiabilitiesBase = currentLiabilityRows.reduce(
    (sum, row) => sum + liabilityCreditBalance(row),
    0,
  );
  const currentLiabilityDebitOffsets = currentLiabilityRows.reduce(
    (sum, row) => sum + liabilityDebitBalance(row),
    0,
  );
  const liquidityCurrentLiabilities = Math.max(
    liquidityCurrentLiabilitiesBase + overdraftReclass - currentLiabilityDebitOffsets,
    0,
  );
  const workingCapital = liquidityCurrentAssets - liquidityCurrentLiabilities;
  const currentRatio =
    liquidityCurrentLiabilities > 0 ? liquidityCurrentAssets / liquidityCurrentLiabilities : null;
  const liabilitiesNetSigned = data?.totals?.liabilities || 0;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Balance Sheet</h1>
        <p className="text-sm text-muted-foreground">Snapshot of assets, liabilities, and equity.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod ? `Current period: ${currentOpenPeriod.name}` : "No open fiscal period."}
        </p>
        {!isClosedAsOf ? (
          <p className="text-xs text-amber-700 mt-1">
            As-of date is not in a closed period. Balances can still change with new postings.
          </p>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>As of</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-auto"
            type="date"
            value={asOf}
            onChange={(e) => {
              hasUserEdited.current = true;
              setAsOf(e.target.value);
            }}
          />
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/balance-sheet/export?${query}`}>Export CSV</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/pack/export?${query}`}>Export reporting pack</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
          </Button>
          <label className="inline-flex items-center gap-2 text-sm ml-auto">
            <input
              type="checkbox"
              checked={showSignedValues}
              onChange={(e) => setShowSignedValues(e.target.checked)}
            />
            Show signed values
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
          <div className="rounded border p-3">
            <Tooltip content="Signed total assets as-of date from posted ledger lines. Formula: sum(ASSET account net balances).">
              <div className="text-muted-foreground cursor-help">Assets (net signed)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(currentAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Same signed assets calculation, but as of the prior day.">
              <div className="text-muted-foreground cursor-help">Assets (prior day signed)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(priorAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Delta = Assets (net signed) - Assets (prior day signed).">
              <div className="text-muted-foreground cursor-help">Delta</div>
            </Tooltip>
            <div className="font-semibold">{assetsDelta >= 0 ? "+" : ""}{formatCurrency(assetsDelta)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Working capital = Current assets (liquidity) - Current liabilities (liquidity).">
              <div className="text-muted-foreground cursor-help">Working capital</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(workingCapital)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Current ratio = Current assets (liquidity) / Current liabilities (liquidity).">
              <div className="text-muted-foreground cursor-help">Current ratio</div>
            </Tooltip>
            <div className="font-semibold">{currentRatio === null ? "N/A" : `${currentRatio.toFixed(2)}x`}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liquidity Basis</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded border p-3">
            <Tooltip content="Liquidity current assets use only positive current-asset balances. Negative cash/bank balances are excluded here and reclassified to liabilities.">
              <div className="text-muted-foreground cursor-help">Current assets (liquidity)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(liquidityCurrentAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Liquidity current liabilities = positive current liabilities + overdraft reclass - liability debit offsets (prepayments/over-settlement).">
              <div className="text-muted-foreground cursor-help">Current liabilities (liquidity)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(liquidityCurrentLiabilities)}</div>
            {overdraftReclass > 0 ? (
              <div className="text-xs text-muted-foreground mt-1">
                Includes overdraft reclass: {formatCurrency(overdraftReclass)}
              </div>
            ) : null}
            {currentLiabilityDebitOffsets > 0 ? (
              <div className="text-xs text-muted-foreground">
                Less debit offsets: {formatCurrency(currentLiabilityDebitOffsets)}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assets</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : (
            <>
              <div className="font-medium text-xs uppercase text-muted-foreground pt-1">Current assets</div>
              {renderRows(currentAssetsRows, true, "ASSET")}
              <div className="font-medium text-xs uppercase text-muted-foreground pt-2">Non-current assets</div>
              {renderRows(nonCurrentAssetsRows, true, "ASSET")}
            </>
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total assets</span>
            <span>{formatCurrency(data?.totals?.assets || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liabilities</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : (
            <>
              <div className="font-medium text-xs uppercase text-muted-foreground pt-1">Current liabilities</div>
              {renderRows(currentLiabilityRows, false, "LIABILITY")}
              <div className="font-medium text-xs uppercase text-muted-foreground pt-2">Non-current liabilities</div>
              {renderRows(nonCurrentLiabilityRows, false, "LIABILITY")}
            </>
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total liabilities (credit balances)</span>
            <span>
              {formatCurrency(
                showSignedValues ? data?.totals?.liabilities || 0 : liabilitiesCreditTotal,
              )}
            </span>
          </div>
          {!showSignedValues && liabilitiesDebitOffsetTotal > 0 ? (
            <div className="flex justify-between text-xs text-amber-700">
              <span>Debit balance offsets (prepayments/over-settlement)</span>
              <span>{formatCurrency(liabilitiesDebitOffsetTotal)}</span>
            </div>
          ) : null}
          {!showSignedValues ? (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Net liabilities (signed)</span>
              <span className={liabilitiesNetSigned < 0 ? "text-amber-700" : undefined}>
                {liabilitiesNetSigned < 0 ? "Dr " : ""}
                {formatCurrency(Math.abs(liabilitiesNetSigned))}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equity</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : renderRows(equity, false, "EQUITY")}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total equity</span>
            <span>{formatCurrency(showSignedValues ? data?.totals?.equity || 0 : Math.abs(data?.totals?.equity || 0))}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <div className="flex justify-between">
            <span>Assets</span>
            <span>{formatCurrency(data?.totals?.assets || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Liabilities + Equity</span>
            <span>{formatCurrency(data?.totals?.liabilitiesPlusEquity || 0)}</span>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

