// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    sessionRole: "ADMIN",
    order: {
      id: "order-1",
      status: "PARTIALLY_PAID",
      subtotal: 120,
      taxRate: 15,
      taxAmount: 18,
      customerType: "REGISTERED",
      walkInName: null,
      walkInPhone: null,
      deliveryStatus: "PARTIALLY_DELIVERED",
      deliveredAt: null,
      total: 138,
      amountPaid: 88,
      balance: 50,
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T11:00:00.000Z",
      adminNote: "Call before dispatch",
      user: {
        id: "customer-1",
        name: "Alice Clinic",
        email: "alice@example.com",
      },
      items: [
        {
          id: "item-1",
          quantity: 4,
          price: 30,
          deliveredQuantity: 2,
          returnedQuantity: 0,
          product: {
            id: "prod-1",
            name: "Sterile Gloves",
            imageUrl: null,
          },
        },
      ],
      payments: [],
      returnCredits: [],
      deliveryProof: null,
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
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

vi.mock("next/image", () => ({
  default: ({
    alt,
    ...rest
  }: {
    alt: string;
    [key: string]: unknown;
  }) => <div aria-label={alt} role="img" {...rest} />,
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

vi.mock("@/hooks/use-client-query", () => ({
  useClientQuery: ({
    queryKey,
  }: {
    queryKey?: unknown[];
  }) => {
    if (Array.isArray(queryKey) && queryKey[0] === "order") {
      return {
        data: { data: state.order },
        error: null,
        isLoading: false,
      };
    }

    if (Array.isArray(queryKey) && queryKey[0] === "admin") {
      return {
        data: {
          orderId: state.order.id,
          totalPayments: 0,
          postedCount: 0,
          pendingCount: 0,
          postedPaymentIds: [],
          pendingPaymentIds: [],
        },
        error: null,
        isLoading: false,
      };
    }

    return {
      data: undefined,
      error: null,
      isLoading: false,
    };
  },
}));

import OrderDetails from "./OrderDetails";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <OrderDetails orderId="order-1" />
    </QueryClientProvider>,
  );
}

describe("OrderDetails", () => {
  beforeEach(() => {
    state.sessionRole = "ADMIN";
    mockPush.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the order detail actions and routes the audit action to the page-specific source", async () => {
    renderPage();

    expect(await screen.findByText("Alice Clinic")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audit Log" })).toHaveAttribute(
      "href",
      "/admin/audit?entityType=ORDER&entityId=order-1&sourcePage=admin%2Forders%2F%5Bid%5D",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Activity Timeline and customer signals",
      }),
    );
    expect(await screen.findByText("Activity Timeline")).toBeInTheDocument();
  });

  it("opens the payment dialog and fills the remaining balance with the pay-full action", async () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("button", { name: "Payments Receipts and ledger" }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Record Payment" })[0]);

    const dialog = await screen.findByRole("dialog", { name: "Record Payment" });
    const amountInput = within(dialog).getByPlaceholderText(
      "Enter payment amount",
    ) as HTMLInputElement;

    expect(amountInput.value).toBe("");
    fireEvent.click(within(dialog).getByRole("tab", { name: /Pay Full/i }));
    expect(amountInput.value).toBe("50.00");
  });

  it("hides the audit link for non-admin users", async () => {
    state.sessionRole = "STAFF";

    renderPage();

    expect(await screen.findByText("Alice Clinic")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit Log" })).not.toBeInTheDocument();
  });
});
