import type { AuthenticatedUser } from "@/lib/auth";

export function canAccessAdminAudit(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}
