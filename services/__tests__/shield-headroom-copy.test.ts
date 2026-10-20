import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shieldHeadroomRoomText } from '../shield-headroom-copy';

describe('shieldHeadroomRoomText', () => {
  test('a zero vetting fee on a native pay token names gas only (prod ppETH)', () => {
    expect(shieldHeadroomRoomText({ vettingFeeBps: 0, crossPayShield: false, payIsNative: true })).toBe('gas');
  });

  test('a non-zero vetting fee on a native pay token names both (staging ETH, 100 bps)', () => {
    expect(shieldHeadroomRoomText({ vettingFeeBps: 100, crossPayShield: false, payIsNative: true })).toBe(
      'the vetting fee and gas',
    );
  });

  test('a non-zero vetting fee on an ERC-20 pay token names the fee only', () => {
    expect(shieldHeadroomRoomText({ vettingFeeBps: 100, crossPayShield: false, payIsNative: false })).toBe(
      'the vetting fee',
    );
  });

  test('cross-pay shields never name the vetting fee, whatever the destination charges', () => {
    expect(shieldHeadroomRoomText({ vettingFeeBps: 100, crossPayShield: true, payIsNative: true })).toBe('gas');
    expect(shieldHeadroomRoomText({ vettingFeeBps: 100, crossPayShield: true, payIsNative: false })).toBe('gas');
  });

  test('an unknown fee is not named, and nothing named still falls back to gas', () => {
    expect(shieldHeadroomRoomText({ vettingFeeBps: null, crossPayShield: false, payIsNative: true })).toBe('gas');
    expect(shieldHeadroomRoomText({ vettingFeeBps: undefined, crossPayShield: false, payIsNative: false })).toBe('gas');
    expect(shieldHeadroomRoomText({ vettingFeeBps: 0, crossPayShield: false, payIsNative: false })).toBe('gas');
  });
});

describe('both shield surfaces build the clause from the shared helper', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  test('the hub Shield tab no longer hardcodes "the vetting fee and gas"', () => {
    const src = read('../../components/home/action-hub.tsx');
    expect(src).toContain('shieldHeadroomRoomText(');
    expect(src).not.toContain("'the vetting fee and gas'");
  });

  test('the deposit modal uses the same helper', () => {
    const src = read('../../components/deposit-modal-provider.tsx');
    expect(src).toContain('shieldHeadroomRoomText(');
    expect(src).not.toContain("? 'the vetting fee' : null");
  });
});
