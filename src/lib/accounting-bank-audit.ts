import type { AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";

type AccountingBankAuditParams = {
  req: Request;
  actor?: AuthenticatedUser | null;
  action: string;
  entityType: string;
  entityId: string;
  section: string;
  operation: string;
  resultSummary: string;
  meta?: Record<string, unknown>;
  outcome?: "SUCCESS" | "FAILED" | "PARTIAL";
};

export async function recordAccountingBankAudit(params: AccountingBankAuditParams) {
  const { req, actor, action, entityType, entityId, section, operation, resultSummary, meta, outcome } = params;
  await recordAuditLog({
    actorId: actor?.id || null,
    request: req,
    action,
    entityType,
    entityId,
    outcome: outcome || "SUCCESS",
    meta: {
      sourcePage: "admin/accounting/banks",
      section,
      operation,
      resultSummary,
      actorName: actor?.name || null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      ...(meta || {}),
    },
  });
}
