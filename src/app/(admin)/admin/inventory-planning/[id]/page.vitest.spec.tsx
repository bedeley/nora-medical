// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sessionState } = vi.hoisted(() => ({
  sessionState: {
    role: "ADMIN",
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { role: sessionState.role } },
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "prod-1" }),
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
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/app-settings-client", () => ({
  fetchJsonOrThrow: async (
    res: { ok: boolean; json: () => Promise<unknown> },
    fallbackError: string,
  ) => {
    const payload = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(payload?.error || fallbackError);
    return payload;
  },
}));

import InventoryPlanningDetailPage from "./page";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <InventoryPlanningDetailPage />
    </QueryClientProvider>,
  );
}

describe("InventoryPlanningDetailPage", () => {
  beforeEach(() => {
    sessionState.role = "ADMIN";
  });

  it("sends null for cleared optional overrides instead of leaving stale values behind", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, "http://localhost");

      if (url.pathname === "/api/admin/inventory-planning/prod-1" && (!init || init.method === undefined)) {
        return {
          ok: true,
          json: async () => ({
            row: {
              id: "prod-1",
              name: "Exam Gloves",
              sku: "GLV-1",
              category: "PPE",
              supplier: "Safe Hands",
              stock: 20,
              reserved: 3,
              onOrder: 8,
              available: 25,
              plan: {
                reorderPoint: 10,
                fallbackReorderPoint: 6,
                safetyStock: 4,
                leadTimeDays: 7,
                reviewPeriodDays: 30,
                minOrderQty: 5,
                approvalThresholdQty: 12,
                targetStock: 18,
              },
              effectivePlan: {
                reorderPoint: 10,
                safetyStock: 4,
                leadTimeDays: 7,
                reviewPeriodDays: 30,
                minOrderQty: 5,
                approvalThresholdQty: 12,
                targetStock: 18,
              },
              planSource: "manual",
              demand: {
                periodStart: "2026-02-01T00:00:00.000Z",
                periodEnd: "2026-04-01T00:00:00.000Z",
                capturedAt: "2026-04-09T00:00:00.000Z",
                unitsSold: 60,
                avgDailyDemand: "1.0000",
              },
              suggestion: {
                id: "sug-1",
                suggestedQty: 15,
                reason: "Available 25 below reorder 10",
                createdAt: "2026-04-09T00:00:00.000Z",
              },
            },
          }),
        };
      }

      if (url.pathname === "/api/admin/inventory-planning/prod-1" && init?.method === "PATCH") {
        return {
          ok: true,
          json: async () => JSON.parse(String(init.body || "{}")),
        };
      }

      throw new Error(`Unhandled fetch in inventory planning detail test: ${url.pathname}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const user = userEvent.setup();

    const fallbackInput = await screen.findByLabelText(/Fallback reorder point/i);
    const approvalInput = screen.getByLabelText(/Approval threshold quantity/i);
    await user.clear(fallbackInput);
    await user.clear(approvalInput);
    await user.click(screen.getByRole("button", { name: /Save overrides/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patchCall).toBeTruthy();
      const [, init] = patchCall as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        reorderPoint: 10,
        fallbackReorderPoint: null,
        safetyStock: 4,
        leadTimeDays: 7,
        reviewPeriodDays: 30,
        minOrderQty: 5,
        approvalThresholdQty: null,
        targetStock: 18,
      });
    });
  });

  it("hides the override form for accountants", async () => {
    sessionState.role = "ACCOUNTANT";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          row: {
            id: "prod-1",
            name: "Exam Gloves",
            sku: "GLV-1",
            category: "PPE",
            supplier: "Safe Hands",
            stock: 20,
            reserved: 3,
            onOrder: 8,
            available: 25,
            plan: null,
            effectivePlan: {
              reorderPoint: 10,
              safetyStock: 4,
              leadTimeDays: 7,
              reviewPeriodDays: 30,
              minOrderQty: 5,
              approvalThresholdQty: null,
              targetStock: 18,
            },
            planSource: "auto",
            demand: null,
            suggestion: null,
          },
        }),
      })),
    );

    renderPage();

    expect(await screen.findByText(/Manual overrides are admin-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save overrides/i })).not.toBeInTheDocument();
  });

  it("renders the audit link scoped to the current product detail page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          row: {
            id: "prod-1",
            name: "Exam Gloves",
            sku: "GLV-1",
            category: "PPE",
            supplier: "Safe Hands",
            stock: 20,
            reserved: 3,
            onOrder: 8,
            available: 25,
            plan: null,
            effectivePlan: {
              reorderPoint: 10,
              safetyStock: 4,
              leadTimeDays: 7,
              reviewPeriodDays: 30,
              minOrderQty: 5,
              approvalThresholdQty: null,
              targetStock: 18,
            },
            planSource: "auto",
            demand: null,
            suggestion: null,
          },
        }),
      })),
    );

    renderPage();

    const auditLink = await screen.findByRole("link", { name: /Open audit log/i });
    expect(auditLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Finventory-planning%2Fprod-1",
    );
  });

  it("explains why a live suggestion cannot be dismissed yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          row: {
            id: "prod-1",
            name: "Exam Gloves",
            sku: "GLV-1",
            category: "PPE",
            supplier: "Safe Hands",
            stock: 20,
            reserved: 3,
            onOrder: 8,
            available: 25,
            plan: null,
            effectivePlan: {
              reorderPoint: 10,
              safetyStock: 4,
              leadTimeDays: 7,
              reviewPeriodDays: 30,
              minOrderQty: 5,
              approvalThresholdQty: null,
              targetStock: 18,
            },
            planSource: "auto",
            demand: {
              periodStart: "2026-02-01T00:00:00.000Z",
              periodEnd: "2026-04-01T00:00:00.000Z",
              capturedAt: "2026-04-09T00:00:00.000Z",
              unitsSold: 60,
              avgDailyDemand: "1.0000",
            },
            suggestion: {
              id: null,
              suggestedQty: 15,
              reason: "Computed live from plan",
              createdAt: null,
            },
          },
        }),
      })),
    );

    renderPage();

    expect(await screen.findByText(/Live computed suggestions are not persisted yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss suggestion/i })).not.toBeInTheDocument();
  });
});
