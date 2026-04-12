// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/admin/expenses",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: mockToastSuccess, warning: vi.fn() },
  Toaster: () => null,
}));

vi.mock("@/app/(admin)/dashboard/components/AddExpenseDialog", () => ({
  default: function MockAddExpenseDialog({
    onAdded,
  }: {
    onAdded?: () => void;
  }) {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>+ Add Expense</button>
        {open ? (
          <div role="dialog" data-testid="add-expense-dialog">
            <button
              data-testid="add-expense-success"
              onClick={() => {
                setOpen(false);
                onAdded?.();
              }}
            >
              Save
            </button>
          </div>
        ) : null}
      </>
    );
  },
}));

vi.mock("@/lib/currency", () => ({
  formatCurrency: (n: number) => `GHS ${Number(n).toFixed(2)}`,
}));

vi.mock("@/lib/status-chips", () => ({
  chipToneClass: () => "chip-class",
}));

vi.mock("@/lib/admin-export-audit-client", () => ({
  logAdminExportDownload: vi.fn(),
}));

import ExpensesPage from "./page";

function makeExpenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "e1",
    category: "5100 - Office Supplies",
    amount: 250,
    vendor: "Acme Corp",
    reason: "Monthly office supplies",
    note: null,
    isReversal: false,
    reversalOfId: null,
    settlementPaid: 0,
    settlementOutstanding: 250,
    settlementStatus: "UNPAID",
    settlementLastPaidAt: null,
    payrollRunId: null,
    canEdit: true,
    canDelete: true,
    canReverse: true,
    canSettle: true,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function mockFetchSuccess(
  items: unknown[],
  totalAmount = 0,
  overrides: {
    totalCount?: number;
    page?: number;
    pageSize?: number;
    totalPages?: number;
    summary?: Record<string, unknown>;
  } = {},
) {
  const totalCount = overrides.totalCount ?? items.length;
  const page = overrides.page ?? 1;
  const pageSize = overrides.pageSize ?? 50;
  const totalPages = overrides.totalPages ?? Math.max(1, Math.ceil(totalCount / pageSize));

  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      items,
      totalAmount,
      totalCount,
      page,
      pageSize,
      totalPages,
      summary: overrides.summary ?? {
        grossAmount: totalAmount,
        reversalAmount: 0,
        netAmount: totalAmount,
        outstandingLiability: 0,
        unpaidCount: 0,
        topCategories: [],
      },
    }),
  });
}

function mockFetchError() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: "Server error" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("AdminExpensesPage", () => {
  it("renders the card title 'Expenses'", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    expect(screen.getAllByText(/^Expenses$/i).length).toBeGreaterThan(0);
  });

  it("renders the audit log link with correct href", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      const link = screen.getByText(/view audit log/i);
      expect(link.closest("a")?.getAttribute("href")).toBe(
        "/admin/audit?entityType=EXPENSE&sourcePage=admin%2Fexpenses",
      );
    });
  });

  it("renders expense rows fetched from API", async () => {
    mockFetchSuccess([makeExpenseRow(), makeExpenseRow({ id: "e2", vendor: "Beta LLC" })], 500);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Beta LLC").length).toBeGreaterThan(0);
    });
  });

  it("shows a fetch error toast on API failure", async () => {
    mockFetchError();
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/failed to load/i));
    });
  });

  it("shows 'Outstanding liability' card text", async () => {
    mockFetchSuccess(
      [makeExpenseRow({ settlementStatus: "UNPAID", settlementOutstanding: 300 })],
      300,
      {
        summary: {
          grossAmount: 300,
          reversalAmount: 0,
          netAmount: 300,
          outstandingLiability: 300,
          unpaidCount: 1,
          topCategories: [],
        },
      },
    );
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.getByText(/outstanding liability/i)).toBeDefined();
      expect(screen.getAllByText("GHS 300.00").length).toBeGreaterThan(0);
    });
  });

  it("shows '-' when outstanding liability is zero", async () => {
    mockFetchSuccess(
      [makeExpenseRow({ settlementStatus: "PAID", settlementOutstanding: 0, settlementPaid: 250 })],
      250,
      {
        summary: {
          grossAmount: 250,
          reversalAmount: 0,
          netAmount: 250,
          outstandingLiability: 0,
          unpaidCount: 0,
          topCategories: [],
        },
      },
    );
    render(<ExpensesPage />);
    await waitFor(() => {
      const card = screen.getByText(/outstanding liability/i).closest("div");
      expect(card?.parentElement?.textContent).toContain("-");
    });
  });

  it("does not call window.confirm() when delete button is clicked", async () => {
    mockFetchSuccess([makeExpenseRow()]);
    render(<ExpensesPage />);
    await waitFor(() => expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0));

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const deleteButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.toLowerCase().includes("delete"));
    expect(deleteButton).toBeDefined();

    fireEvent.click(deleteButton!);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("delete action does NOT call DELETE API before confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [makeExpenseRow()],
        totalAmount: 250,
        totalCount: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1,
        summary: {
          grossAmount: 250,
          reversalAmount: 0,
          netAmount: 250,
          outstandingLiability: 250,
          unpaidCount: 1,
          topCategories: [],
        },
      }),
    });
    global.fetch = fetchMock;

    render(<ExpensesPage />);
    await waitFor(() => expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0));

    const deleteButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.toLowerCase().includes("delete"));
    fireEvent.click(deleteButton!);

    const deleteCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deleteCalls.length).toBe(0);
  });

  it("shows UNPAID badge for UNPAID expense", async () => {
    mockFetchSuccess([makeExpenseRow({ settlementStatus: "UNPAID" })]);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/unpaid/i).length).toBeGreaterThan(0);
    });
  });

  it("shows PAID badge for PAID expense", async () => {
    mockFetchSuccess([makeExpenseRow({ settlementStatus: "PAID", settlementPaid: 250, settlementOutstanding: 0 })]);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/\bpaid\b/i).length).toBeGreaterThan(0);
    });
  });

  it("export button is present", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /export/i })).not.toBeNull();
    });
  });

  it("Add expense button is present", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /add expense/i })).not.toBeNull();
    });
  });

  it("column toggles button is present", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /columns/i })).not.toBeNull();
    });
  });

  it("settlement state filter select contains UNPAID and PAID options", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      const selects = screen.queryAllByRole("combobox");
      const allOptionText = selects
        .flatMap((select) =>
          Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? ""),
        )
        .join(" ")
        .toLowerCase();
      expect(allOptionText).toMatch(/unpaid/);
      expect(allOptionText).toMatch(/paid/);
    });
  });

  it("persists column preferences to localStorage after mount", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    await waitFor(() => {
      const stored = localStorage.getItem("expenses-col-prefs");
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(typeof parsed.showCategory).toBe("boolean");
    });
  });

  it("renders top category buttons from summary data", async () => {
    mockFetchSuccess(
      [
        makeExpenseRow({ id: "e1", category: "5100 - Office Supplies", isReversal: false }),
        makeExpenseRow({ id: "e2", category: "5100 - Office Supplies", isReversal: false }),
        makeExpenseRow({ id: "e3", category: "5200 - Marketing", isReversal: true }),
      ],
      750,
      {
        summary: {
          grossAmount: 750,
          reversalAmount: 0,
          netAmount: 750,
          outstandingLiability: 0,
          unpaidCount: 0,
          topCategories: [{ category: "5100 - Office Supplies", count: 2 }],
        },
      },
    );
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button")
          .some((button) => button.textContent?.includes("5100 - Office Supplies")),
      ).toBe(true);
    });
  });

  it("pagination controls appear when more than 50 rows are available", async () => {
    const manyRows = Array.from({ length: 55 }, (_, i) =>
      makeExpenseRow({ id: `e${i}`, vendor: `Vendor ${i}` }),
    );
    mockFetchSuccess(manyRows.slice(0, 50), 0, {
      totalCount: 55,
      page: 1,
      pageSize: 50,
      totalPages: 2,
    });
    render(<ExpensesPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/showing 1-50 of 55/i).length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: /next/i })).toBeDefined();
    }, { timeout: 12000 });
  }, 15000);

  it("date range inputs are present with correct ids for validation", async () => {
    mockFetchSuccess([]);
    render(<ExpensesPage />);
    const startInput = screen.getByLabelText(/start date/i);
    const endInput = screen.getByLabelText(/end date/i);
    expect(startInput.getAttribute("type")).toBe("date");
    expect(endInput.getAttribute("type")).toBe("date");
    expect(startInput.hasAttribute("aria-invalid")).toBe(true);
    expect(endInput.hasAttribute("aria-invalid")).toBe(true);
  });
});
