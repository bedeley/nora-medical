import { describe, expect, it } from "vitest";
import {
  buildCustomerActorTargetMeta,
  canApproveEmployeeCustomerFinancialChange,
  isEmployeeCustomerRole,
} from "./customer-account-policy";

describe("customer account policy", () => {
  it("treats non-CUSTOMER users as employee customers when they have customer-ledger activity", () => {
    expect(isEmployeeCustomerRole("CUSTOMER")).toBe(false);
    expect(isEmployeeCustomerRole("ADMIN")).toBe(true);
    expect(isEmployeeCustomerRole("ACCOUNTANT")).toBe(true);
    expect(isEmployeeCustomerRole("STAFF")).toBe(true);
  });

  it("requires admin approval for employee-owned financial changes", () => {
    expect(
      canApproveEmployeeCustomerFinancialChange({
        actorRole: "ACCOUNTANT",
        targetRole: "CUSTOMER",
      }),
    ).toBe(true);
    expect(
      canApproveEmployeeCustomerFinancialChange({
        actorRole: "ACCOUNTANT",
        targetRole: "ADMIN",
      }),
    ).toBe(false);
    expect(
      canApproveEmployeeCustomerFinancialChange({
        actorRole: "ADMIN",
        targetRole: "ADMIN",
      }),
    ).toBe(true);
  });

  it("builds reviewable actor and target metadata", () => {
    expect(
      buildCustomerActorTargetMeta({
        actorId: "admin-1",
        actorRole: "ADMIN",
        targetId: "admin-1",
        targetRole: "ADMIN",
      }),
    ).toEqual({
      actorId: "admin-1",
      actorRole: "ADMIN",
      targetCustomerId: "admin-1",
      targetCustomerRole: "ADMIN",
      isEmployeeCustomer: true,
      isSelfServiceAction: true,
    });
  });
});

