/**
 * Pure helpers behind the pool page's "My activity" block and the balance /
 * statistics card row. Kept free of react-native imports so `bun test` can pin
 * the two behaviours the layout change introduced:
 *
 *  - a visitor who is not connected sees a placeholder in every count, never
 *    a misleading 0 (the block used to be hidden entirely);
 *  - on desktop the two cards share one height (`items-stretch`), on mobile
 *    they stack at content height (`flex-col items-start`).
 */
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

/**
 * Class names for the row holding the balance card and the statistics card.
 * Desktop: `items-stretch` so the taller card sets the height of both. Mobile:
 * stacked, content-height.
 */
export function poolCardsRowClassName(isMobile: boolean): string {
  return isMobile ? 'flex-col items-start' : 'flex-row items-stretch';
}
