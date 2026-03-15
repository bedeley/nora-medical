export type RetryEntityType =
  | "ORDER"
  | "PAYMENT"
  | "EXPENSE"
  | "PURCHASE"
  | "SUPPLIER_PAYMENT"
  | "CREDIT_PAYOUT"
  | "DELIVERY_SETTLEMENT";

export type RetryTarget = { entityType: RetryEntityType; entityId: string; source: string };

type MissingPostingItems = {
  orders?: Array<{ id: string; createdAt: string }>;
  payments?: Array<{ id: string; createdAt: string }>;
  expenses?: Array<{ id: string; createdAt: string }>;
  purchases?: Array<{ id: string; createdAt: string }>;
  supplierPayments?: Array<{ id: string; createdAt: string }>;
  creditPayouts?: Array<{ id: string; createdAt: string }>;
  settlements?: Array<{ id: string; createdAt: string }>;
} | null;

export function buildRetryTargets(
  items: MissingPostingItems,
  pinnedSource: string,
): RetryTarget[] {
  if (!items) return [];
  const include = (source: string) => pinnedSource === "all" || pinnedSource === source;
  const targets: RetryTarget[] = [];
  if (include("orders")) {
    for (const row of items.orders || []) {
      targets.push({ entityType: "ORDER", entityId: row.id, source: "orders" });
    }
  }
  if (include("payments")) {
    for (const row of items.payments || []) {
      targets.push({ entityType: "PAYMENT", entityId: row.id, source: "payments" });
    }
  }
  if (include("expenses")) {
    for (const row of items.expenses || []) {
      targets.push({ entityType: "EXPENSE", entityId: row.id, source: "expenses" });
    }
  }
  if (include("purchases")) {
    for (const row of items.purchases || []) {
      targets.push({ entityType: "PURCHASE", entityId: row.id, source: "purchases" });
    }
  }
  if (include("supplierPayments")) {
    for (const row of items.supplierPayments || []) {
      targets.push({ entityType: "SUPPLIER_PAYMENT", entityId: row.id, source: "supplierPayments" });
    }
  }
  if (include("creditPayouts")) {
    for (const row of items.creditPayouts || []) {
      targets.push({ entityType: "CREDIT_PAYOUT", entityId: row.id, source: "creditPayouts" });
    }
  }
  if (include("settlements")) {
    for (const row of items.settlements || []) {
      targets.push({ entityType: "DELIVERY_SETTLEMENT", entityId: row.id, source: "settlements" });
    }
  }
  return targets;
}

export function summarizeAgingBuckets(
  rows: Array<{ createdAt: string }>,
  nowMs = Date.now(),
  warningDays = 3,
  criticalDays = 8,
) {
  let fresh = 0;
  let warning = 0;
  let overdue = 0;
  for (const row of rows) {
    const createdMs = new Date(row.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageDays = Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000));
    if (ageDays >= criticalDays) overdue += 1;
    else if (ageDays >= warningDays) warning += 1;
    else fresh += 1;
  }
  return { fresh, warning, overdue };
}

export function explainPostingFailure(params: {
  action?: string | null;
  reason?: string | null;
  meta?: string | null;
}) {
  const source = `${params.action || ""} ${params.reason || ""} ${params.meta || ""}`.toLowerCase();
  if (/period[_\s-]?closed|closed period/.test(source)) {
    return { reason: "Period is closed", hint: "Post in an open period or reopen the period." };
  }
  if (/already[_\s-]?posted|duplicate|p2002/.test(source)) {
    return { reason: "Already posted", hint: "No retry needed; verify existing journal entry." };
  }
  if (/missing[_\s-]?account|mapping|chart/.test(source)) {
    return { reason: "Missing account mapping", hint: "Set up required ledger account mapping first." };
  }
  if (/validation|invalid|constraint|required/.test(source)) {
    return { reason: "Validation failed", hint: "Correct source data and retry posting." };
  }
  if (/not found|deleted/.test(source)) {
    return { reason: "Source record unavailable", hint: "Restore or recreate the source record." };
  }
  return { reason: "Posting failed", hint: "Open source record and audit logs for details." };
}
