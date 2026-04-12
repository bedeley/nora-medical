// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

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

import { ProductsHeaderActions } from "./ProductsHeaderActions";

const baseProps = {
  bulkMinMarginOpen: false,
  onBulkMinMarginOpenChange: vi.fn(),
  bulkMinMarginCategory: "",
  onBulkMinMarginCategoryChange: vi.fn(),
  bulkMinMarginValue: "",
  onBulkMinMarginValueChange: vi.fn(),
  bulkMinMarginReason: "",
  onBulkMinMarginReasonChange: vi.fn(),
  bulkMinMarginSaving: false,
  onBulkSetMinMargin: vi.fn(),
  addProductAction: <button type="button">Add Product</button>,
};

describe("ProductsHeaderActions", () => {
  it("renders the audit link for admins", () => {
    render(<ProductsHeaderActions {...baseProps} isAdmin={true} />);

    expect(
      screen.getByRole("link", { name: "View Audit Log" }),
    ).toHaveAttribute("href", "/admin/audit?sourcePage=admin%2Fproducts");
  });

  it("hides the audit link for non-admin users", () => {
    render(<ProductsHeaderActions {...baseProps} isAdmin={false} />);

    expect(
      screen.queryByRole("link", { name: "View Audit Log" }),
    ).not.toBeInTheDocument();
  });
});
