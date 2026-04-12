// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, mockToastError, mockToastInfo, mockToastSuccess } = vi.hoisted(() => ({
  state: {
    searchParamsValue: "",
  },
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.searchParamsValue),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    info: mockToastInfo,
    success: mockToastSuccess,
  },
}));

import StockAdjustmentsPage from "./page";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function createFetchMock() {
  let currentStock = 12;

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/api/products" && url.searchParams.get("ids") === "prod-1") {
      return jsonResponse({
        items: [
          {
            id: "prod-1",
            name: "Sterile Gauze",
            sku: "GAUZE-01",
            stock: currentStock,
            cost: 4.5,
            requiresLotTracking: false,
            requiresExpiryDate: false,
          },
        ],
      });
    }

    if (url.pathname === "/api/products") {
      return jsonResponse({
        items: [
          {
            id: "prod-1",
            name: "Sterile Gauze",
            sku: "GAUZE-01",
            stock: currentStock,
            cost: 4.5,
            requiresLotTracking: false,
            requiresExpiryDate: false,
          },
        ],
      });
    }

    if (url.pathname === "/api/admin/stock-adjustments" && (!init || init.method === undefined)) {
      return jsonResponse({
        items: [
          {
            id: "adj-1",
            productId: "prod-1",
            productName: "Sterile Gauze",
            productSku: "GAUZE-01",
            delta: -2,
            reason: "CYCLE_COUNT",
            reasonCode: "COUNT_VARIANCE",
            note: "Cycle count adjustment",
            lotCode: null,
            expiryDate: null,
            unitCost: 4.5,
            valueDelta: -9,
            createdAt: "2026-04-09T10:00:00.000Z",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      });
    }

    if (url.pathname === "/api/admin/stock-adjustments" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body || "{}"));
      currentStock = Number(payload.countedStock ?? currentStock);
      return jsonResponse({ ok: true, delta: 3, valueDelta: 13.5 });
    }

    if (url.pathname === "/api/admin/stock-adjustments/export-log" && init?.method === "POST") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unhandled fetch in stock-adjustments page test: ${url.pathname}${url.search}`);
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
      <StockAdjustmentsPage />
    </QueryClientProvider>,
  );
}

describe("StockAdjustmentsPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "productId=prod-1";
    mockToastError.mockReset();
    mockToastInfo.mockReset();
    mockToastSuccess.mockReset();
    vi.stubGlobal("fetch", createFetchMock());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:stock-adjustments");
        static revokeObjectURL = vi.fn();
      },
    );
    HTMLAnchorElement.prototype.click = vi.fn();
    window.localStorage.clear();
  });

  it("renders page and product audit links for the selected product", async () => {
    renderPage();

    expect(await screen.findByRole("link", { name: "Open adjustment audit" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fstock-adjustments",
    );
    expect(await screen.findByRole("link", { name: "Product audit" })).toHaveAttribute(
      "href",
      "/admin/audit?entityType=PRODUCT&entityId=prod-1&sourcePage=admin%2Fstock-adjustments",
    );
    expect(screen.getByText(/current stock:/i)).toHaveTextContent("12");
  });

  it("updates the selected product stock after a confirmed adjustment", async () => {
    renderPage();

    expect(await screen.findByRole("link", { name: "Product audit" })).toBeInTheDocument();
    const countedStock = await screen.findByLabelText(/counted stock/i);
    fireEvent.change(countedStock, { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText(/reason code/i), { target: { value: "COUNT_VARIANCE" } });
    fireEvent.change(screen.getByLabelText(/^note/i), { target: { value: "Shelf recount" } });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("Confirm stock adjustment");
    fireEvent.click(screen.getByRole("button", { name: "Confirm adjustment" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/current stock:/i)).toHaveTextContent("15");
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Stock adjustment saved.");
  });
});
