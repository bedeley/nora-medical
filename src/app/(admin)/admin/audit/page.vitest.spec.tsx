// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mockUseSession = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

import AdminAuditPage from "./page";

describe("AdminAuditPage access gate", () => {
  it("shows an access-restricted state for non-admin users", () => {
    mockUseSession.mockReturnValue({
      data: { user: { role: "STAFF" } },
      status: "authenticated",
    });

    render(<AdminAuditPage />);

    expect(screen.getByText("Access Restricted")).toBeInTheDocument();
    expect(
      screen.getByText("The audit log is restricted to admin users."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Audit Log" }),
    ).not.toBeInTheDocument();
  });
});
