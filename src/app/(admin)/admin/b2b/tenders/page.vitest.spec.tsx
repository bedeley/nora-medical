// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession, mockToastError } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import AdminB2BTendersPage from "./page";

function makeTender(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenderNumber: `TND-2026-${id}`,
    status: "DRAFT",
    buyerName: `Clinic ${id}`,
    buyerContact: "Buyer Contact",
    buyerEmail: `buyer-${id}@clinic.gh`,
    tenderRef: null,
    lotTitle: "LOT 1",
    currency: "GHS",
    validityDays: 14,
    notes: null,
    vatRatePct: 0,
    vatAmount: 0,
    discountAmount: 0,
    freightAmount: 0,
    handlingAmount: 0,
    leadTimeDays: null,
    paymentTerms: null,
    marginThresholdPct: 0,
    itemsText: "Paracetamol 500mg: 10",
    subtotal: 30,
    total: 30,
    lines: [],
    updatedAt: "2026-04-12T10:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

function normalizeRequestUrl(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

const tenders = [
  makeTender("draft", { status: "DRAFT", buyerName: "Draft Clinic" }),
  makeTender("submitted", { status: "SUBMITTED", buyerName: "Submitted Clinic", buyerEmail: "procurement@submitted.gh" }),
  makeTender("sent", { status: "SENT", buyerName: "Sent Clinic" }),
  makeTender("won", { status: "WON", buyerName: "Won Clinic" }),
];

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(normalizeRequestUrl(input), "http://localhost");

    if (url.pathname === "/api/admin/b2b/tenders") {
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();
      const status = (url.searchParams.get("status") || "").trim();
      const filtered = tenders.filter((row) => {
        const hay = `${row.tenderNumber} ${row.buyerName} ${row.tenderRef || ""}`.toLowerCase();
        return (!search || hay.includes(search)) && (!status || row.status === status);
      });
      return jsonResponse({
        items: filtered,
        totalCount: filtered.length,
        page: Number(url.searchParams.get("page") || 1),
        pageSize: Number(url.searchParams.get("pageSize") || 20),
        totalPages: 1,
      });
    }

    if (url.pathname === "/api/admin/b2b/procurement/requests") {
      return jsonResponse({ items: [] });
    }

    if (url.pathname === "/api/products") {
      return jsonResponse({ items: [] });
    }

    if (url.pathname === "/api/admin/b2b/tender-templates") {
      return jsonResponse({ items: [] });
    }

    if (url.pathname === "/api/admin/b2b/tenders/reminders") {
      return jsonResponse({ items: [] });
    }

    if (url.pathname === "/api/admin/b2b/tenders/order-links") {
      return jsonResponse({ items: [] });
    }

    if (url.pathname.endsWith("/versions")) {
      return jsonResponse({ items: [{ id: "v1", versionNo: 1, status: "SUBMITTED", changeNote: null, createdAt: "2026-04-12T10:00:00.000Z" }] });
    }

    if (url.pathname.endsWith("/approval-status")) {
      return jsonResponse({
        requireApproval: false,
        makerChecker: false,
        latestVersionNo: 1,
        approvedVersionNo: 1,
        approvedAt: null,
        approvedByName: null,
        canSend: true,
        reason: "Approval gate disabled.",
      });
    }

    throw new Error(`Unhandled fetch in tenders page test: ${url.pathname}${url.search}`);
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
      <AdminB2BTendersPage />
    </QueryClientProvider>,
  );
}

describe("AdminB2BTendersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      data: { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh" } },
      status: "authenticated",
    });
    vi.stubGlobal("fetch", createFetchMock());
    vi.stubGlobal("open", vi.fn());
  });

  it("renders accessible workflow tabs", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Tender Builder" })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Tender workflow" });
    expect(within(tabs).getByRole("tab", { name: "Build Tender" })).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: /Send & Versions/i })).toHaveAttribute("aria-selected", "false");
  });

  it("uses server-backed search and status filters", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Tenders/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by tender/i), { target: { value: "submitted" } });
    fireEvent.change(screen.getByDisplayValue("All statuses"), { target: { value: "SUBMITTED" } });

    await waitFor(() => {
      const matchingCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => {
        const url = new URL(normalizeRequestUrl(input), "http://localhost");
        return (
          url.pathname === "/api/admin/b2b/tenders" &&
          url.searchParams.get("search") === "submitted" &&
          url.searchParams.get("status") === "SUBMITTED" &&
          url.searchParams.get("pageSize") === "20"
        );
      });
      expect(matchingCall).toBeDefined();
    });
  });

  it("shows only send-eligible tenders in the send selector and pre-fills recipient email", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Send & Versions/i }));
    const tenderSelect = screen.getByDisplayValue("— select a tender —") as HTMLSelectElement;
    expect(within(tenderSelect).queryByText(/Draft Clinic/)).toBeNull();
    expect(within(tenderSelect).queryByText(/Won Clinic/)).toBeNull();

    fireEvent.change(tenderSelect, { target: { value: "submitted" } });

    await waitFor(() => {
      expect(screen.getByDisplayValue("procurement@submitted.gh")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send Tender" })).not.toBeDisabled();
    });
  });

  it("disables history Send action for draft and terminal tenders", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /Tenders/i }));

    await waitFor(() => expect(screen.getByText(/Draft Clinic/)).toBeInTheDocument());
    const rows = screen.getAllByText(/Clinic/).map((node) => node.closest(".rounded.border")).filter(Boolean);
    const draftRow = rows.find((row) => row?.textContent?.includes("Draft Clinic"));
    const submittedRow = rows.find((row) => row?.textContent?.includes("Submitted Clinic"));

    expect(within(draftRow as HTMLElement).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(submittedRow as HTMLElement).getByRole("button", { name: "Send" })).not.toBeDisabled();
  });
});
