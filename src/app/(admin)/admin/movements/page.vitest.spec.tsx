// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockReplace,
  mockLogAdminMovementDetailView,
  mockLogAdminExportDownload,
  mockToastError,
  state,
} = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockLogAdminMovementDetailView: vi.fn(),
  mockLogAdminExportDownload: vi.fn(),
  mockToastError: vi.fn(),
  state: {
    sessionRole: "ADMIN",
    searchParamsValue: "",
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => "/admin/movements",
  useSearchParams: () => new URLSearchParams(state.searchParamsValue),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { role: state.sessionRole } } }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: vi.fn(),
  },
}));

vi.mock("@/lib/admin-movement-audit-client", () => ({
  logAdminMovementDetailView: (...args: unknown[]) => mockLogAdminMovementDetailView(...args),
}));

vi.mock("@/lib/admin-export-audit-client", () => ({
  logAdminExportDownload: (...args: unknown[]) => mockLogAdminExportDownload(...args),
}));

import AdminMovementsPage from "./page";

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

    if (url.pathname === "/api/products") {
      return jsonResponse({
        items: [
          { id: "prod-1", name: "Amoxicillin", sku: "AMX-10" },
          { id: "prod-2", name: "Syringe", sku: "SYR-1" },
        ],
        total: 2,
      });
    }

    if (url.pathname === "/api/admin/movements") {
      return jsonResponse({
        items: [
          {
            id: "mov-1",
            productId: "prod-1",
            purchaseId: "pur-1",
            productName: "Amoxicillin",
            productSku: "AMX-10",
            delta: 12,
            reason: "PURCHASE",
            note: "Batch received",
            supplier: "Med Supply",
            unitCost: 12.5,
            lotCode: "LOT-1",
            expiryDate: "2027-01-01T00:00:00.000Z",
            createdAt: "2026-04-08T10:00:00.000Z",
          },
          {
            id: "mov-2",
            productId: "prod-2",
            purchaseId: null,
            productName: "Syringe",
            productSku: "SYR-1",
            delta: -3,
            reason: "SALE",
            note: null,
            supplier: null,
            unitCost: null,
            lotCode: null,
            expiryDate: null,
            createdAt: "2026-04-08T09:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        sortBy: "createdAt",
        sortDir: "desc",
        stats: {
          totalIn: 12,
          totalOut: 3,
          net: 9,
        },
      });
    }

    throw new Error(`Unhandled fetch in movements page test: ${url.pathname}${url.search}`);
  });
}

describe("AdminMovementsPage", () => {
  beforeEach(() => {
    state.sessionRole = "ADMIN";
    state.searchParamsValue = "";
    mockReplace.mockReset();
    mockLogAdminMovementDetailView.mockReset();
    mockLogAdminExportDownload.mockReset();
    mockToastError.mockReset();
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

  it("renders movement data and shows the admin-only audit link", async () => {
    render(<AdminMovementsPage />);

    expect(screen.getByText("Inventory Movements")).toBeInTheDocument();
    expect((await screen.findAllByText("Amoxicillin")).length).toBeGreaterThan(0);
    expect(screen.getByText("+12 units")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View audit trail" })).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin/movements",
    );

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith("/admin/movements", { scroll: false }),
    );
  });

  it("opens movement details, logs the detail-view audit payload, and clears the dialog on close", async () => {
    render(<AdminMovementsPage />);

    expect((await screen.findAllByText("Amoxicillin")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: "View details" })[0]);

    const dialog = await screen.findByRole("dialog", { name: "Movement Details" });
    expect(within(dialog).getByText("Batch received")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "View source purchase" })).toHaveAttribute(
      "href",
      "/admin/purchases?purchaseId=pur-1",
    );
    expect(mockLogAdminMovementDetailView).toHaveBeenCalledWith(expect.objectContaining({
      movementId: "mov-1",
      productId: "prod-1",
      productName: "Amoxicillin",
      reason: "PURCHASE",
      delta: 12,
      totalRows: 2,
      sortBy: "createdAt",
      sortDir: "desc",
    }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Movement Details" })).not.toBeInTheDocument(),
    );
  });

  it("hides the audit link for non-admin users", async () => {
    state.sessionRole = "STAFF";

    render(<AdminMovementsPage />);

    expect((await screen.findAllByText("Amoxicillin")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "View audit trail" })).not.toBeInTheDocument();
  });
});
