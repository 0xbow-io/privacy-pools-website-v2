export const MY_ACTIVITY_COLUMNS = ['Deposits', 'Withdrawals', 'Transfers'] as const;
export type MyActivityColumn = (typeof MY_ACTIVITY_COLUMNS)[number];

export type MyActivityCounts = {
  deposits: number;
  withdrawals: number;
  transfers: number;
};

/** Shown for every count while no account is connected. Same glyph the
 * portfolio page uses for a value it cannot state. */
export const MY_ACTIVITY_PLACEHOLDER = '—';

export type MyActivityCell = { label: MyActivityColumn; value: string };

export function myActivityCells(counts: MyActivityCounts, isConnected: boolean): readonly MyActivityCell[] {
  const values: Record<MyActivityColumn, number> = {
    Deposits: counts.deposits,
    Withdrawals: counts.withdrawals,
    Transfers: counts.transfers,
  };
  return MY_ACTIVITY_COLUMNS.map((label) => ({
    label,
    value: isConnected ? String(values[label]) : MY_ACTIVITY_PLACEHOLDER,
  }));
}
