// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession, state, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  state: {
    searchParamsValue: "bankId=bank-1",
  },
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.searchParamsValue),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

import BankAccountsPage from "./page";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: "application/json" }),
  };
}

function normalizeRequestUrl(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function createFetchMock(options?: { transactionsOk?: boolean }) {
  const transactionsOk = options?.transactionsOk ?? true;

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(normalizeRequestUrl(input), "http://localhost");

    if (url.pathname === "/api/admin/accounting/banks") {
      return jsonResponse([
        {
          id: "bank-1",
          name: "Main Operating",
          bankName: "Nora Bank",
          accountNumberMasked: "***1234",
          currency: "GHS",
          isActive: true,
        },
      ]);
    }

    if (url.pathname === "/api/admin/accounting/accounts") {
      return jsonResponse([
        { id: "acc-1", code: "1000", name: "Cash at Bank" },
      ]);
    }

    if (url.pathname === "/api/admin/accounting/banks/bank-1/transactions") {
      if (!transactionsOk) {
        return jsonResponse({ error: "Failed to load transactions." }, false, 500);
      }
      return jsonResponse({
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
        sortBy: "postedAt",
        sortDir: "desc",
        summary: { total: 1, matched: 0, unmatched: 1 },
        rows: [
          {
            id: "txn-1",
            postedAt: "2026-04-01T00:00:00.000Z",
            amount: 250,
            description: "Wire transfer",
            reference: "WIRE-001",
            type: "CREDIT",
            matched: false,
          },
        ],
      });
    }

    if (url.pathname === "/api/admin/accounting/banks/bank-1/rules") {
      return jsonResponse([]);
    }

    if (url.pathname === "/api/admin/accounting/banks/bank-1/import-runs") {
      return jsonResponse([]);
    }

    throw new Error(`Unhandled fetch in banks page test: ${url.pathname}${url.search}`);
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
      <BankAccountsPage />
    </QueryClientProvider>,
  );
}

describe("BankAccountsPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "bankId=bank-1";
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    vi.stubGlobal("fetch", createFetchMock());
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:test"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  it("uses the server-driven transaction query and hides admin-only delete actions for accountants", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { role: "ACCOUNTANT" } },
      status: "authenticated",
    });

    renderPage();

    expect(await screen.findByText("Working bank account")).toBeInTheDocument();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All banks transactions" })).toHaveAttribute(
      "href",
      "/admin/accounting/banks/all-transactions?bankAccountId=bank-1",
    );

    await waitFor(() => {
      const matchingCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => {
        const url = new URL(normalizeRequestUrl(input), "http://localhost");
        return (
          url.pathname === "/api/admin/accounting/banks/bank-1/transactions" &&
          url.searchParams.get("page") === "1" &&
          url.searchParams.get("pageSize") === "20" &&
          url.searchParams.get("sortBy") === "postedAt" &&
          url.searchParams.get("sortDir") === "desc"
        );
      });
      expect(matchingCall).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: "Delete selected" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByText("Delete actions require ADMIN role.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open bank audit" })).not.toBeInTheDocument();
  });

  it("renders a transaction error state instead of an empty list when the query fails", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { role: "ADMIN" } },
      status: "authenticated",
    });
    vi.stubGlobal("fetch", createFetchMock({ transactionsOk: false }));

    renderPage();

    expect(await screen.findByText("Failed to load transactions.")).toBeInTheDocument();
    expect(screen.queryByText("No transactions yet.")).not.toBeInTheDocument();
  });

  it("renders the server-backed transaction summary and table state", async () => {
    mockUseSession.mockReturnValue({
      data: { user: { role: "ADMIN" } },
      status: "authenticated",
    });

    renderPage();

    expect(await screen.findByText("Working bank account")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open bank audit" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Faccounting%2Fbanks",
    );
    await waitFor(() => {
      expect(screen.getByText("Showing transactions for:")).toBeInTheDocument();
      expect(screen.getByText("Wire transfer")).toBeInTheDocument();
    });
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.getByText("Unmatched")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export filtered CSV" })).toBeInTheDocument();
  });
});
