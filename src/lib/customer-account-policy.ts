export type CustomerAccountRole = string | null | undefined;

export function isEmployeeCustomerRole(role: CustomerAccountRole) {
  return Boolean(role && role !== "CUSTOMER");
}

export function canApproveEmployeeCustomerFinancialChange(params: {
  actorRole: CustomerAccountRole;
  targetRole: CustomerAccountRole;
}) {
  return !isEmployeeCustomerRole(params.targetRole) || params.actorRole === "ADMIN";
}

export function buildCustomerActorTargetMeta(params: {
  actorId?: string | null;
  actorRole?: CustomerAccountRole;
  targetId: string;
  targetRole?: CustomerAccountRole;
}) {
  const isEmployeeCustomer = isEmployeeCustomerRole(params.targetRole);
  return {
    actorId: params.actorId || null,
    actorRole: params.actorRole || null,
    targetCustomerId: params.targetId,
    targetCustomerRole: params.targetRole || null,
    isEmployeeCustomer,
    isSelfServiceAction: Boolean(params.actorId && params.actorId === params.targetId),
  };
}

