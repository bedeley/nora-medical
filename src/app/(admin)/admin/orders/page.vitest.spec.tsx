// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPush,
  mockReplace,
  mockToastError,
  mockToastSuccess,
  mockLogAdminExportDownload,
  state,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockLogAdminExportDownload: vi.fn(),
  state: {
    searchParamsValue: "",
    sessionRole: "ADMIN",
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => "/admin/orders",
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

vi.mock("@/lib/admin-export-audit-client", () => ({
  logAdminExportDownload: (...args: unknown[]) =>
    mockLogAdminExportDownload(...args),
}));

import AdminOrdersPage from "./page";

function jsonTextResponse(payload: unknown, ok = true, status = 200) {
  const text = JSON.stringify(payload);
  return {
    ok,
    status,
    text: async () => text,
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

    if (url.pathname === "/api/orders") {
      return jsonTextResponse({
        items: [
          {
            id: "order-1",
            status: "UNPAID",
            deliveryStatus: "NOT_DELIVERED",
            createdAt: "2026-04-09T10:00:00.000Z",
            updatedAt: "2026-04-09T11:00:00.000Z",
            invoiceNumber: "INV-1001",
            subtotal: 120,
            taxAmount: 18,
            discountAmount: 0,
            total: 138,
            amountPaid: 25,
            balance: 113,
            userId: "customer-1",
            customerType: "REGISTERED",
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
        pageSize: 25,
        totals: {
          total: 138,
          paid: 25,
          balance: 113,
        },
      });
    }

    if (
      url.pathname === "/api/admin/preferences" &&
      url.searchParams.get("key") === "orders.savedFilters"
    ) {
      return jsonTextResponse({ value: [] });
    }

    throw new Error(
      `Unhandled fetch in admin orders page test: ${url.pathname}${url.search}`,
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
      <AdminOrdersPage />
    </QueryClientProvider>,
  );
}

describe("AdminOrdersPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "";
    state.sessionRole = "ADMIN";
    mockPush.mockReset();
    mockReplace.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    mockLogAdminExportDownload.mockReset();

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
    window.history.replaceState({}, "", "/admin/orders");
  });

  it("renders the orders list and uses the page-specific audit and copy actions", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    renderPage();

    expect(await screen.findByRole("link", { name: "Orders Audit" })).toHaveAttribute(
      "href",
      "/admin/audit?entityType=ORDER&sourcePage=admin/orders",
    );
    expect(await screen.findByRole("button", { name: "Copy Link" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Audit" })[0]).toHaveAttribute(
      "href",
      "/admin/audit?entityType=ORDER&entityId=order-1&sourcePage=admin/orders",
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Copy Link" })[0]);

    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(
        expect.stringMatching(/\/admin\/orders\/order-1$/),
      ),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Link copied");
  });

  it("shows a fallback toast when clipboard access fails", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("Denied")),
      },
    });

    renderPage();

    expect(await screen.findByRole("button", { name: "Copy Link" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Copy Link" })[0]);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Unable to copy the order link.",
      ),
    );
  });

  it("hides order audit links for non-admin users", async () => {
    state.sessionRole = "STAFF";

    renderPage();

    expect(await screen.findByRole("button", { name: "Copy Link" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Orders Audit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
  });
});
