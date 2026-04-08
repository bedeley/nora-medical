import { describe, expect, it } from "vitest";
import { hasPermission, isAdminRole, isPrivilegedRole } from "@/lib/permissions";

describe("hasPermission", () => {
  // --- ADMIN gets everything ---
  it("ADMIN can return orders", () => {
    expect(hasPermission("ADMIN", "orders.return")).toBe(true);
  });
  it("ADMIN can manage purchases", () => {
    expect(hasPermission("ADMIN", "purchases.manage")).toBe(true);
  });
  it("ADMIN can manage HR", () => {
    expect(hasPermission("ADMIN", "hr.manage")).toBe(true);
  });
  it("ADMIN can manage settings", () => {
    expect(hasPermission("ADMIN", "settings.manage")).toBe(true);
  });

  // --- ACCOUNTANT permissions ---
  it("ACCOUNTANT can view accounting", () => {
    expect(hasPermission("ACCOUNTANT", "accounting.view")).toBe(true);
  });
  it("ACCOUNTANT can post journal entries", () => {
    expect(hasPermission("ACCOUNTANT", "journal.post")).toBe(true);
  });
  it("ACCOUNTANT can view/export reports", () => {
    expect(hasPermission("ACCOUNTANT", "reports.view")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "reports.export")).toBe(true);
  });
  it("ACCOUNTANT can view payroll", () => {
    expect(hasPermission("ACCOUNTANT", "payroll.view")).toBe(true);
  });
  it("ACCOUNTANT cannot manage payroll", () => {
    expect(hasPermission("ACCOUNTANT", "payroll.manage")).toBe(false);
  });
  it("ACCOUNTANT cannot approve journals (ADMIN only)", () => {
    expect(hasPermission("ACCOUNTANT", "journal.approve")).toBe(false);
  });
  it("ACCOUNTANT cannot manage HR", () => {
    expect(hasPermission("ACCOUNTANT", "hr.manage")).toBe(false);
  });
  it("ACCOUNTANT cannot manage settings", () => {
    expect(hasPermission("ACCOUNTANT", "settings.manage")).toBe(false);
  });

  // --- STAFF permissions ---
  it("STAFF can create and manage orders", () => {
    expect(hasPermission("STAFF", "orders.create")).toBe(true);
    expect(hasPermission("STAFF", "orders.manage")).toBe(true);
  });
  it("STAFF can view products and inventory", () => {
    expect(hasPermission("STAFF", "products.view")).toBe(true);
    expect(hasPermission("STAFF", "inventory.view")).toBe(true);
  });
  it("STAFF cannot return orders (ADMIN only)", () => {
    expect(hasPermission("STAFF", "orders.return")).toBe(false);
  });
  it("STAFF cannot adjust inventory (ADMIN only)", () => {
    expect(hasPermission("STAFF", "inventory.adjust")).toBe(false);
  });
  it("STAFF cannot manage purchases", () => {
    expect(hasPermission("STAFF", "purchases.manage")).toBe(false);
  });
  it("STAFF cannot view accounting", () => {
    expect(hasPermission("STAFF", "accounting.view")).toBe(false);
  });

  // --- DISPATCHER permissions ---
  it("DISPATCHER can view and manage deliveries", () => {
    expect(hasPermission("DISPATCHER", "delivery.view")).toBe(true);
    expect(hasPermission("DISPATCHER", "delivery.manage")).toBe(true);
  });
  it("DISPATCHER cannot manage orders", () => {
    expect(hasPermission("DISPATCHER", "orders.manage")).toBe(false);
  });
  it("DISPATCHER cannot view accounting", () => {
    expect(hasPermission("DISPATCHER", "accounting.view")).toBe(false);
  });

  // --- CUSTOMER gets nothing ---
  it("CUSTOMER is denied all admin permissions", () => {
    expect(hasPermission("CUSTOMER", "orders.view")).toBe(false);
    expect(hasPermission("CUSTOMER", "accounting.view")).toBe(false);
    expect(hasPermission("CUSTOMER", "hr.view")).toBe(false);
  });

  // --- Null/undefined safety ---
  it("null role returns false", () => {
    expect(hasPermission(null, "orders.view")).toBe(false);
  });
  it("undefined role returns false", () => {
    expect(hasPermission(undefined, "orders.view")).toBe(false);
  });
});

describe("isAdminRole", () => {
  it("returns true only for ADMIN", () => {
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("STAFF")).toBe(false);
    expect(isAdminRole("ACCOUNTANT")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });
});

describe("isPrivilegedRole", () => {
  it("returns true for all non-CUSTOMER roles", () => {
    expect(isPrivilegedRole("ADMIN")).toBe(true);
    expect(isPrivilegedRole("STAFF")).toBe(true);
    expect(isPrivilegedRole("ACCOUNTANT")).toBe(true);
    expect(isPrivilegedRole("DISPATCHER")).toBe(true);
  });

  it("returns false for CUSTOMER and empty values", () => {
    expect(isPrivilegedRole("CUSTOMER")).toBe(false);
    expect(isPrivilegedRole(null)).toBe(false);
    expect(isPrivilegedRole(undefined)).toBe(false);
  });
});
