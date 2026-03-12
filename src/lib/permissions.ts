import { Role } from "@/lib/prisma-enums";

export type Permission =
  | "orders.return"
  | "purchases.manage"
  | "supplierPayments.manage"
  | "journal.approve"
  | "journal.post"
  | "import.data"
  | "export.data";

const permissionMap: Record<Permission, Role[]> = {
  "orders.return": [Role.ADMIN],
  "purchases.manage": [Role.ADMIN],
  "supplierPayments.manage": [Role.ADMIN],
  "journal.approve": [Role.ADMIN],
  "journal.post": [Role.ADMIN],
  "import.data": [Role.ADMIN],
  "export.data": [Role.ADMIN],
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
