type BalanceValue = number | string | null | undefined | { toString(): string };

type BalanceLine = {
  debit?: BalanceValue;
  credit?: BalanceValue;
};

export function getJournalEntryBalanceTotals(lines: BalanceLine[] = []) {
  return lines.reduce<{ debit: number; credit: number }>(
    (acc, line) => {
      acc.debit = acc.debit + Number(line.debit || 0);
      acc.credit = acc.credit + Number(line.credit || 0);
      return acc;
    },
    { debit: 0, credit: 0 },
  );
}

export function isJournalEntryBalanced(lines: BalanceLine[] = [], tolerance = 0.01) {
  const totals = getJournalEntryBalanceTotals(lines);
  return Math.abs(totals.debit - totals.credit) <= tolerance;
}
