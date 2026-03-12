"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function AccountingReportsPage() {
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Accounting Reports</h1>
        <p className="text-sm text-muted-foreground">
          Ledger-backed financial statements.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Profit &amp; Loss</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Income vs expenses for a period.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/reports/pl">View P&amp;L</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Balance Sheet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Assets, liabilities, and equity as of a date.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/reports/balance-sheet">View balance sheet</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Trial Balance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Debits and credits by account.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/reports/trial-balance">View trial balance</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>VAT Report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Output vs input VAT for the period.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/reports/vat">View VAT report</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>VAT Filings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Saved VAT filing snapshots.</p>
            <Button asChild size="sm">
              <Link href="/admin/accounting/vat-filings">View filings</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Order Discounts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Discount tracking by order, user, and reason.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/reports/order-discounts">View discount report</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Scheduled Reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Set up automated report schedules.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/reports/scheduled">Manage schedules</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reconciliation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Review bank reconciliation status.</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/accounting/reconciliations">Open reconciliations</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
