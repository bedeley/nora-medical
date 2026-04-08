// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { ADMIN_NAV_ITEMS } from "@/lib/admin-nav";

// Mock next/navigation router
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

beforeEach(() => {
  mockPush.mockClear();
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
});

function openPalette() {
  fireEvent.keyDown(document, { key: "k", metaKey: true });
}

describe("CommandPalette – open/close", () => {
  it("is hidden by default", () => {
    render(<CommandPalette role="ADMIN" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on Cmd+K", () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens on Ctrl+K", () => {
    render(<CommandPalette role="ADMIN" />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on backdrop click", async () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    // The backdrop is the outer div (parent of dialog)
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not close when clicking inside the dialog", () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("renders nothing when role is undefined", () => {
    render(<CommandPalette role={undefined} />);
    openPalette();
    // Dialog opens but list should be empty
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("No pages found.")).toBeInTheDocument();
  });
});

// Pure logic tests — filter function extracted inline, no React rendering needed
describe("CommandPalette – filter logic (pure)", () => {
  const adminItems = ADMIN_NAV_ITEMS.filter((item) => item.roles.includes("ADMIN"));
  const staffItems = ADMIN_NAV_ITEMS.filter((item) => item.roles.includes("STAFF"));

  function applyFilter(items: typeof ADMIN_NAV_ITEMS, query: string) {
    return query.trim()
      ? items.filter(
          (item) =>
            item.label.toLowerCase().includes(query.toLowerCase()) ||
            item.href.toLowerCase().includes(query.toLowerCase()),
        )
      : items;
  }

  it("empty query returns all accessible items", () => {
    expect(applyFilter(adminItems, "")).toHaveLength(adminItems.length);
  });

  it("filters by label case-insensitively", () => {
    // "Accounting" exists in the nav as a label
    const results = applyFilter(adminItems, "accounting");
    expect(results.length).toBeGreaterThan(0);
    results.forEach((item) => {
      const combined = item.label.toLowerCase() + item.href.toLowerCase();
      expect(combined).toContain("accounting");
    });
  });

  it("filters by href path segment", () => {
    // /admin/accounting/reconciliations and Reconcile Totals both contain "reconcil"
    const results = applyFilter(adminItems, "reconcil");
    expect(results.length).toBeGreaterThan(0);
    results.forEach((item) => {
      const combined = item.label.toLowerCase() + item.href.toLowerCase();
      expect(combined).toContain("reconcil");
    });
  });

  it("returns empty array for unmatched query", () => {
    expect(applyFilter(adminItems, "zzznothingmatches")).toHaveLength(0);
  });

  it("STAFF sees fewer pages than ADMIN", () => {
    expect(staffItems.length).toBeLessThan(adminItems.length);
  });

  it("ACCOUNTANT role gets accounting-relevant pages", () => {
    const accountantItems = ADMIN_NAV_ITEMS.filter((item) => item.roles.includes("ACCOUNTANT"));
    const accountingItems = applyFilter(accountantItems, "accounting");
    expect(accountingItems.length).toBeGreaterThan(0);
  });
});

describe("CommandPalette – component rendering", () => {
  it("shows all role-accessible pages when query is empty", () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(10);
  });

  it("shows fewer items for STAFF role", () => {
    const { unmount: unmountStaff } = render(<CommandPalette role="STAFF" />);
    openPalette();
    const staffCount = screen.getAllByRole("option").length;
    unmountStaff();

    render(<CommandPalette role="ADMIN" />);
    openPalette();
    const adminCount = screen.getAllByRole("option").length;
    expect(staffCount).toBeLessThan(adminCount);
  });
});

describe("CommandPalette – navigation", () => {
  it("navigates to selected page on Enter", async () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    // First option is the first nav item; press Enter to navigate
    fireEvent.keyDown(document, { key: "Enter" });
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("navigates to the clicked option and closes dialog", async () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    const firstOption = screen.getAllByRole("option")[0];
    fireEvent.click(firstOption);
    expect(mockPush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves active index down with ArrowDown", async () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    const optionsBefore = screen.getAllByRole("option");
    const firstSelected = optionsBefore.find((o) => o.getAttribute("aria-selected") === "true");
    expect(firstSelected).toBe(optionsBefore[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    const optionsAfter = screen.getAllByRole("option");
    const secondSelected = optionsAfter.find((o) => o.getAttribute("aria-selected") === "true");
    expect(secondSelected).toBe(optionsAfter[1]);
  });

  it("moves active index up with ArrowUp and clamps at 0", () => {
    render(<CommandPalette role="ADMIN" />);
    openPalette();
    // Already at index 0; ArrowUp should stay at 0
    fireEvent.keyDown(document, { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toBe(options[0]);
  });
});
