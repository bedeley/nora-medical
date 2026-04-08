// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReplace = vi.fn();
let searchParamsValue = "start=2026-03-01&end=2026-03-31&groupBy=day";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/admin/dashboard",
  useSearchParams: () => new URLSearchParams(searchParamsValue),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("@/app/(admin)/dashboard/components/AddExpenseDialog", () => ({
  default: ({ onAdded }: { onAdded?: () => void }) => (
    <button type="button" onClick={onAdded}>Add Expense</button>
  ),
}));

vi.mock("@/app/(admin)/dashboard/components/ProfitSummary", () => ({
  default: () => <div data-testid="profit-summary">Profit summary</div>,
}));

vi.mock("@/app/(admin)/dashboard/components/InventoryAlerts", () => ({
  default: () => <div data-testid="inventory-alerts">Inventory alerts</div>,
}));

vi.mock("@/app/(admin)/dashboard/components/MarginRisk", () => ({
  default: () => <div data-testid="margin-risk">Margin risk</div>,
}));

vi.mock("@/app/(admin)/dashboard/components/MonitoringSummary", () => ({
  default: () => <div data-testid="monitoring-summary">Monitoring summary</div>,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div data-testid="chart">{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Line: () => null,
  Bar: () => null,
  Legend: () => null,
}));

import AdminDashboardPage from "./page";

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: "application/json" }),
  };
}

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, "http://localhost");

    switch (url.pathname) {
      case "/api/admin/accounting/periods":
        return jsonResponse([
          {
            id: "period-1",
            name: "Mar 2026",
            startDate: "2026-03-01T00:00:00.000Z",
            endDate: "2026-03-31T00:00:00.000Z",
            status: "OPEN",
          },
        ]);
      case "/api/admin/accounting/vat-filings":
        return jsonResponse([
          {
            id: "vat-1",
            startDate: "2026-03-01T00:00:00.000Z",
            endDate: "2026-03-31T00:00:00.000Z",
            createdAt: "2026-03-29T00:00:00.000Z",
          },
        ]);
      case "/api/admin/accounting/integrity":
        return jsonResponse({
          draftEntries: 0,
          arDifference: 0,
          inventoryDifference: 0,
          negativeStockCount: 0,
        });
      case "/api/admin/top-products":
      case "/api/admin/top-customers":
        return jsonResponse([]);
      case "/api/admin/health/summary":
        return jsonResponse({
          paymentMismatches: 1,
          orderBalanceMismatches: 0,
          stockMismatches: 2,
          legacyAutoApply: 0,
        });
      case "/api/admin/summary":
        return jsonResponse({
          summary: {
            totalRevenue: 1000,
            totalRefunds: 50,
            netRevenue: 950,
            totalCOGS: 400,
            totalExpense: 250,
            profit: 300,
            margin: 31.6,
            orderCount: 10,
            averageOrderValue: 95,
            totalCashIn: 500,
            totalCashOut: 80,
            netCash: 420,
            totalOutstanding: 100,
            totalBilled: 1050,
            totalTaxCollected: 50,
            totalDiscounts: 20,
            discountedOrders: 1,
            totalCollectedOnPeriodSales: 950,
            totalOutstandingOnPeriodSales: 100,
            reconciliationDelta: 0,
            deliveredCount: 7,
            partiallyDeliveredCount: 1,
            returnedCount: 1,
            pendingCount: 1,
            expenseBreakdown: [{ category: "Payroll", amount: 150 }],
          },
          trend: [
            { date: "2026-03-01", revenue: 400, expense: 100, profit: 120, margin: 30, cashIn: 200, outstanding: 60, netRevenue: 380 },
            { date: "2026-03-02", revenue: 600, expense: 150, profit: 180, margin: 30, cashIn: 300, outstanding: 40, netRevenue: 570 },
          ],
        });
      case "/api/admin/accounting/reports/ledger-summary":
        return jsonResponse({
          summary: {
            totalRevenue: 980,
            totalCOGS: 390,
            totalExpense: 240,
            totalCashIn: 480,
            totalCashOut: 70,
            profit: 350,
            margin: 35.7,
            orderCount: 10,
            averageOrderValue: 98,
            expenseBreakdown: [{ category: "Payroll", amount: 140 }],
          },
          trend: [
            { date: "2026-03-01", revenue: 390, expense: 95, profit: 140, margin: 35, cashIn: 180, outstanding: 60, netRevenue: 390 },
            { date: "2026-03-02", revenue: 590, expense: 145, profit: 210, margin: 35.6, cashIn: 300, outstanding: 40, netRevenue: 590 },
          ],
        });
      default:
        throw new Error(`Unhandled fetch in dashboard test: ${url.pathname}${url.search}`);
    }
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <AdminDashboardPage />
    </QueryClientProvider>,
  );
}

describe("AdminDashboardPage", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    searchParamsValue = "start=2026-03-01&end=2026-03-31&groupBy=day";
    vi.stubGlobal("fetch", createFetchMock());
  });

  it("renders the redesigned dashboard shell with key sections", { timeout: 15000 }, async () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(/track revenue, expenses, and cash flow at a glance/i)).toBeInTheDocument();

    await screen.findByText("Mar 2026");
    expect(screen.getByText(/health check issues detected/i)).toBeInTheDocument();
    expect(screen.getByText(/^financial reporting$/i)).toBeInTheDocument();
    expect(screen.getByText(/cash \(payment-date basis\)/i)).toBeInTheDocument();
    expect(screen.getByText(/^operational context$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /comparison on/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^day$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /review outstanding/i })).toBeInTheDocument();
  });

  it("preserves active period params in quick links and syncs groupBy changes to the router", async () => {
    renderPage();

    const outstandingLink = await screen.findByRole("link", { name: /review outstanding/i });
    expect(outstandingLink).toHaveAttribute("href", "/admin/balances?start=2026-03-01&end=2026-03-31");

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        "/admin/dashboard?start=2026-03-01&end=2026-03-31&groupBy=day",
        { scroll: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /^month$/i }));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/admin/dashboard?start=2026-03-01&end=2026-03-31&groupBy=month",
        { scroll: false },
      ),
    );
  });
});
