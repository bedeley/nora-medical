// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AdminBreadcrumb } from "./AdminBreadcrumb";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

// Mock next/link to render a simple anchor
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { usePathname } from "next/navigation";
const mockPathname = usePathname as ReturnType<typeof vi.fn>;

describe("AdminBreadcrumb", () => {
  it("renders nothing for /admin (single crumb)", () => {
    mockPathname.mockReturnValue("/admin");
    const { container } = render(<AdminBreadcrumb />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for root path", () => {
    mockPathname.mockReturnValue("/");
    const { container } = render(<AdminBreadcrumb />);
    expect(container.firstChild).toBeNull();
  });

  it("renders two crumbs for /admin/orders", () => {
    mockPathname.mockReturnValue("/admin/orders");
    render(<AdminBreadcrumb />);
    const nav = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(nav).toBeInTheDocument();
    // Admin Dashboard (link) + Orders/Payments (current page)
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThanOrEqual(1);
    // Current page label should not be a link
    expect(screen.getByText("Orders/Payments")).toBeInTheDocument();
  });

  it("renders three crumbs for /admin/accounting/aging", () => {
    mockPathname.mockReturnValue("/admin/accounting/aging");
    render(<AdminBreadcrumb />);
    // Should show Accounting (link) > AR/AP Aging (current)
    expect(screen.getByText("Accounting")).toBeInTheDocument();
    expect(screen.getByText("AR/AP Aging")).toBeInTheDocument();
    // Last crumb should have aria-current="page"
    const currentCrumb = screen.getByText("AR/AP Aging");
    expect(currentCrumb).toHaveAttribute("aria-current", "page");
  });

  it("marks only the last crumb as aria-current=page", () => {
    mockPathname.mockReturnValue("/admin/accounting/aging");
    const { container } = render(<AdminBreadcrumb />);
    const currentItems = container.querySelectorAll("[aria-current='page']");
    expect(currentItems).toHaveLength(1);
  });

  it("all ancestor crumbs are clickable links", () => {
    mockPathname.mockReturnValue("/admin/hr/settings");
    render(<AdminBreadcrumb />);
    // HR (link) > HR Settings (current)
    const hrLink = screen.getByRole("link", { name: "HR" });
    expect(hrLink).toHaveAttribute("href", "/admin/hr");
  });

  it("renders nothing for a non-admin path", () => {
    mockPathname.mockReturnValue("/products");
    const { container } = render(<AdminBreadcrumb />);
    expect(container.firstChild).toBeNull();
  });
});
