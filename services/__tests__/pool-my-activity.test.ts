import { describe, expect, test } from 'bun:test';
import {
  MY_ACTIVITY_COLUMNS,
  MY_ACTIVITY_PLACEHOLDER,
  myActivityCells,
  poolCardsRowClassName,
} from '../pool-my-activity';

describe('pool page "My activity" cells', () => {
  const counts = { deposits: 3, withdrawals: 1, transfers: 7 };

  test('connected: one cell per column, in the fixed order, with the count as text', () => {
    const cells = myActivityCells(counts, true);
    expect(cells.map((c) => c.label)).toEqual([...MY_ACTIVITY_COLUMNS]);
    expect(cells.map((c) => c.value)).toEqual(['3', '1', '7']);
  });

  test('connected with nothing done yet shows 0, not the placeholder', () => {
    const cells = myActivityCells({ deposits: 0, withdrawals: 0, transfers: 0 }, true);
    expect(cells.every((c) => c.value === '0')).toBe(true);
  });

  test('disconnected: every count is the placeholder, whatever the numbers say', () => {
    const cells = myActivityCells(counts, false);
    expect(cells).toHaveLength(MY_ACTIVITY_COLUMNS.length);
    expect(cells.every((c) => c.value === MY_ACTIVITY_PLACEHOLDER)).toBe(true);
    expect(cells.some((c) => c.value === '0')).toBe(false);
  });
});

describe('pool page card row', () => {
  test('desktop stretches both cards to one height', () => {
    const cls = poolCardsRowClassName(false);
    expect(cls).toContain('flex-row');
    expect(cls).toContain('items-stretch');
    expect(cls).not.toContain('items-start');
  });

  test('mobile stacks the cards at content height', () => {
    const cls = poolCardsRowClassName(true);
    expect(cls).toContain('flex-col');
    expect(cls).toContain('items-start');
    expect(cls).not.toContain('items-stretch');
  });
});
