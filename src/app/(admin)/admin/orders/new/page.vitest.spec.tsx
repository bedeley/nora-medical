// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPush,
  mockToastError,
  mockToastSuccess,
  state,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  state: {
    searchParamsValue: "",
    sessionRole: "ADMIN",
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(state.searchParamsValue),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { role: state.sessionRole } },
    status: "authenticated",
  }),
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
    success: mockToastSuccess,
  },
}));

import NewAdminOrderPage from "./page";

function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => payload,
  };
}

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/api/admin/customers") {
      return jsonResponse({
        rows: [
          {
            user: {
              id: "customer-1",
              name: "Alice Clinic",
              email: "alice@example.com",
              phone: "0240000000",
            },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    }

    if (url.pathname === "/api/products") {
      return jsonResponse({
        items: [
          {
            id: "prod-1",
            sku: "SKU-1",
            name: "Sterile Gloves",
            price: 12.5,
            stock: 25,
            sellableStock: 25,
            archived: false,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 100,
      });
    }

    throw new Error(
      `Unhandled fetch in new admin order page test: ${url.pathname}${url.search}`,
    );
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
      <NewAdminOrderPage />
    </QueryClientProvider>,
  );
}

describe("NewAdminOrderPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "";
    state.sessionRole = "ADMIN";
    mockPush.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();

    vi.stubGlobal("fetch", createFetchMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
  });

  it("restores a saved draft and rehydrates the selected customer summary", async () => {
    window.localStorage.setItem(
      "admin-order-new-draft.v2",
      JSON.stringify({
        ts: Date.now(),
        userId: "customer-1",
        items: [],
        partialDeliveredByItem: {},
        initialPayment: "",
        initialPaymentMethod: "",
        initialPaymentReference: "",
        showUpfrontPayment: false,
        taxRate: "",
        discountAmount: "",
        discountReason: "",
        deliveryStatus: "NOT_SET",
        orderNote: "",
        importContext: null,
        importReviewLines: [],
        pendingImportMatchId: null,
      }),
    );

    renderPage();

    expect(await screen.findByText("Saved draft available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore Draft" }));

    expect(await screen.findByRole("button", { name: "Clear Customer" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByText("Saved draft available"),
      ).not.toBeInTheDocument(),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Saved draft restored.");
  });

  it("shows validation errors when the order is submitted without a customer or items", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Create Order" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Order" }));

    expect(await screen.findByText("Select a customer.")).toBeInTheDocument();
    expect(screen.getByText("Add at least one item.")).toBeInTheDocument();
    expect(
      screen.getByText(/Last validation check:/i),
    ).toBeInTheDocument();
  });
});
