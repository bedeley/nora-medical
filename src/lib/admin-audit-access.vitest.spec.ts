import { describe, expect, it } from "vitest";
import { canAccessAdminAudit } from "./admin-audit-access";

describe("canAccessAdminAudit", () => {
  it("allows admins", () => {
    expect(canAccessAdminAudit({ role: "ADMIN" } as never)).toBe(true);
  });

  it("blocks staff and accountants", () => {
    expect(canAccessAdminAudit({ role: "STAFF" } as never)).toBe(false);
    expect(canAccessAdminAudit({ role: "ACCOUNTANT" } as never)).toBe(false);
  });

  it("blocks missing sessions", () => {
    expect(canAccessAdminAudit(undefined)).toBe(false);
    expect(canAccessAdminAudit(null)).toBe(false);
  });
});
