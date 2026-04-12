// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession, mockRouterPush, mockToastError, navState } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockRouterPush: vi.fn(),
  mockToastError: vi.fn(),
  navState: { searchParams: "" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
  useSearchParams: () => new URLSearchParams(navState.searchParams),
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
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import AdminB2BProcurementPage from "./page";

function makeRequest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "IN_REVIEW",
    clinicName: "Old Clinic",
    contactName: "Kofi Mensah",
    contactPhone: "+233501234567",
    contactEmail: "kofi@clinic.gh",
    notes: null,
    poDocumentUrl: null,
    templateId: null,
    itemsText: "Gloves x 20",
    accountManagerId: null,
    createdAt: "2026-04-10T08:00:00.000Z",
    updatedAt: "2026-04-10T09:00:00.000Z",
    customer: { id: "cust-1", name: "Old Clinic Buyer", email: "buyer@clinic.gh", role: "CUSTOMER" },
    accountManager: null,
    isArchived: false,
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

function createFetchMock(options?: { requestsOk?: boolean }) {
  const requestsOk = options?.requestsOk ?? true;

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(normalizeRequestUrl(input), "http://localhost");

    if (url.pathname === "/api/admin/b2b/procurement/requests") {
      if (!requestsOk) return jsonResponse({ error: "Database unavailable" }, false, 500);
      const items = [makeRequest("req-highlight")];
      return jsonResponse({
        items,
        total: items.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
        archiveAfterDays: 30,
        clinicOptions: ["Old Clinic"],
        managerOptions: [],
      });
    }

    if (url.pathname === "/api/admin/customers") {
      return jsonResponse({
        rows: [
          { user: { id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" } },
        ],
      });
    }

    throw new Error(`Unhandled fetch in procurement page test: ${url.pathname}${url.search}`);
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <AdminB2BProcurementPage />
    </QueryClientProvider>,
  );
}

describe("AdminB2BProcurementPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navState.searchParams = "";
    mockUseSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "ADMIN", email: "admin@nora.gh" } },
      status: "authenticated",
    });
    vi.stubGlobal("fetch", createFetchMock());
  });

  it("hydrates URL search and highlight parameters into the workflow query", async () => {
    navState.searchParams = "search=Old%20Clinic&highlight=req-highlight";

    renderPage();

    expect(await screen.findByDisplayValue("Old Clinic")).toBeInTheDocument();
    expect(await screen.findByText("Old Clinic")).toBeInTheDocument();

    await waitFor(() => {
      const matchingCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => {
        const url = new URL(normalizeRequestUrl(input), "http://localhost");
        return url.pathname === "/api/admin/b2b/procurement/requests" && url.searchParams.get("q") === "Old Clinic";
      });
      expect(matchingCall).toBeDefined();
    });
  });

  it("requires an explicit new status instead of logging a no-op update", async () => {
    renderPage();

    await screen.findByText("Old Clinic");
    fireEvent.click(screen.getByRole("button", { name: "Update Status" }));

    expect(mockToastError).toHaveBeenCalledWith("Choose a new status before updating.");
  });

  it("shows a real request error instead of an empty queue when loading fails", async () => {
    vi.stubGlobal("fetch", createFetchMock({ requestsOk: false }));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load procurement requests");
    expect(screen.queryByText("No procurement requests found.")).not.toBeInTheDocument();
  });
});
