// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  state,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  state: {
    searchParamsValue: "",
    sessionRole: "ADMIN",
  },
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
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

vi.mock("@/lib/currency", () => ({
  formatCurrency: (value: number) => `GHS ${Number(value).toFixed(2)}`,
}));

import SupplierPaymentsPage from "./page";

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: "application/octet-stream" }),
  };
}

function createPayload() {
  return {
    rows: [
      {
        id: "purchase-1",
        createdAt: "2026-04-09T10:00:00.000Z",
        expectedAt: "2026-04-15T00:00:00.000Z",
        status: "RECEIVED",
        supplier: "Acme Med",
        supplierId: "sup-1",
        product: { id: "prod-1", name: "Sterile Gauze", sku: "GAUZE-01" },
        quantity: 10,
        unitCost: 5,
        total: 50,
        paidAmount: 0,
        creditAmount: 0,
        refundAmount: 0,
        pendingAmount: 0,
        outstanding: 50,
        paymentStatus: "UNPAID",
      },
    ],
    scopeRows: [
      {
        id: "purchase-1",
        createdAt: "2026-04-09T10:00:00.000Z",
        expectedAt: "2026-04-15T00:00:00.000Z",
        status: "RECEIVED",
        supplier: "Acme Med",
        supplierId: "sup-1",
        product: { id: "prod-1", name: "Sterile Gauze", sku: "GAUZE-01" },
        quantity: 10,
        unitCost: 5,
        total: 50,
        paidAmount: 0,
        creditAmount: 0,
        refundAmount: 0,
        pendingAmount: 0,
        outstanding: 50,
        paymentStatus: "UNPAID",
      },
    ],
    total: 1,
    totalAmount: 50,
    totalPaid: 0,
    totalPending: 0,
    totalPendingPaymentApprovals: 0,
    totalPendingPurchaseApprovals: 0,
    totalCredits: 10,
    totalRefunds: 0,
    totalCreditBalance: 10,
    totalOutstanding: 50,
    page: 1,
    pageSize: 25,
    pendingPayments: [
      {
        id: "payment-1",
        amount: 25,
        method: "bank",
        reference: "REF-1",
        proofUrl: "",
        note: "Awaiting approval",
        createdAt: "2026-04-09T12:00:00.000Z",
        supplier: { id: "sup-1", name: "Acme Med" },
        purchase: { id: "purchase-1", product: { name: "Sterile Gauze", sku: "GAUZE-01" } },
      },
    ],
    pendingPurchaseApprovals: [],
  };
}

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl, "http://localhost");

    if (url.pathname === "/api/admin/supplier-payments" && (!init || init.method === undefined)) {
      return jsonResponse(createPayload());
    }

    if (url.pathname === "/api/admin/suppliers") {
      return jsonResponse({
        rows: [{ id: "sup-1", name: "Acme Med" }],
      });
    }

    if (url.pathname === "/api/admin/supplier-payments" && init?.method === "POST") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unhandled fetch in supplier-payments page test: ${url.pathname}${url.search}`);
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
      <SupplierPaymentsPage />
    </QueryClientProvider>,
  );
}

describe("SupplierPaymentsPage", () => {
  beforeEach(() => {
    state.searchParamsValue = "supplierId=sup-1&paymentId=payment-1";
    state.sessionRole = "ADMIN";
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

  it("renders audit links and focused approval audit actions for admins", async () => {
    renderPage();

    expect(await screen.findByRole("link", { name: "Open audit log" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Fsupplier-payments",
    );
    expect(await screen.findByRole("button", { name: "Pay supplier balance" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Record refund" })).toBeInTheDocument();
    const auditLinks = await screen.findAllByRole("link", { name: "Audit" });
    expect(
      auditLinks.some(
        (link) =>
          link.getAttribute("href") ===
          "/admin/audit?entityType=SUPPLIER_PAYMENT&entityId=payment-1&sourcePage=admin%2Fsupplier-payments",
      ),
    ).toBe(true);
  });

  it("submits bulk payment scope with purchaseIds and sourcePage", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Pay supplier balance" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Pay supplier balance");
    fireEvent.click(screen.getByRole("button", { name: "Submit payment" }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === "/api/admin/supplier-payments" && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(String(postCall?.[1]?.body || "{}"));
      expect(body.sourcePage).toBe("admin/supplier-payments");
      expect(body.purchaseIds).toEqual(["purchase-1"]);
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Bulk supplier payment recorded.");
  });

  it("hides privileged supplier-payment actions from non-admin roles", async () => {
    state.sessionRole = "ACCOUNTANT";
    renderPage();

    expect(await screen.findByRole("link", { name: "Open audit log" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay supplier balance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record refund" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Full bundle — ZIP" })).not.toBeInTheDocument();
    });
  });
});
