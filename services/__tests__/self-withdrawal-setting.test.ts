import { beforeEach, describe, expect, test } from 'bun:test';
import {
  onSelfWithdrawalEnabledChange,
  readSelfWithdrawalEnabled,
  resetSelfWithdrawalMemory,
  selfWithdrawalMenuLabel,
  writeSelfWithdrawalEnabled,
} from '../self-withdrawal-setting';
import { reviewContextMatches, type WithdrawReviewContext } from '../withdraw-quotes';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => { data[key] = value; },
    data,
  };
}

describe('self withdrawal setting', () => {
  beforeEach(() => resetSelfWithdrawalMemory());

  test('is off until someone turns it on', () => {
    expect(readSelfWithdrawalEnabled(memoryStorage())).toBe(false);
  });

  test('persists and reads back', () => {
    const storage = memoryStorage();
    writeSelfWithdrawalEnabled(true, storage);
    resetSelfWithdrawalMemory();
    expect(readSelfWithdrawalEnabled(storage)).toBe(true);
    writeSelfWithdrawalEnabled(false, storage);
    resetSelfWithdrawalMemory();
    expect(readSelfWithdrawalEnabled(storage)).toBe(false);
  });

  test('a blocked storage reads as off and still holds the choice for the session', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(readSelfWithdrawalEnabled(blocked)).toBe(false);
    writeSelfWithdrawalEnabled(true, blocked);
    expect(readSelfWithdrawalEnabled(blocked)).toBe(true);
  });

  test('tells listeners and stops after unsubscribe', () => {
    const seen: boolean[] = [];
    const stop = onSelfWithdrawalEnabledChange((value) => seen.push(value));
    writeSelfWithdrawalEnabled(true, memoryStorage());
    stop();
    writeSelfWithdrawalEnabled(false, memoryStorage());
    expect(seen).toEqual([true]);
  });

  test('menu label names the state', () => {
    expect(selfWithdrawalMenuLabel(true)).toBe('Self withdrawal: On');
    expect(selfWithdrawalMenuLabel(false)).toBe('Self withdrawal: Off');
  });
});

describe('direct withdrawal review context', () => {
  const ctx: WithdrawReviewContext = {
    mode: 'direct',
    poolChainId: 1,
    sessionKey: '0xabc:1',
    epoch: 3,
    recipient: '0xdef',
    spendabilityKey: 'k',
  };
  const live = { isSui: false, poolChainId: 1, sessionKey: '0xABC:1', epoch: 3, spendabilityKey: 'k' };

  test('matches the live EVM context it was reviewed in', () => {
    expect(reviewContextMatches(ctx, live)).toBe(true);
  });

  test('a chain, account, epoch or note-set change invalidates it', () => {
    expect(reviewContextMatches(ctx, { ...live, poolChainId: 10 })).toBe(false);
    expect(reviewContextMatches(ctx, { ...live, sessionKey: '0x999:1' })).toBe(false);
    expect(reviewContextMatches(ctx, { ...live, epoch: 4 })).toBe(false);
    expect(reviewContextMatches(ctx, { ...live, spendabilityKey: 'other' })).toBe(false);
  });

  test('is never an Sui review', () => {
    expect(reviewContextMatches(ctx, { ...live, isSui: true })).toBe(false);
  });
});
