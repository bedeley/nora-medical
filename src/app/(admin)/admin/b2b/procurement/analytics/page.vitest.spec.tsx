// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Bar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  Cell: () => null,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: () => null,
}));

import B2BProcurementAnalyticsPage from "./page";

function makeAnalyticsResponse(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      totalRequests: 4,
      openCount: 2,
      unassignedOpenCount: 1,
      draftEligibleCount: 2,
      convertedToDraftCount: 1,
      convertedToDraftRatePct: 50,
      avgHoursToAssignment: 0.5,
      avgHoursToQuoted: null,
      avgHoursToApproved: 26,
      statusCounts: { SUBMITTED: 1, IN_REVIEW: 1, APPROVED: 2 },
      requestTypeCounts: { QUOTE: 3, PO_UPLOAD: 1 },
    },
    topRequested: [{ itemRef: "gloves", count: 5 }],
    oldestOpen: [
      {
        id: "req-old",
        status: "IN_REVIEW",
        requestType: "QUOTE",
        clinicName: "Old Clinic",
        ageDays: 8,
        hasAssignment: false,
        accountManagerId: null,
      },
    ],
    managerWorkload: [
      { managerId: "__unassigned__", managerName: "Unassigned", openCount: 1, inReviewCount: 0, quotedCount: 0 },
    ],
    trend: [{ month: "2026-04", submitted: 4, approved: 2, rejected: 0, closed: 0 }],
    truncated: false,
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

function createFetchMock(options?: { ok?: boolean }) {
  const ok = options?.ok ?? true;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(normalizeRequestUrl(input), "http://localhost");
    if (url.pathname === "/api/admin/b2b/procurement/analytics") {
      if (!ok) return jsonResponse({ error: "Analytics failed" }, false, 500);
      return jsonResponse(makeAnalyticsResponse());
    }
    throw new Error(`Unhandled fetch in procurement analytics page test: ${url.pathname}${url.search}`);
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <B2BProcurementAnalyticsPage />
    </QueryClientProvider>,
  );
}

describe("B2BProcurementAnalyticsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSession.mockReturnValue({
      data: { user: { id: "admin-1", role: "ADMIN", email: "admin@nora.gh" } },
      status: "authenticated",
    });
    vi.stubGlobal("fetch", createFetchMock());
  });

  it("renders the eligible draft denominator and formatted cycle-time placeholders", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "B2B Procurement Analytics" })).toBeInTheDocument();
    expect(screen.getByText("Eligible requests")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });

  it("links oldest open rows back to workflow search", async () => {
    renderPage();

    const oldestLink = await screen.findByRole("link", { name: /Open Old Clinic request/i });
    expect(oldestLink).toHaveAttribute("href", "/admin/b2b/procurement?search=Old%20Clinic");
  });

  it("keeps invalid date ranges client-side and shows a validation alert", async () => {
    renderPage();

    const from = await screen.findByLabelText("From date");
    const to = await screen.findByLabelText("To date");
    fireEvent.change(from, { target: { value: "2026-06-01" } });
    fireEvent.change(to, { target: { value: "2026-01-01" } });

    expect(screen.getByRole("alert")).toHaveTextContent("Start date must be before end date.");
    await waitFor(() => {
      const invalidCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => {
        const url = new URL(normalizeRequestUrl(input), "http://localhost");
        return url.searchParams.get("start") === "2026-06-01" && url.searchParams.get("end") === "2026-01-01";
      });
      expect(invalidCall).toBeUndefined();
    });
  });

  it("shows the analytics error banner when the API fails", async () => {
    vi.stubGlobal("fetch", createFetchMock({ ok: false }));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load analytics data");
  });
});
