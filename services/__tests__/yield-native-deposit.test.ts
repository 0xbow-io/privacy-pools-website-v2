import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';

import {
  DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR,
  DEPOSIT_EXACT_SHARES_SELECTOR,
  NativeYieldDepositError,
  PP_ROUTER_DEPOSIT_ABI,
  PP_ROUTER_DEPOSIT_NATIVE_ABI,
  selectorOf,
  toNativeYieldDeposit,
} from '@/services/yield-native-deposit';

const ROUTER = '0x1111111111111111111111111111111111111111';
const CAP = 1_234_567_890_000_000_000n;

// A proof shaped like the SDK's: every field a real bigint, nothing zero, so a
// dropped or reordered word shows up as a mismatch rather than as a lucky 0.
const PROOF = {
  pA: [11n, 12n] as const,
  pB: [[21n, 22n], [23n, 24n]] as const,
  pC: [31n, 32n] as const,
  pubSignals: [41n, 42n, 43n, 44n] as const,
};
const NOTE_DATA = {
  hint: `0x${'ab'.repeat(32)}` as Hex,
  // Odd length on purpose: a dynamic tail that needs padding is exactly where
  // naive byte surgery on the calldata goes wrong.
  data: `0x${'cd'.repeat(37)}` as Hex,
};
const ASP_CIPHERTEXT = `0x${'ef'.repeat(71)}` as Hex;

function erc20Calldata(cap: bigint = CAP): Hex {
  return encodeFunctionData({
    abi: PP_ROUTER_DEPOSIT_ABI,
    functionName: 'depositExactShares',
    args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT, cap] as never,
  });
}

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    depositTx: { to: ROUTER, data: erc20Calldata(), value: '0x0' },
    maxUnderlyingIn: CAP,
    ...overrides,
  } as never;
}

describe('toNativeYieldDeposit', () => {
  test('re-encodes the same three arguments as the payable entry', () => {
    const tx = toNativeYieldDeposit(prepared(), { router: ROUTER, spendCap: CAP });

    expect(tx.to).toBe(ROUTER);
    expect(selectorOf(tx.data)).toBe(DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR.toLowerCase());
    expect(BigInt(tx.value)).toBe(CAP);

    const decoded = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_NATIVE_ABI, data: tx.data });
    const args = decoded.args as readonly any[];
    expect(args).toHaveLength(3);
    expect(args[0].pA).toEqual([11n, 12n]);
    expect(args[0].pB).toEqual([[21n, 22n], [23n, 24n]]);
    expect(args[0].pC).toEqual([31n, 32n]);
    expect(args[0].pubSignals).toEqual([41n, 42n, 43n, 44n]);
    expect(args[1].hint.toLowerCase()).toBe(NOTE_DATA.hint);
    expect(args[1].data.toLowerCase()).toBe(NOTE_DATA.data);
    expect(args[2].toLowerCase()).toBe(ASP_CIPHERTEXT);
  });

  test('the two selectors differ, so a converted call can never be the ERC-20 one', () => {
    expect(DEPOSIT_EXACT_SHARES_SELECTOR).not.toBe(DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR);
  });

  // The bug this file exists to prevent: `noteData` and `aspCiphertext` are
  // dynamic, so their head words are OFFSETS. Lopping the trailing cap word off
  // the ERC-20 calldata leaves those offsets pointing 32 bytes past their tails.
  test('is not the ERC-20 calldata minus its last word', () => {
    const erc20 = erc20Calldata();
    const chopped = `${DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR}${erc20.slice(10, erc20.length - 64)}` as Hex;
    const tx = toNativeYieldDeposit(prepared(), { router: ROUTER, spendCap: CAP });
    expect(tx.data.toLowerCase()).not.toBe(chopped.toLowerCase());
    // And the chopped version really is broken, which is why we do not ship it.
    expect(() => decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_NATIVE_ABI, data: chopped })).toThrow();
  });

  test('refuses a router that is not the configured one', () => {
    expect(() => toNativeYieldDeposit(
      prepared(),
      { router: '0x2222222222222222222222222222222222222222', spendCap: CAP },
    )).toThrow(/not the configured router/);
  });

  test('every refusal is a NativeYieldDepositError, so callers can tell it from a wallet error', () => {
    try {
      toNativeYieldDeposit(prepared(), { router: '0x2222222222222222222222222222222222222222', spendCap: CAP });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(NativeYieldDepositError);
      expect((err as Error).name).toBe('NativeYieldDepositError');
    }
  });

  test('accepts the configured router in any case', () => {
    const tx = toNativeYieldDeposit(prepared(), { router: ROUTER.toUpperCase().replace('0X', '0x'), spendCap: CAP });
    expect(BigInt(tx.value)).toBe(CAP);
  });

  test('refuses calldata that is not depositExactShares', () => {
    expect(() => toNativeYieldDeposit(
      prepared({ depositTx: { to: ROUTER, data: '0xdeadbeef', value: '0x0' } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/not PPRouter.depositExactShares/);
  });

  test('refuses a cap that is not the one the caller sized', () => {
    expect(() => toNativeYieldDeposit(prepared(), { router: ROUTER, spendCap: CAP + 1n }))
      .toThrow(/not the sized spend cap/);
  });

  test('refuses when the calldata binds a different cap than the prepared field', () => {
    expect(() => toNativeYieldDeposit(
      prepared({ depositTx: { to: ROUTER, data: erc20Calldata(CAP - 1n), value: '0x0' } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/does not bind the quoted spend cap/);
  });

  test('refuses an ERC-20 call that already carries value', () => {
    expect(() => toNativeYieldDeposit(
      prepared({ depositTx: { to: ROUTER, data: erc20Calldata(), value: '0x1' } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/carries a value/);
  });

  test('refuses a prepared deposit with no transaction', () => {
    expect(() => toNativeYieldDeposit(prepared({ depositTx: undefined }), { router: ROUTER, spendCap: CAP }))
      .toThrow(/no deposit transaction/);
  });

  test('refuses truncated calldata that carries the right selector', () => {
    const truncated = `${DEPOSIT_EXACT_SHARES_SELECTOR}${'00'.repeat(64)}` as Hex;
    expect(() => toNativeYieldDeposit(
      prepared({ depositTx: { to: ROUTER, data: truncated, value: '0x0' } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/did not decode|did not survive/);
  });

  test('a zero cap is refused by the caller contract, not silently sent as a free deposit', () => {
    // Zero is a legitimate bigint but never a legitimate ceiling: the router
    // rejects a zero-value proof, and sending 0 wei would burn the proof.
    const tx = () => toNativeYieldDeposit(
      prepared({ depositTx: { to: ROUTER, data: erc20Calldata(0n), value: '0x0' }, maxUnderlyingIn: 0n }),
      { router: ROUTER, spendCap: 0n },
    );
    // It converts (the guard lives at the router), but the value it produces is
    // explicitly zero rather than a missing field, so a caller can check it.
    expect(BigInt(tx().value)).toBe(0n);
  });
});

// Since the SDK gained `nativeMode` it builds the payable entry itself. ppv2
// converted it a SECOND time, and the selector guard threw on its own router's
// native call — which is what broke every prod ppETH deposit
// ("Prepared yield deposit is not PPRouter.depositExactShares (selector
// 0x31c09bb4)", Nathaniel in #qa, 2026-09-21).
describe('toNativeYieldDeposit with an SDK that already built the native call', () => {
  function nativeCalldata(): Hex {
    return encodeFunctionData({
      abi: PP_ROUTER_DEPOSIT_NATIVE_ABI,
      functionName: 'depositExactSharesNative',
      args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT] as never,
    });
  }
  function preparedNative(overrides: Record<string, unknown> = {}) {
    return {
      depositTx: {
        to: ROUTER,
        data: nativeCalldata(),
        value: `0x${CAP.toString(16)}`,
        ...(overrides.depositTx as object ?? {}),
      },
      maxUnderlyingIn: CAP,
    } as never;
  }

  test('passes the SDK native call through untouched, funded with the cap', () => {
    const tx = toNativeYieldDeposit(preparedNative(), { router: ROUTER, spendCap: CAP });
    expect(selectorOf(tx.data)).toBe(DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR.toLowerCase());
    expect(tx.to).toBe(ROUTER);
    expect(BigInt(tx.value)).toBe(CAP);
    // The proof and note reach the chain exactly as the SDK bound them.
    expect(tx.data).toBe(nativeCalldata());
    const decoded = decodeFunctionData({ abi: PP_ROUTER_DEPOSIT_NATIVE_ABI, data: tx.data });
    expect(decoded.args?.length).toBe(3);
  });

  test('the real producer pads its value to 32 bytes; that parses to the same cap', () => {
    // The SDK emits bigintToHex(maxUnderlyingIn) — 64 hex chars, not minimal.
    const padded = `0x${CAP.toString(16).padStart(64, '0')}`;
    const tx = toNativeYieldDeposit(
      preparedNative({ depositTx: { value: padded } }),
      { router: ROUTER, spendCap: CAP },
    );
    expect(BigInt(tx.value)).toBe(CAP);
  });

  test('refuses a bare native selector with no arguments', () => {
    expect(() => toNativeYieldDeposit(
      preparedNative({ depositTx: { data: DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/did not decode as depositExactSharesNative/);
  });

  test('refuses native calldata truncated mid-argument', () => {
    const truncated = nativeCalldata().slice(0, -64) as Hex;
    expect(() => toNativeYieldDeposit(
      preparedNative({ depositTx: { data: truncated } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/did not decode as depositExactSharesNative/);
  });

  test('refuses a native selector followed by a zeroed body', () => {
    const zeroed = `${DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR}${'0'.repeat(128)}` as Hex;
    expect(() => toNativeYieldDeposit(
      preparedNative({ depositTx: { data: zeroed } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/did not decode as depositExactSharesNative/);
  });

  test('still refuses a native call funded with something other than the sized cap', () => {
    expect(() => toNativeYieldDeposit(
      preparedNative({ depositTx: { value: `0x${(CAP - 1n).toString(16)}` } }),
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/not the sized spend cap/);
  });

  test('still refuses a native call to an address that is not the configured router', () => {
    expect(() => toNativeYieldDeposit(
      preparedNative(),
      { router: '0x2222222222222222222222222222222222222222', spendCap: CAP },
    )).toThrow(/not the configured router/);
  });

  test('an unknown selector is still refused, and the message names both entries', () => {
    expect(() => toNativeYieldDeposit(
      { depositTx: { to: ROUTER, data: '0xdeadbeef', value: '0x0' }, maxUnderlyingIn: CAP } as never,
      { router: ROUTER, spendCap: CAP },
    )).toThrow(/depositExactShares or depositExactSharesNative/);
  });

  test('the ERC-20 path is unchanged: it is still re-encoded to the native entry', () => {
    const tx = toNativeYieldDeposit(prepared(), { router: ROUTER, spendCap: CAP });
    expect(selectorOf(tx.data)).toBe(DEPOSIT_EXACT_SHARES_NATIVE_SELECTOR.toLowerCase());
    expect(selectorOf(erc20Calldata())).toBe(DEPOSIT_EXACT_SHARES_SELECTOR.toLowerCase());
  });
});
