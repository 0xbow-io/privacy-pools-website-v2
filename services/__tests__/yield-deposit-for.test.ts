import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData as viemEncode, toFunctionSelector, type Hex } from 'viem';

// The SDK's ABIs are typed as its own consts; encode through a loose signature.
const encodeFunctionData = viemEncode as unknown as (p: { abi: unknown; functionName: string; args: unknown }) => Hex;
import {
  ENTRYPOINT_DEPOSIT_ABI as SDK_ENTRYPOINT_DEPOSIT_ABI,
  PP_ROUTER_ABI as SDK_PP_ROUTER_ABI,
  PP_ROUTER_DEPOSIT_ABI as SDK_PP_ROUTER_DEPOSIT_ABI,
  PP_ROUTER_DEPOSIT_NATIVE_ABI as SDK_PP_ROUTER_DEPOSIT_NATIVE_ABI,
} from '@privacy-pools-v2/sdk';

import {
  ENTRYPOINT_DEPOSIT_ABI,
  PP_ROUTER_QUOTE_ABI,
  toYieldDepositFor,
} from '@/services/yield-deposit-for';
import { isCapBelowQuoteError } from '@/services/yield-deposit-safety';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const ROUTER = '0x1111111111111111111111111111111111111111';
const SHARES = 9_876_543_210_000n;
const CAP = 1_234_567_890_000_000_000n;
const QUOTE = CAP - 1_000n;

// Every field a distinct non-zero value, and dynamic tails of odd length, so a
// dropped, reordered or mis-padded word cannot pass as a lucky zero.
const PROOF = {
  pA: [11n, 12n] as const,
  pB: [[21n, 22n], [23n, 24n]] as const,
  pC: [31n, 32n] as const,
  pubSignals: [41n, 42n, 43n, 44n] as const,
};
const NOTE_DATA = { hint: `0x${'ab'.repeat(32)}` as Hex, data: `0x${'cd'.repeat(37)}` as Hex };
const ASP_CIPHERTEXT = `0x${'ef'.repeat(71)}` as Hex;

/** Entrypoint.deposit calldata as the SDK's own ABI encodes it. */
function sdkEntrypointDeposit(): Hex {
  return encodeFunctionData({
    abi: SDK_ENTRYPOINT_DEPOSIT_ABI,
    functionName: 'deposit',
    args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT],
  });
}

const prepared = (overrides: Record<string, unknown> = {}) => ({
  pendingNote: { commitment: '0xc0', label: '0x1a' },
  depositTx: { to: '0x2222222222222222222222222222222222222222', data: sdkEntrypointDeposit(), value: '0x0' },
  ...overrides,
});
const inputs = (overrides: Partial<Parameters<typeof toYieldDepositFor>[1]> = {}) => ({
  router: ROUTER, shares: SHARES, spendCap: CAP, underlyingNeeded: QUOTE, native: false, ...overrides,
});

const selector = (abi: readonly unknown[], name: string) => {
  const f = (abi as { type: string; name: string; inputs: unknown[] }[]).find((x) => x.type === 'function' && x.name === name)!;
  return toFunctionSelector(f as never);
};

describe('toYieldDepositFor (DEV-451)', () => {
  test('our ABIs are the SDK\'s, so the bytes we sign are the ones it would', () => {
    expect(selector(ENTRYPOINT_DEPOSIT_ABI, 'deposit')).toBe(selector(SDK_ENTRYPOINT_DEPOSIT_ABI as never, 'deposit'));
    expect(selector(PP_ROUTER_QUOTE_ABI, 'quote')).toBe(selector(SDK_PP_ROUTER_ABI as never, 'quote'));
  });

  test('ERC-20 share: exactly the SDK\'s own depositExactShares for the same proof and cap', () => {
    const out = toYieldDepositFor(prepared(), inputs());
    const sdk = encodeFunctionData({
      abi: SDK_PP_ROUTER_DEPOSIT_ABI,
      functionName: 'depositExactShares',
      args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT, CAP] as never,
    });
    expect(out.depositTx.to).toBe(ROUTER);
    expect(out.depositTx.data).toBe(sdk);
    expect(BigInt(out.depositTx.value)).toBe(0n);
    expect(out.maxUnderlyingIn).toBe(CAP);
    expect(out.underlyingNeeded).toBe(QUOTE);
    expect(out.sharesValue).toBe(SHARES);
    expect(out.approvalTxs).toEqual([]);
    expect(out.pendingNote).toEqual({ commitment: '0xc0', label: '0x1a' });
  });

  test('native (ppETH): the SDK\'s depositExactSharesNative, funded with the cap', () => {
    const out = toYieldDepositFor(prepared(), inputs({ native: true }));
    const sdk = encodeFunctionData({
      abi: SDK_PP_ROUTER_DEPOSIT_NATIVE_ABI,
      functionName: 'depositExactSharesNative',
      args: [PROOF, NOTE_DATA, ASP_CIPHERTEXT] as never,
    });
    expect(out.depositTx.data).toBe(sdk);
    expect(BigInt(out.depositTx.value)).toBe(CAP);
  });

  test('fails closed on anything that is not the prepared share deposit', () => {
    expect(() => toYieldDepositFor(prepared({ depositTx: { to: ROUTER, data: '0xdeadbeef', value: '0x0' } }), inputs()))
      .toThrow('did not decode as Entrypoint.deposit');
    expect(() => toYieldDepositFor(prepared({ depositTx: { to: ROUTER, data: sdkEntrypointDeposit(), value: '0x1' } }), inputs()))
      .toThrow('carries a value');
    let capErr: unknown;
    try { toYieldDepositFor(prepared(), inputs({ underlyingNeeded: CAP + 1n })); } catch (e) { capErr = e; }
    // Recognised by the flow's rate-moved message, like the SDK's own error.
    expect(isCapBelowQuoteError(capErr)).toBe(true);
    expect(() => toYieldDepositFor(prepared(), inputs({ shares: 0n }))).toThrow('positive');
  });
});

describe('deposit flow wiring (DEV-451)', () => {
  const src = readFileSync(join(ROOT, 'components/deposit-modal-provider.tsx'), 'utf8');

  test('a yield route no longer refuses a recipient', () => {
    const guard = src.slice(src.indexOf('if (recipientMode) {'), src.indexOf("setLoadingMessage('Checking the recipient...')"));
    expect(guard).not.toContain('yieldOn');
  });

  test('the yield branch proves a depositFor of the SHARE token and re-targets it', () => {
    const start = src.indexOf('// FOR SOMEONE ELSE (DEV-451)');
    expect(start).toBeGreaterThan(-1);
    const branch = src.slice(start, src.indexOf('yieldNs.deposit.prepareYieldDeposit', start));
    expect(branch).toContain('session.prepareDepositFor(');
    expect(branch).toContain('tokenId: shareTokenId');
    expect(branch).toContain('toYieldDepositFor(');
  });

  test('the claim link names the share note, not the typed token and amount', () => {
    expect(src.match(/tokenId: claimNote\?\.tokenId \?\? tokenId/g)?.length).toBe(2);
    expect(src.match(/value: claimNote\?\.value \?\? amountHex/g)?.length).toBe(2);
  });
});
