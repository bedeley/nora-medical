export const EXPENSE_EDIT_LOCK_WINDOW_MS = 48 * 60 * 60 * 1000;

export type ExpenseMutationFacts = {
  createdAt: Date | string;
  deletedAt?: Date | string | null;
  isReversal?: boolean | null;
  payrollRunId?: string | null;
  reversalCount?: number | null;
  settlementCount?: number | null;
};

export type ExpenseMutationState = {
  ageLocked: boolean;
  mutationLocked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
  canSettle: boolean;
  lockCode:
    | "DELETED"
    | "PAYROLL"
    | "REVERSAL_ROW"
    | "HAS_REVERSALS"
    | "HAS_SETTLEMENTS"
    | "AGE_LOCK"
    | null;
  lockReason: string | null;
};

export function getExpenseMutationState(input: ExpenseMutationFacts): ExpenseMutationState {
  const createdAt = new Date(input.createdAt);
  const ageLocked =
    !Number.isNaN(createdAt.getTime()) &&
    Date.now() - createdAt.getTime() > EXPENSE_EDIT_LOCK_WINDOW_MS;
  const deleted = Boolean(input.deletedAt);
  const payrollLocked = Boolean(input.payrollRunId);
  const reversalRow = Boolean(input.isReversal);
  const reversalCount = Math.max(0, Number(input.reversalCount ?? 0));
  const settlementCount = Math.max(0, Number(input.settlementCount ?? 0));
  const hasReversals = reversalCount > 0;
  const hasSettlements = settlementCount > 0;

  let lockCode: ExpenseMutationState["lockCode"] = null;
  let lockReason: string | null = null;

  if (deleted) {
    lockCode = "DELETED";
    lockReason = "Expense is deleted.";
  } else if (payrollLocked) {
    lockCode = "PAYROLL";
    lockReason = "Payroll-generated expenses must be corrected from the payroll run.";
  } else if (reversalRow) {
    lockCode = "REVERSAL_ROW";
    lockReason = "Reversal rows are locked. Create a new adjustment instead.";
  } else if (hasReversals) {
    lockCode = "HAS_REVERSALS";
    lockReason = "This expense already has reversal activity. Use a new adjustment instead.";
  } else if (hasSettlements) {
    lockCode = "HAS_SETTLEMENTS";
    lockReason = "Payments have already been posted for this expense. Edits and deletes are locked.";
  } else if (ageLocked) {
    lockCode = "AGE_LOCK";
    lockReason = "Edits and deletes are locked after 48 hours. Use a reversal instead.";
  }

  const canEdit = !lockCode;
  const canDelete = !lockCode;
  const canReverse = !deleted && !payrollLocked && !reversalRow && !hasReversals && !hasSettlements;
  const canSettle = !deleted && !payrollLocked && !reversalRow && !hasReversals;

  return {
    ageLocked,
    mutationLocked: Boolean(lockCode),
    canEdit,
    canDelete,
    canReverse,
    canSettle,
    lockCode,
    lockReason,
  };
}
