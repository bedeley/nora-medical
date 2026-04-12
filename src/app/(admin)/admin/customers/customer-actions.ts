export type AdminCustomerRole = "ADMIN" | "STAFF" | "ACCOUNTANT" | string | null | undefined;

export type CustomerActionPermissions = {
  canManagePayments: boolean;
  canManageCredit: boolean;
  canSendAccountEmails: boolean;
  canManageCreditLimit: boolean;
  canManageProfile: boolean;
  canManageCart: boolean;
  canManageLifecycle: boolean;
};

export function getCustomerActionPermissions(role: AdminCustomerRole): CustomerActionPermissions {
  return {
    canManagePayments: role === "ADMIN" || role === "ACCOUNTANT",
    canManageCredit: role === "ADMIN" || role === "ACCOUNTANT",
    canSendAccountEmails: role === "ADMIN" || role === "ACCOUNTANT",
    canManageCreditLimit: role === "ADMIN",
    canManageProfile: role === "ADMIN" || role === "STAFF",
    canManageCart: role === "ADMIN" || role === "STAFF",
    canManageLifecycle: role === "ADMIN",
  };
}
