// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    searchParamsValue: "bankAccountId=bank-1",
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.searchParamsValue),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import AllBankTransactionsPage from "./page";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
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
          currency: "GHS",
          isActive: true,
        },
      ]);
    }

    if (url.pathname === "/api/admin/accounting/banks/all-transactions") {
      if (!transactionsOk) {
        return jsonResponse({ error: "Failed to load transactions." }, false, 500);
      }
      return jsonResponse({
        total: 1,
        page: 1,
        pageSize: 50,
        rows: [
          {
            id: "txn-1",
            postedAt: "2026-04-01T00:00:00.000Z",
            amount: 250,
            type: "CREDIT",
            description: "Wire transfer",
            reference: "WIRE-001",
            matched: false,
            bankAccountId: "bank-1",
            bankAccount: {
              id: "bank-1",
              name: "Main Operating",
              bankName: "Nora Bank",
              currency: "GHS",
              isActive: true,
            },
          },
        ],
      });
    }

    throw new Error(`Unhandled fetch in all-transactions test: ${url.pathname}${url.search}`);
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
      <AllBankTransactionsPage />
    </QueryClientProvider>,
  );
}

describe("AllBankTransactionsPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "bankAccountId=bank-1";
    vi.stubGlobal("fetch", createFetchMock());
  });

  it("loads with the bank context from the query string and links back to the scoped bank page", async () => {
    renderPage();

    expect(await screen.findByText("Scoped from bank context:")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to bank-scoped page" })).toHaveAttribute(
      "href",
      "/admin/accounting/banks?bankId=bank-1",
    );

    await waitFor(() => {
      const matchingCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => {
        const url = new URL(normalizeRequestUrl(input), "http://localhost");
        return (
          url.pathname === "/api/admin/accounting/banks/all-transactions" &&
          url.searchParams.get("bankAccountId") === "bank-1"
        );
      });
      expect(matchingCall).toBeTruthy();
    });
  });

  it("shows a query error state instead of an empty list when transactions fail", async () => {
    vi.stubGlobal("fetch", createFetchMock({ transactionsOk: false }));

    renderPage();

    expect(await screen.findByText("Failed to load transactions.")).toBeInTheDocument();
    expect(screen.queryByText("No transactions found.")).not.toBeInTheDocument();
  });
});
