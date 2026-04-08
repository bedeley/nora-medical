// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReplace = vi.fn();
let searchParamsValue = "asOf=2026-04-01";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/admin/accounting/integrity",
  useSearchParams: () => new URLSearchParams(searchParamsValue),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: "ADMIN" } } }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import AccountingIntegrityPage from "./page";

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function createIntegrityPayload() {
  return {
    draftEntries: 0,
    arLedger: 400,
    customerBalances: 400,
    arDifference: 0,
    inventoryLedger: 100,
    inventoryValuation: 3300,
    inventoryDifference: -3200,
    inventoryPurchaseBacked: 1220,
    inventoryGlOnly: -1120,
    negativeStockCount: 0,
    apLedger: 2140,
    apOperational: 1220,
    apDifference: 920,
    apOperationalBacked: 1220,
    apGlOnly: 920,
    trialBalance: 0,
    glRevenue: 1200,
    revenueOperational: 0,
    revenueDifference: 1200,
    revenueOrderBacked: 0,
    revenueGlOnly: 1200,
    glCogs: 2120,
    cogsOperational: 0,
    cogsDifference: 2120,
    cogsOrderBacked: 0,
    cogsGlOnly: 2120,
    glVat: 60,
    vatOperational: 0,
    vatDifference: 60,
    vatOrderBacked: 0,
    vatGlOnly: 60,
    glStoreCredit: 0,
    storeCreditOperational: 0,
    storeCreditDifference: 0,
    glCash: 50,
    glBank: 75,
    draftAging: { fresh: 0, warning: 0, old: 0, critical: 0 },
    draftEntriesSample: [],
    duplicatePayments: { count: 0, items: [] },
    customerOverpayments: { count: 0, items: [] },
    orderBalanceIssues: { count: 0, items: [] },
    supplierOverpayments: { count: 0, items: [] },
    missingPostings: {
      orders: 0,
      payments: 0,
      expenses: 0,
      purchases: 0,
      supplierPayments: 0,
      creditPayouts: 0,
      settlements: 0,
    },
    missingPostingItems: {
      orders: [],
      payments: [],
      expenses: [],
      purchases: [],
      supplierPayments: [],
      creditPayouts: [],
      settlements: [],
    },
    recentPostFailures: [],
  };
}

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/api/admin/settings/app") {
      const key = url.searchParams.get("key");
      if (key === "accounting.integrity.thresholds") {
        return jsonResponse({
          value: {
            arDifference: 0.01,
            inventoryDifference: 0.01,
            apDifference: 0.01,
            trialBalance: 0.01,
            revenueDifference: 0.01,
            vatDifference: 0.01,
            cogsDifference: 0.01,
            storeCreditDifference: 0.01,
            draftEntries: true,
            negativeStock: true,
          },
        });
      }
      if (key === "accounting.integrity.acknowledgements") return jsonResponse({ value: [] });
      if (key === "accounting.integrity.lastSync") return jsonResponse({ value: null });
    }

    if (url.pathname === "/api/admin/accounting/integrity") {
      return jsonResponse(createIntegrityPayload());
    }

    if (url.pathname === "/api/admin/accounting/integrity/drilldown") {
      return jsonResponse({
        key: "ap",
        label: "AP (Payables)",
        code: "2000",
        asOf: "2026-04-01",
        difference: 920,
        methodology: [
          "GL side includes every posted journal line on account 2000.",
          "Operational side includes received purchases and supplier payments.",
        ],
        alerts: [
          { tone: "warning", message: "1 GL-only AP journal row(s) totaling 920.00 are included in the GL balance." },
        ],
        ledger: {
          code: "2000",
          name: "Accounts Payable",
          total: 2140,
          rows: [
            {
              id: "jl-1",
              entryId: "je-1",
              date: "2026-03-08T00:00:00.000Z",
              sourceType: "PURCHASE",
              sourceId: null,
              memo: "Inventory restock",
              description: "Supplier payable",
              debit: 0,
              credit: 920,
              amount: 920,
              traceStatus: "gl_only",
              traceCategory: "GL-only AP journal",
              traceNote: "No linked received purchase or supplier payment source.",
            },
          ],
        },
        operational: {
          label: "Received AP contributors",
          total: 1220,
          rows: [
            {
              id: "purchase-1",
              date: "2026-03-12T00:00:00.000Z",
              type: "Received purchase",
              reference: "Wheelchair (WHE-001)",
              detail: "MedEquip Co.",
              amount: 400,
            },
          ],
        },
      });
    }

    throw new Error(`Unhandled fetch in integrity page test: ${url.pathname}${url.search}`);
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
      <AccountingIntegrityPage />
    </QueryClientProvider>,
  );
}

describe("AccountingIntegrityPage", () => {
  beforeEach(() => {
    mockReplace.mockReset();
    searchParamsValue = "asOf=2026-04-01";
    vi.stubGlobal("fetch", createFetchMock());
  });

  it("keeps reconciliation visible in problems-only mode and filters to warning rows", async () => {
    renderPage();

    await screen.findByText("GL vs Operational reconciliation");
    expect(screen.getByText("AR (Receivables)")).toBeInTheDocument();
    expect(screen.getByText("Inventory")).toBeInTheDocument();
    expect(screen.getByText("AP (Payables)")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/show problems only/i));

    await waitFor(() => {
      expect(screen.getByText("GL vs Operational reconciliation")).toBeInTheDocument();
      expect(screen.queryByText("AR (Receivables)")).not.toBeInTheDocument();
      expect(screen.getByText("Inventory")).toBeInTheDocument();
      expect(screen.getByText("AP (Payables)")).toBeInTheDocument();
    });
  });

  it("opens a snapshot trace dialog from the reconciliation table", async () => {
    renderPage();

    const apCell = await screen.findByText("AP (Payables)");
    const apRow = apCell.closest("tr");
    expect(apRow).not.toBeNull();

    fireEvent.click(within(apRow as HTMLElement).getByRole("button", { name: /trace snapshot/i }));

    await screen.findByText(/ap \(payables\) snapshot trace/i);
    expect(await screen.findByText(/included in the GL balance/i)).toBeInTheDocument();
    expect(screen.getByText("Received AP contributors")).toBeInTheDocument();
    expect(screen.getByText("Supplier payable")).toBeInTheDocument();
  });

  it("links to the audit log filtered to integrity-page actions", async () => {
    renderPage();

    const link = await screen.findByRole("link", { name: /view audit trail/i });
    expect(link).toHaveAttribute("href", "/admin/audit?sourcePage=admin%2Faccounting%2Fintegrity");
  });
});
