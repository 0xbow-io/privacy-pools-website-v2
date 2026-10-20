import { describe, expect, test } from 'bun:test';
import { countMyDeposits, selectMyActivity } from '../my-activity';

const ME = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
const ROWS = [
  { fullAddress: ME, type: 'Deposit', tokenAmount: 0.02 },
  { fullAddress: '0xsomeoneelse', type: 'Deposit', tokenAmount: 5 },
  { fullAddress: ME.toLowerCase(), type: 'Withdrawal', tokenAmount: 0.01 },
  { fullAddress: '0xsomeoneelse', type: 'Transfer', tokenAmount: 1 },
  { fullAddress: ME, type: 'Deposit', tokenAmount: 0.01 },
];

describe('selectMyActivity', () => {
  test('keeps only my rows, whatever their type', () => {
    const mine = selectMyActivity(ROWS, ME);
    expect(mine).toHaveLength(3);
    expect(mine.every((r) => r.fullAddress?.toLowerCase() === ME.toLowerCase())).toBe(true);
  });

  test('address comparison is case-insensitive both ways', () => {
    expect(selectMyActivity(ROWS, ME.toLowerCase())).toHaveLength(3);
    expect(selectMyActivity(ROWS, ME.toUpperCase())).toHaveLength(3);
  });

  test('preserves the feed order', () => {
    expect(selectMyActivity(ROWS, ME).map((r) => r.tokenAmount)).toEqual([0.02, 0.01, 0.01]);
  });

  test('NO address yields nothing. Never a fallback to everyone else', () => {
    // The important guarantee: a "mine" list must not quietly show strangers.
    expect(selectMyActivity(ROWS, null)).toEqual([]);
    expect(selectMyActivity(ROWS, undefined)).toEqual([]);
    expect(selectMyActivity(ROWS, '')).toEqual([]);
  });

  test('an address with no rows yields nothing', () => {
    expect(selectMyActivity(ROWS, '0xnobody')).toEqual([]);
  });

  test('empty / missing input is safe', () => {
    expect(selectMyActivity([], ME)).toEqual([]);
    expect(selectMyActivity(null, ME)).toEqual([]);
    expect(selectMyActivity([{}], ME)).toEqual([]);
  });
});

describe('countMyDeposits', () => {
  test('counts only my deposits', () => {
    expect(countMyDeposits(ROWS, ME)).toBe(2);
  });

  test('withdrawals and transfers are not deposits', () => {
    expect(countMyDeposits([{ fullAddress: ME, type: 'Withdrawal' }], ME)).toBe(0);
    expect(countMyDeposits([{ fullAddress: ME, type: 'Transfer' }], ME)).toBe(0);
  });

  test('does not count other people', () => {
    expect(countMyDeposits([{ fullAddress: '0xother', type: 'Deposit' }], ME)).toBe(0);
  });

  test('zero for no address / empty feed', () => {
    expect(countMyDeposits(ROWS, null)).toBe(0);
    expect(countMyDeposits([], ME)).toBe(0);
    expect(countMyDeposits(null, ME)).toBe(0);
  });

  test('counts a deposit regardless of amount (a 0 ETH deposit is still a deposit)', () => {
    // Distinct from the connect-landing balance test, which needs amount > 0.
    expect(countMyDeposits([{ fullAddress: ME, type: 'Deposit', tokenAmount: 0 }], ME)).toBe(1);
  });
});
