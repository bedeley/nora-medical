// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchAppSettingMock,
  saveAppSettingMock,
  sessionState,
} = vi.hoisted(() => ({
  fetchAppSettingMock: vi.fn(),
  saveAppSettingMock: vi.fn(),
  sessionState: {
    role: "ADMIN",
    status: "authenticated",
  },
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: sessionState.status === "authenticated" ? { user: { role: sessionState.role } } : null,
    status: sessionState.status,
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
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/app-settings-client", () => ({
  fetchAppSetting: (key: string) => fetchAppSettingMock(key),
  saveAppSetting: (...args: unknown[]) => saveAppSettingMock(...args),
  fetchJsonOrThrow: async (
    res: { ok: boolean; json: () => Promise<unknown> },
    fallbackError: string,
  ) => {
    const payload = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(payload?.error || fallbackError);
    return payload;
  },
}));

import InventoryPlanningPage from "./page";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <InventoryPlanningPage />
    </QueryClientProvider>,
  );
}

describe("InventoryPlanningPage", () => {
  beforeEach(() => {
    sessionState.role = "ADMIN";
    sessionState.status = "authenticated";
    fetchAppSettingMock.mockReset();
    saveAppSettingMock.mockReset();
    fetchAppSettingMock.mockImplementation(async (key: string) => ({
      key,
      value: key === "inventoryPlanning.autoRecompute" ? "daily" : 12,
      updatedAt: "2026-04-09T00:00:00.000Z",
    }));
  });

  it("shows a read-only operations message for staff and hides planning settings", async () => {
    sessionState.role = "STAFF";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rows: [
            {
              id: "prod-1",
              name: "Exam Gloves",
              sku: "GLV-1",
              category: "PPE",
              supplier: "Safe Hands",
              stock: 20,
              reserved: 0,
              onOrder: 0,
              available: 20,
              plan: null,
              effectivePlan: {
                reorderPoint: 12,
                safetyStock: 4,
                leadTimeDays: 7,
                reviewPeriodDays: 60,
                minOrderQty: 5,
                approvalThresholdQty: null,
                targetStock: 0,
              },
              planSource: "auto",
              demand: null,
              suggestion: null,
            },
          ],
          meta: { lastRecomputeAt: null },
        }),
      })),
    );

    renderPage();

    expect(await screen.findByText("Exam Gloves")).toBeInTheDocument();
    expect(screen.getByText(/read-only for your role/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Default reorder point/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Auto recompute/i)).not.toBeInTheDocument();
  });

  it("renders an explicit error state when the planning request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "Inventory planning unavailable" }),
      })),
    );

    renderPage();

    expect(await screen.findByText(/Planning data could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Inventory planning unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("No products match the current search or filter.")).not.toBeInTheDocument();
  });

  it("renders the inventory planning audit link with a page-specific source filter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rows: [
            {
              id: "prod-1",
              name: "Exam Gloves",
              sku: "GLV-1",
              category: "PPE",
              supplier: "Safe Hands",
              stock: 20,
              reserved: 0,
              onOrder: 0,
              available: 20,
              plan: null,
              effectivePlan: {
                reorderPoint: 12,
                safetyStock: 4,
                leadTimeDays: 7,
                reviewPeriodDays: 60,
                minOrderQty: 5,
                approvalThresholdQty: null,
                targetStock: 0,
              },
              planSource: "auto",
              demand: null,
              suggestion: null,
            },
          ],
          meta: { lastRecomputeAt: null },
        }),
      })),
    );

    renderPage();

    const auditLink = await screen.findByRole("link", { name: /Open audit log/i });
    expect(auditLink).toHaveAttribute(
      "href",
      "/admin/audit?sourcePage=admin%2Finventory-planning",
    );
  });

  it("keeps open suggestions visible even when a product is now above reorder and prefills the purchase qty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rows: [
            {
              id: "prod-1",
              name: "Exam Gloves",
              sku: "GLV-1",
              category: "PPE",
              supplier: "Safe Hands",
              stock: 20,
              reserved: 0,
              onOrder: 0,
              available: 20,
              plan: null,
              effectivePlan: {
                reorderPoint: 12,
                safetyStock: 4,
                leadTimeDays: 7,
                reviewPeriodDays: 60,
                minOrderQty: 5,
                approvalThresholdQty: null,
                targetStock: 0,
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
                id: "sug-1",
                suggestedQty: 15,
                reason: "Existing open suggestion",
                createdAt: "2026-04-09T00:00:00.000Z",
              },
            },
          ],
          meta: { lastRecomputeAt: "2026-04-09T00:00:00.000Z", lastRecomputeMode: "manual" },
        }),
      })),
    );

    renderPage();
    const user = userEvent.setup();

    expect(await screen.findByText("Exam Gloves")).toBeInTheDocument();
    expect(screen.getByText(/Suggestion still open/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open suggestion/i }));
    expect(screen.getByText("Exam Gloves")).toBeInTheDocument();

    const purchaseLink = screen.getByRole("link", { name: "Purchase" });
    expect(purchaseLink).toHaveAttribute("href", "/admin/purchases?product=prod-1&qty=15&new=1");
  });
});
