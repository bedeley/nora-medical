// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockReplace,
  mockToastError,
  mockToastInfo,
  mockToastSuccess,
  mockUseSession,
  state,
} = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockUseSession: vi.fn(),
  state: {
    searchParamsValue: "",
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/admin/inventory-lots",
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
    info: mockToastInfo,
    success: mockToastSuccess,
  },
}));

vi.mock("@/lib/admin-export-audit-client", () => ({
  logAdminExportDownload: vi.fn(),
}));

import InventoryLotsPage from "./page";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function makeListPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    items: [
      {
        id: "lot-1",
        productId: "prod-1",
        productName: "Amoxicillin",
        productSku: "AMX-10",
        supplierId: "sup-1",
        supplierName: "Med Supply",
        lotCode: "LOT-1",
        expiryDate: "2027-01-01T00:00:00.000Z",
        receivedAt: "2026-04-01T09:00:00.000Z",
        quantityReceived: 100,
        quantityRemaining: 45,
        notes: "Primary batch",
      },
    ],
    totalItems: 120,
    page: 1,
    pageSize: 50,
    sortBy: "expiryDate",
    sortDir: "asc",
    summary: {
      totalLots: 120,
      totalRemaining: 400,
      expiredLots: 2,
      expiringHigh: 4,
      expiringMedium: 7,
    },
    fefoThresholds: { highDays: 30, mediumDays: 60 },
    compliance: {
      regulatedCount: 10,
      missingExpiryLots: 1,
      missingLotMovements: 2,
      missingLotCoverage: 1,
      missingExpirySamples: [],
      missingMovementSamples: [],
      missingCoverageSamples: [],
    },
    ...overrides,
  };
}

function makeTracePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    movementTotal: 250,
    movementsTruncated: true,
    lot: {
      id: "lot-1",
      lotCode: "LOT-1",
      expiryDate: "2027-01-01T00:00:00.000Z",
      receivedAt: "2026-04-01T09:00:00.000Z",
      quantityReceived: 100,
      quantityRemaining: 45,
      notes: "Primary batch",
      supplier: { id: "sup-1", name: "Med Supply" },
      product: {
        id: "prod-1",
        name: "Amoxicillin",
        sku: "AMX-10",
        requiresLotTracking: true,
        requiresExpiryDate: true,
      },
      purchase: null,
    },
    movements: [
      {
        id: "mov-1",
        reason: "PURCHASE",
        reasonCode: "PURCHASE",
        delta: 100,
        note: "Received",
        purchaseId: "pur-1",
        createdAt: "2026-04-01T09:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createFetchMock(options?: {
  listOk?: boolean;
  listPayload?: Record<string, unknown>;
  tracePayload?: Record<string, unknown>;
}) {
  const listPayload = options?.listPayload ?? makeListPayload();
  const tracePayload = options?.tracePayload ?? makeTracePayload();
  const listOk = options?.listOk ?? true;

  return vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/api/admin/inventory/lots" && url.searchParams.get("format") === "product_search") {
      return jsonResponse({
        products: [
          { id: "prod-1", name: "Amoxicillin", sku: "AMX-10" },
          { id: "prod-2", name: "Syringe", sku: "SYR-1" },
        ],
      });
    }

    if (url.pathname === "/api/admin/inventory/lots") {
      if (!listOk) {
        return jsonResponse({ error: "Failed to load lots" }, false, 500);
      }
      return jsonResponse(listPayload);
    }

    if (url.pathname === "/api/admin/inventory/lots/lot-1") {
      return jsonResponse(tracePayload);
    }

    throw new Error(`Unhandled fetch in inventory lots page test: ${url.pathname}${url.search}`);
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
      <InventoryLotsPage />
    </QueryClientProvider>,
  );
}

describe("InventoryLotsPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "";
    mockUseSession.mockReturnValue({
      data: { user: { role: "ADMIN" } },
      status: "authenticated",
    });
    mockReplace.mockReset();
    mockReplace.mockImplementation((nextUrl: string) => {
      const [, nextQuery = ""] = nextUrl.split("?");
      state.searchParamsValue = nextQuery;
    });
    mockToastError.mockReset();
    mockToastInfo.mockReset();
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
  });

  it("opens lot trace from the focus param and shows truncation guidance", async () => {
    state.searchParamsValue =
      "focus=lot-1&productId=prod-1&productLabel=Amoxicillin%20%28AMX-10%29&page=2&sortBy=quantityRemaining&sortDir=desc";

    renderPage();

    expect(await screen.findByDisplayValue("Amoxicillin (AMX-10)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open lot audit", hidden: true })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Finventory-lots",
    );

    const dialog = await screen.findByRole("dialog", { name: "Lot trace" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/Only the first 200 are shown/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Export CSV \(first 200 of 250\)/i }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/admin/inventory/lots?productId=prod-1&sortBy=quantityRemaining&sortDir=desc&page=2&pageSize=50",
        ),
      ),
    );
  });

  it("supports keyboard product selection and syncs sort and page changes into the URL", async () => {
    renderPage();

    const productInput = screen.getByRole("combobox", { name: "Product" });
    fireEvent.change(productInput, { target: { value: "Amox" } });

    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Amoxicillin/i })).toBeInTheDocument(),
    );

    fireEvent.keyDown(productInput, { key: "Enter" });

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/admin/inventory-lots?productId=prod-1&productLabel=Amoxicillin+%28AMX-10%29",
        { scroll: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sort by Product" }));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/admin/inventory-lots?productId=prod-1&productLabel=Amoxicillin+%28AMX-10%29&sortBy=productName",
        { scroll: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/admin/inventory-lots?productId=prod-1&productLabel=Amoxicillin+%28AMX-10%29&sortBy=productName&page=2",
        { scroll: false },
      ),
    );
  });

  it("replaces summary, list, and compliance with a retryable error state when the list fetch fails", async () => {
    vi.stubGlobal("fetch", createFetchMock({ listOk: false }));

    renderPage();

    expect(await screen.findByText("Inventory Lots Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Compliance report")).not.toBeInTheDocument();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls));
  });
});
