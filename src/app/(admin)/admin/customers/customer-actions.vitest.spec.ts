import { describe, expect, it } from "vitest";
import { getCustomerActionPermissions } from "./customer-actions";

describe("admin customers action permissions", () => {
  it("allows accountants to manage payments and credits but not profile, cart, or credit limit", () => {
    expect(getCustomerActionPermissions("ACCOUNTANT")).toMatchObject({
      canManagePayments: true,
      canManageCredit: true,
      canSendAccountEmails: true,
      canManageCreditLimit: false,
      canManageProfile: false,
      canManageCart: false,
      canManageLifecycle: false,
    });
  });

  it("allows staff to view customer workflows without financial write actions", () => {
    expect(getCustomerActionPermissions("STAFF")).toMatchObject({
      canManagePayments: false,
      canManageCredit: false,
      canSendAccountEmails: false,
      canManageCreditLimit: false,
      canManageProfile: true,
      canManageCart: true,
      canManageLifecycle: false,
    });
  });

  it("allows admins to perform every customer action", () => {
    expect(getCustomerActionPermissions("ADMIN")).toEqual({
      canManagePayments: true,
      canManageCredit: true,
      canSendAccountEmails: true,
      canManageCreditLimit: true,
      canManageProfile: true,
      canManageCart: true,
      canManageLifecycle: true,
    });
  });
});
