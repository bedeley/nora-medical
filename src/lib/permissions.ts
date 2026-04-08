import { Role } from "@/lib/prisma-enums";

export type Permission =
  // Orders
  | "orders.view"
  | "orders.create"
  | "orders.manage"
  | "orders.return"
  // Customers
  | "customers.view"
  | "customers.manage"
  // Products & Inventory
  | "products.view"
  | "products.manage"
  | "inventory.view"
  | "inventory.adjust"
  // Purchases & Suppliers
  | "purchases.view"
  | "purchases.manage"
  | "suppliers.view"
  | "suppliers.manage"
  | "supplierPayments.manage"
  // Accounting
  | "accounting.view"
  | "journal.create"
  | "journal.approve"
  | "journal.post"
  | "reports.view"
  | "reports.export"
  // HR
  | "hr.view"
  | "hr.manage"
  | "payroll.view"
  | "payroll.manage"
  // Delivery
  | "delivery.view"
  | "delivery.manage"
  // System
  | "users.view"
  | "users.manage"
  | "settings.manage"
  | "audit.view"
  | "import.data"
  | "export.data";

const permissionMap: Record<Permission, Role[]> = {
  // Orders
  "orders.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "orders.create": [Role.ADMIN, Role.STAFF],
  "orders.manage": [Role.ADMIN, Role.STAFF],
  "orders.return": [Role.ADMIN],

  // Customers
  "customers.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "customers.manage": [Role.ADMIN, Role.STAFF],

  // Products & Inventory
  "products.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "products.manage": [Role.ADMIN, Role.STAFF],
  "inventory.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "inventory.adjust": [Role.ADMIN],

  // Purchases & Suppliers
  "purchases.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "purchases.manage": [Role.ADMIN],
  "suppliers.view": [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT],
  "suppliers.manage": [Role.ADMIN],
  "supplierPayments.manage": [Role.ADMIN],

  // Accounting
  "accounting.view": [Role.ADMIN, Role.ACCOUNTANT],
  "journal.create": [Role.ADMIN, Role.ACCOUNTANT],
  "journal.approve": [Role.ADMIN],
  "journal.post": [Role.ADMIN, Role.ACCOUNTANT],
  "reports.view": [Role.ADMIN, Role.ACCOUNTANT],
  "reports.export": [Role.ADMIN, Role.ACCOUNTANT],

  // HR
  "hr.view": [Role.ADMIN],
  "hr.manage": [Role.ADMIN],
  "payroll.view": [Role.ADMIN, Role.ACCOUNTANT],
  "payroll.manage": [Role.ADMIN],

  // Delivery
  "delivery.view": [Role.ADMIN, Role.STAFF, Role.DISPATCHER],
  "delivery.manage": [Role.ADMIN, Role.DISPATCHER],

  // System
  "users.view": [Role.ADMIN],
  "users.manage": [Role.ADMIN],
  "settings.manage": [Role.ADMIN],
  "audit.view": [Role.ADMIN, Role.ACCOUNTANT],
  "import.data": [Role.ADMIN],
  "export.data": [Role.ADMIN, Role.ACCOUNTANT],
};

export function hasPermission(
  role: Role | string | undefined | null,
  permission: Permission,
): boolean {
  if (!role) return false;
  return permissionMap[permission].includes(role as Role);
}

export function isAdminRole(role: Role | string | undefined | null): boolean {
  return role === Role.ADMIN;
}

/**
 * Check if a role has access to the admin panel at all.
 * All non-CUSTOMER roles can access the admin area.
 */
export function isPrivilegedRole(role: Role | string | undefined | null): boolean {
  if (!role) return false;
  return role !== Role.CUSTOMER;
}
