import { describe, expect, test } from 'bun:test';

import {
  assertReshieldRelayAmount,
  assertSwapApprovalTx,
  approvalAmountPlan,
  BRIDGE_POLL_INTERVAL_MS,
  describeSwapStatus,
  bridgeDeliveryOutcome,
  estimateReshieldForReview,
  formatAmountText,
  formatSwapDuration,
  formatUnitsText,
  floorToDisplayPrecision,
  fractionDigitsFor,
  hexToBigInt,
  isTerminalSwapStatus,
  normalizeUsd,
  ReshieldPreflightError,
  ReshieldRateMovedError,
  assertReshieldNoteWorthIt,
  affordableDepositAmount,
  unaffordableRefit,
  isStaleCrosschainQuote,
  RESHIELD_CROSSCHAIN_MAX_ATTEMPTS,
  ReshieldRevertedError,
  runReshield,
  RESHIELD_FEE_DRIFT_MAX_ATTEMPTS,
  runReshieldCrosschain,
  runSwapAndDeposit,
  shapeReshieldForDisplay,
  shapeSwapDepositForDisplay,
  SwapDepositPreflightError,
  toHex,
  UnexpectedSwapTxError,
  describeSwapSendsSoFar,
  liveAllowancesAfter,
  revokeLiveApprovals,
  swapDepositSlippage,
  swapDepositTargetLadder,
  type DestinationDepositSessionLike,
  type PreparedReshieldCrosschainQuoteLike,
  type PreparedReshieldQuoteLike,
  type PreparedSwapDepositLike,
  type ReshieldCrosschainEstimateLike,
  type ReshieldCrosschainSessionLike,
  type ReshieldEstimateLike,
  type ReshieldSessionLike,
  type ReshieldTransferSessionLike,
  type SwapDepositSessionLike,
  type SentApprovalRecord,
  type SubmitSwapTx,
} from '@/services/swap-flows';
import { submitWalletTransaction } from '@/services/wallet-submit';
import type { Address, Hash, Hex } from '@/services/sdk-types';
import { sdkYieldSizingRefusal } from './yield-sizing-fixture';

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
const USDT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
const RELAY = '0x2222222222222222222222222222222222222222' as Address;
const DUST = '0x3333333333333333333333333333333333333333' as Address;
// swapTarget and approvalAddress MUST be distinct fixtures. When both were
// RELAY, swapping the two echoes in the relay call passed the whole suite — and
// in production those are different LiFi addresses, so the swap fails the SDK's
// routing assert only AFTER the user has sat through proof generation.
// Mainnet LiFi, verbatim from lifinance/contracts deployments/mainnet.json.
// Flow 1 signs a real allowance, and the spender it may name is now checked
// against the published deployments, so these fixtures have to be the real
// addresses. Which is also the honest shape: ERC20Proxy is access-controlled
// and is what a route declares; the Executor is permissionless and is what one
// must never be allowed to name.
const LIFI_PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address;
const LIFI_EXECUTOR = '0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88' as Address;
const SWAP_TARGET = '0x4444444444444444444444444444444444444444' as Address;
const APPROVAL_ADDR = '0x5555555555555555555555555555555555555555' as Address;
const COMMITMENT = `0x${'1'.repeat(64)}` as Hash;
const h2 = (c: string) => `0x${c.repeat(64)}` as Hash;

/** The thrown value, so its CLASS can be asserted (bun's toThrow types only accept string|RegExp). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('formatUnitsText', () => {
  test('trims trailing zeros and keeps real precision', () => {
    expect(formatUnitsText(1_500_000n, 6)).toBe('1.5');
    expect(formatUnitsText(1_000_000n, 6)).toBe('1');
    expect(formatUnitsText(1n, 6)).toBe('0.000001');
  });

  test('does not round dust away to a bare 0', () => {
    // 6dp cap on an 18-decimal token: 1 wei is below the cap, so it shows as
    // 0 — acceptable — but a 1e-6 amount must survive.
    expect(formatUnitsText(10n ** 12n, 18)).toBe('0.000001');
  });

  test('handles zero and negatives', () => {
    expect(formatUnitsText(0n, 18)).toBe('0');
    expect(formatUnitsText(-1_500_000n, 6)).toBe('-1.5');
  });
});

describe('formatAmountText', () => {
  test('cuts a quote-sized 18-decimals amount to the review card precision', () => {
    expect(formatAmountText('0.02544593816859767', 18)).toBe('0.025445');
  });

  test('leaves a typed amount as typed', () => {
    expect(formatAmountText('0.021', 18)).toBe('0.021');
    expect(formatAmountText('1.50', 6)).toBe('1.5');
    expect(formatAmountText('2', 18)).toBe('2');
    expect(formatAmountText('.5', 18)).toBe('0.5');
  });

  test('keeps enough digits for a tiny amount', () => {
    expect(formatAmountText('0.0000032836', 18)).toBe('0.000003283');
  });

  test('falls back to 0 for empty or partial input', () => {
    expect(formatAmountText('', 18)).toBe('0');
    expect(formatAmountText('.', 18)).toBe('0');
    expect(formatAmountText('abc', 18)).toBe('0');
  });
});

describe('floorToDisplayPrecision', () => {
  test('floors an 18-decimals amount to six digits', () => {
    expect(floorToDisplayPrecision(1_458_521_728_955_757_879n, 18)).toBe(1_458_521_000_000_000_000n);
    expect(floorToDisplayPrecision(1_999_999_999_999_999_999n, 18)).toBe(1_999_999_000_000_000_000n);
  });

  test('keeps the significant digits of a tiny amount', () => {
    expect(floorToDisplayPrecision(3_283_699_999_999n, 18)).toBe(3_283_000_000_000n);
  });

  test('leaves 6-decimals and zero amounts untouched', () => {
    expect(floorToDisplayPrecision(1_458_522n, 6)).toBe(1_458_522n);
    expect(floorToDisplayPrecision(0n, 18)).toBe(0n);
  });
});

describe('fractionDigitsFor', () => {
  test('leaves 6-decimals assets exactly as they were', () => {
    expect(fractionDigitsFor(1_500_000n, 6)).toBe(6);
    expect(fractionDigitsFor(1n, 6)).toBe(6);
  });

  test('widens for an 18-decimals amount that 6 digits would flatten', () => {
    // The real reshield case: a 0.0000032836 ETH vetting fee shown as
    // "0.000003" at 6dp, and a smaller one shown as a flat "0".
    const vettingFee = 3_283_600_000_000n; // 0.0000032836 ETH
    expect(formatUnitsText(vettingFee, 18)).toBe('0.000003');
    expect(formatUnitsText(vettingFee, 18, fractionDigitsFor(vettingFee, 18))).toBe('0.000003283');
    const tiny = 4_100_000_000n; // 0.0000000041 ETH
    expect(formatUnitsText(tiny, 18)).toBe('0');
    expect(formatUnitsText(tiny, 18, fractionDigitsFor(tiny, 18))).toBe('0.0000000041');
  });

  test('never narrows below the six digits the rest of the app shows', () => {
    expect(fractionDigitsFor(1_500_000_000_000_000_000n, 18)).toBe(6); // 1.5 ETH
    expect(fractionDigitsFor(0n, 18)).toBe(6);
    expect(fractionDigitsFor(2_000_000_000_000_000_000n, 18)).toBe(6); // no fraction at all
  });
});

describe('hexToBigInt', () => {
  test('parses 0x hex, decimal strings and passes bigints through', () => {
    expect(hexToBigInt('0x64' as Hex)).toBe(100n);
    expect(hexToBigInt('100')).toBe(100n);
    expect(hexToBigInt(7n)).toBe(7n);
  });

  test('returns 0 rather than throwing on junk', () => {
    expect(hexToBigInt('not-a-number')).toBe(0n);
    expect(hexToBigInt('')).toBe(0n);
  });
});

describe('normalizeUsd', () => {
  // The SDK marks these optional and can send '0'; a "$0" beside a real
  // amount reads as broken, so anything non-positive becomes an omission.
  test('omits missing, empty, zero and unparseable values', () => {
    expect(normalizeUsd(undefined)).toBeNull();
    expect(normalizeUsd('')).toBeNull();
    expect(normalizeUsd('0')).toBeNull();
    expect(normalizeUsd('abc')).toBeNull();
  });

  test('formats a real figure and tolerates $ and commas', () => {
    expect(normalizeUsd('1234.5')).toBe('$1,234.5');
    expect(normalizeUsd('$1,234.50')).toBe('$1,234.5');
  });
});

describe('formatSwapDuration', () => {
  test('seconds under 90, minutes above', () => {
    expect(formatSwapDuration(45)).toBe('~45s');
    expect(formatSwapDuration(120)).toBe('~2m');
  });

  test('omits absent or nonsense estimates', () => {
    expect(formatSwapDuration(undefined)).toBeNull();
    expect(formatSwapDuration(0)).toBeNull();
    expect(formatSwapDuration(-5)).toBeNull();
  });
});

describe('shapeSwapDepositForDisplay (flow 1)', () => {
  const prepared: PreparedSwapDepositLike = {
    inputToken: USDC,
    estimatedInputAmount: '0x1e8480' as Hex, // 2_000_000 = 2 USDC
    inputAmountUSD: '2.00',
    depositAmountUSD: '1.99',
    approvalAddress: RELAY,
    approvalTx: null,
    transactionData: '0xdead' as Hex,
    transactionTo: RELAY,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };

  test('renders the swap-in / deposit-out pair with USD and duration', () => {
    const display = shapeSwapDepositForDisplay(
      prepared,
      { symbol: 'USDC', decimals: 6 },
      { symbol: 'USDT', decimals: 6, amountWei: 1_990_000n },
    );
    expect(display.inputAmountText).toBe('2 USDC');
    expect(display.inputAmountUSD).toBe('$2');
    expect(display.depositAmountText).toBe('1.99 USDT');
    expect(display.durationText).toBe('~45s');
  });

  // approvalTx non-null means a SEPARATE wallet tx has to go first; the UI
  // needs that as an explicit step, not a surprise second prompt.
  test('flags when the input token needs an approval first', () => {
    const withApproval = { ...prepared, approvalTx: { to: RELAY } };
    expect(
      shapeSwapDepositForDisplay(withApproval, { symbol: 'USDC', decimals: 6 }, { symbol: 'USDT', decimals: 6, amountWei: 1n })
        .needsApproval,
    ).toBe(true);
    expect(
      shapeSwapDepositForDisplay(prepared, { symbol: 'USDC', decimals: 6 }, { symbol: 'USDT', decimals: 6, amountWei: 1n })
        .needsApproval,
    ).toBe(false);
  });
});

/** approve(spender, value) calldata — the shape LiFi returns. */
function approveCalldata(spender: string, value = 1n): Hex {
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  return `0x095ea7b3${word(spender)}${word(value.toString(16))}` as Hex;
}

describe('assertSwapApprovalTx', () => {
  // This calldata comes from an external quote service, so it is validated
  // before it reaches a wallet prompt. An approve() to an unexpected spender is
  // exactly how a bad route would take an allowance.
  test('accepts an approve() to the token, for the named spender', () => {
    const tx = assertSwapApprovalTx({ to: USDC, data: approveCalldata(RELAY) }, USDC, RELAY);
    expect(tx.to).toBe(USDC);
  });

  test('refuses an approval aimed at a different contract than the input token', () => {
    expect(() => assertSwapApprovalTx({ to: USDT, data: approveCalldata(RELAY) }, USDC, RELAY)).toThrow(
      /instead of the token being spent/,
    );
  });

  test('refuses a spender the route did not name', () => {
    expect(() => assertSwapApprovalTx({ to: USDC, data: approveCalldata(DUST) }, USDC, RELAY)).toThrow(
      /Refusing to sign/,
    );
    expect(caught(() => assertSwapApprovalTx({ to: USDC, data: approveCalldata(DUST) }, USDC, RELAY)))
      .toBeInstanceOf(UnexpectedSwapTxError);
  });

  test('refuses calldata that is not approve(), and malformed/truncated payloads', () => {
    expect(() => assertSwapApprovalTx({ to: USDC, data: '0xdeadbeef' as Hex }, USDC, RELAY)).toThrow(/not an approve/);
    expect(() => assertSwapApprovalTx({ to: USDC, data: '0x095ea7b300' as Hex }, USDC, RELAY)).toThrow(/truncated/);
    expect(() => assertSwapApprovalTx(null, USDC, RELAY)).toThrow(/malformed/);
    expect(() => assertSwapApprovalTx({ to: USDC }, USDC, RELAY)).toThrow(/malformed/);
  });

  test('is case-insensitive about addresses', () => {
    expect(() =>
      assertSwapApprovalTx({ to: USDC.toLowerCase(), data: approveCalldata(RELAY.toUpperCase()) }, USDC, RELAY),
    ).not.toThrow();
  });
});

describe('runSwapAndDeposit (flow 1 orchestration)', () => {
  const base: PreparedSwapDepositLike = {
    inputToken: USDC,
    estimatedInputAmount: '0x1e8480' as Hex,
    approvalAddress: LIFI_PROXY,
    approvalTx: null,
    transactionData: '0xdead' as Hex,
    transactionTo: LIFI_DIAMOND,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };

  const makeSession = (prepared: PreparedSwapDepositLike) => {
    const seen: Record<string, unknown> = {};
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async (p) => {
        seen.prepare = p;
        return prepared;
      },
    };
    return { session, seen };
  };

  const okSubmit = async () => ({ txHash: '0xfeed' as Hex, success: true });

  test('prepares with the DEPOSIT amount as the target, then submits the swap tx', async () => {
    const steps: string[] = [];
    const submitted: { tx: unknown; kind: string }[] = [];
    const { session, seen } = makeSession(base);
    const result = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1_990_000n,
      submit: async (tx, kind) => {
        submitted.push({ tx, kind });
        return { txHash: '0xfeed' as Hex, success: true };
      },
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['prepare', 'submit']);
    expect(seen.prepare).toEqual({
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmount: toHex(1_990_000n),
    });
    // Exactly ONE transaction when no approval is needed, and it carries the
    // route's own target/calldata/value — not the approval address.
    expect(submitted).toEqual([{ kind: 'swap', tx: { to: LIFI_DIAMOND, data: '0xdead', value: '0x0' } }]);
    expect(result.txHash).toBe('0xfeed');
  });

  test('a native deposit the SDK cannot compose is refused in plain words, before any prompt', async () => {
    const refusal = Object.assign(new Error('A swap into a native-coin deposit (0xeeee, 1) cannot be built'), {
      name: 'NativeSwapDepositUnavailable',
    });
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => { throw refusal; } };
    const submitted: unknown[] = [];
    const err = await runSwapAndDeposit(session, {
      depositChainId: 56,
      fromChainId: 56,
      inputToken: USDT,
      depositToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address,
      depositAmountWei: 25_585_229_785_757_545n,
      submit: async (tx) => {
        submitted.push(tx);
        return { txHash: '0xfeed' as Hex, success: true };
      },
      display: { input: { symbol: 'USDT', decimals: 18 }, deposit: { symbol: 'BNB', decimals: 18 } },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SwapDepositPreflightError);
    expect((err as Error).message).toBe(
      'This route cannot pay for the BNB deposit right now. Nothing was sent. Try again in a moment, pay with another token, or shield BNB directly.',
    );
    expect(submitted).toEqual([]);
  });

  describe('a same-chain native deposit is only signed after a full dry run', () => {
    const depositAmountWei = 1_000_000n;
    const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
    const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955' as Address;
    const run = (extra: Partial<Parameters<typeof runSwapAndDeposit>[1]>) => {
      const submitted: { tx: Parameters<SubmitSwapTx>[0]; kind: Parameters<SubmitSwapTx>[1] }[] = [];
      const { session } = makeSession({
        ...base,
        inputToken: USDT_BSC,
        approvalAddress: '0x5741A7FfE7c39Ca175546a54985fA79211290b51' as Address,
        transactionTo: '0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D' as Address,
        approvalTx: null,
        msgValue: toHex(depositAmountWei),
      });
      const result = runSwapAndDeposit(session, {
        depositChainId: 56,
        fromChainId: 56,
        inputToken: USDT_BSC,
        depositToken: BNB,
        depositAmountWei,
        submit: async (tx, kind) => {
          submitted.push({ tx, kind });
          return { txHash: '0xfeed' as Hex, success: true };
        },
        simulate: async () => ({ ok: true }),
        ...extra,
      }).then(() => null, (e: unknown) => e);
      return { result, submitted };
    };

    test('refuses when the caller cannot simulate with the allowance in place', async () => {
      const { result, submitted } = run({});
      const err = await result;
      expect(err).toBeInstanceOf(SwapDepositPreflightError);
      expect((err as Error).message).toBe('This deposit could not be checked before signing. Nothing was sent. Try again in a moment.');
      expect(submitted).toEqual([]);
    });

    test('refuses instead of approving first when the override is unsupported', async () => {
      const { result, submitted } = run({ simulateWithAllowance: async () => ({ ok: false, supported: false }) });
      expect(await result).toBeInstanceOf(SwapDepositPreflightError);
      expect(submitted).toEqual([]);
    });

    test('goes ahead once the dry run passes', async () => {
      const simulated: Parameters<SubmitSwapTx>[0][] = [];
      const { result, submitted } = run({
        simulateWithAllowance: async (tx) => {
          simulated.push(tx);
          return { ok: true, supported: true };
        },
      });
      expect(await result).toBeNull();
      const expectedTx = {
        to: '0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D',
        data: '0xdead',
        value: '0xf4240',
      };
      expect(simulated).toEqual([expectedTx]);
      expect(submitted).toEqual([{ kind: 'swap', tx: expectedTx }]);
    });
  });

  test('any other prepare failure passes through unchanged', async () => {
    const quoteDown = new Error('LiFi 503');
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => { throw quoteDown; } };
    const err = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1_990_000n,
      submit: okSubmit,
    }).then(() => null, (e: unknown) => e);
    expect(err).toBe(quoteDown);
  });

  test('DEV-433: the swap\'s broadcast is reported before its receipt, with the route and amount', async () => {
    const order: string[] = [];
    const { session } = makeSession(base);
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1_990_000n,
      submit: async (_tx, kind, onBroadcast) => {
        order.push(`submit:${kind}`);
        onBroadcast?.('0xfeed' as Hex);
        order.push('receipt');
        return { txHash: '0xfeed' as Hex, success: true };
      },
      onSwapBroadcast: (hash, prepared, amountWei) => {
        order.push(`broadcast:${hash}:${amountWei}:${prepared.transactionTo}`);
      },
    });
    expect(order).toEqual(['submit:swap', `broadcast:0xfeed:1990000:${LIFI_DIAMOND}`, 'receipt']);
  });

  test('DEV-433: a throwing broadcast hook does not fail the swap', async () => {
    const { session } = makeSession(base);
    const result = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1_990_000n,
      submit: async (_tx, _kind, onBroadcast) => { onBroadcast?.('0xfeed' as Hex); return { txHash: '0xfeed' as Hex, success: true }; },
      onSwapBroadcast: () => { throw new Error('display hook blew up'); },
    });
    expect(result.txHash).toBe('0xfeed');
  });

  test('sends a validated approval FIRST, then the swap. Two txs in order', async () => {
    const steps: string[] = [];
    const kinds: string[] = [];
    const approvalTx = { to: USDC, data: approveCalldata(LIFI_PROXY) };
    const { session } = makeSession({ ...base, approvalTx });
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async (_tx, kind) => {
        kinds.push(kind);
        return { txHash: '0xfeed' as Hex, success: true };
      },
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['prepare', 'approve', 'submit']);
    expect(kinds).toEqual(['approval', 'swap']);
  });

  test('submits every planned approval in order: the approve(0) reset before the real one (SDK 4567778d, USDT)', async () => {
    // The SDK now plans approve(0) then approve(amount) for a token holding a
    // non-zero, insufficient allowance, and echoes the LAST one as approvalTx.
    // Submitting only approvalTx skipped the reset and reverted the second
    // USDT swap-deposit. Both must go out, reset first, then the swap.
    const reset = { to: USDC, data: approveCalldata(LIFI_PROXY, 0n) };
    const grant = { to: USDC, data: approveCalldata(LIFI_PROXY, 5n) };
    const submitted: { kind: string; data: string }[] = [];
    const { session } = makeSession({ ...base, approvalTx: grant, approvalTxs: [reset, grant] });
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async (tx, kind) => {
        submitted.push({ kind, data: tx.data });
        return { txHash: '0xfeed' as Hex, success: true };
      },
    });
    expect(submitted.map((s) => s.kind)).toEqual(['approval', 'approval', 'swap']);
    expect(submitted[0]!.data).toBe(reset.data);
    expect(submitted[1]!.data).toBe(grant.data);
    // A failed reset stops before the grant and the swap.
    const failing = makeSession({ ...base, approvalTx: grant, approvalTxs: [reset, grant] }).session;
    const kinds: string[] = [];
    await expect(runSwapAndDeposit(failing, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async (_tx, kind) => { kinds.push(kind); return { txHash: '0xfeed' as Hex, success: false }; },
    })).rejects.toThrow(/approval did not go through/);
    expect(kinds.every((k) => k === 'approval')).toBe(true);
    expect(kinds.length).toBeGreaterThan(0);
  });

  // THE regression. Between 2026-08-17 and 2026-09-21 this flow read a route
  // whose declared approvalAddress differed from transactionTo, threw the
  // declared address away, and approved transactionTo instead. On mainnet that
  // is the LiFi Executor, whose entry point anyone may call with instructions
  // of their choosing, and a bot spent the resulting allowance one block after
  // it was granted.
  //
  // The declared address wins, always. If that turns out to be the wrong one
  // for the route, the route does not work, and a route that does not work is
  // the acceptable outcome here.
  test('approves the DECLARED approvalAddress, never the swap target, when the two differ', async () => {
    const submitted: { to: string; data: string }[] = [];
    const { session } = makeSession({
      ...base,
      approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) },
      approvalAddress: LIFI_PROXY,
      transactionTo: LIFI_EXECUTOR,
    });
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async (tx, kind) => {
        if (kind === 'approval') submitted.push({ to: tx.to, data: tx.data });
        return { txHash: '0xfeed' as Hex, success: true };
      },
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].to.toLowerCase()).toBe(USDC.toLowerCase());
    const spenderWord = submitted[0].data.slice(10, 74).toLowerCase();
    expect(spenderWord).toBe(LIFI_PROXY.slice(2).toLowerCase().padStart(64, '0'));
    expect(spenderWord).not.toBe(LIFI_EXECUTOR.slice(2).toLowerCase().padStart(64, '0'));
    expect(submitted[0].data.toLowerCase()).not.toContain(LIFI_EXECUTOR.slice(2).toLowerCase());
  });

  // A route may only name a spender LiFi publishes for the chain. Anything
  // else, including the Executor it wants the transaction sent to, stops the
  // flow with nothing signed. The flow never substitutes one of its own.
  test('refuses a spender that is not one of the chain\'s published approval addresses', async () => {
    const STRANGER = '0x7777777777777777777777777777777777777777' as Address;
    for (const declared of [STRANGER, LIFI_EXECUTOR]) {
      const submitted: string[] = [];
      const { session } = makeSession({
        ...base,
        approvalAddress: declared,
        approvalTx: { to: USDC, data: approveCalldata(declared) },
        transactionTo: LIFI_EXECUTOR,
      });
      let thrown: unknown;
      try {
        await runSwapAndDeposit(session, {
          depositChainId: 11155111,
          fromChainId: 1,
          inputToken: USDC,
          depositToken: USDT,
          depositAmountWei: 1n,
          submit: async (_tx, kind) => {
            submitted.push(kind);
            return { txHash: '0xfeed' as Hex, success: true };
          },
        });
      } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(UnexpectedSwapTxError);
      expect((thrown as Error).message).toMatch(/nothing was sent/i);
      expect((thrown as Error).message).toMatch(/deposit the token directly/i);
      expect((thrown as Error).message).not.toContain('—');
      expect(submitted).toEqual([]);
    }
  });

  // A quote with no approvalAddress at all used to fall through to
  // transactionTo, by way of the SDK's `?? transactionRequest.to`. Here it is
  // simply refused: an absent answer is not permission to pick one.
  test('refuses a quote that declares no approvalAddress rather than inventing one', async () => {
    const submitted: string[] = [];
    const { session } = makeSession({
      ...base,
      approvalAddress: undefined as unknown as Address,
      approvalTx: { to: USDC, data: approveCalldata(LIFI_EXECUTOR) },
      transactionTo: LIFI_EXECUTOR,
    });
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: async (_tx, kind) => {
          submitted.push(kind);
          return { txHash: '0xfeed' as Hex, success: true };
        },
      });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(UnexpectedSwapTxError);
    expect((thrown as Error).message).toMatch(/nothing was sent/i);
    expect(submitted).toEqual([]);
  });

  // The pre-approval simulation (PR #87) has to prove the route against the
  // allowance the wallet will actually grant. Handing the override to the swap
  // target as well would prove a route that cannot run.
  test('simulates with the allowance granted to the declared spender alone', async () => {
    const grants: string[][] = [];
    const { session } = makeSession({
      ...base,
      approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) },
      approvalAddress: LIFI_PROXY,
      transactionTo: LIFI_EXECUTOR,
    });
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
      simulateWithAllowance: async (_tx, grant) => {
        grants.push(grant.spenders.map((s) => s.toLowerCase()));
        return { ok: true, supported: true };
      },
    });
    expect(grants).toEqual([[LIFI_PROXY.toLowerCase()]]);
  });

  // A swap submitted on a rejected or reverted approval is a guaranteed revert
  // the user pays gas for.
  test('a reverted approval aborts before the swap is submitted', async () => {
    const kinds: string[] = [];
    const { session } = makeSession({ ...base, approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) } });
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: async (_tx, kind) => {
          kinds.push(kind);
          return { txHash: '0xfeed' as Hex, success: kind !== 'approval' };
        },
      }),
    ).rejects.toBeInstanceOf(SwapDepositPreflightError);
    expect(kinds).toEqual(['approval']);
  });

  // Wallet rejection surfaces as a throw, not a false — the abort must hold
  // for both.
  test('a wallet rejection during approval aborts before the swap', async () => {
    const kinds: string[] = [];
    const { session } = makeSession({ ...base, approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) } });
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: async (_tx, kind) => {
          kinds.push(kind);
          if (kind === 'approval') throw new Error('User rejected the request');
          return { txHash: '0xfeed' as Hex, success: true };
        },
      }),
    ).rejects.toThrow(/User rejected/);
    expect(kinds).toEqual(['approval']);
  });

  test('asks for consent with the route figures before the first wallet prompt', async () => {
    const order: string[] = [];
    const { session } = makeSession({ ...base, approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) } });
    let shown: string | null = null;
    await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1_990_000n,
      display: { input: { symbol: 'USDC', decimals: 6 }, deposit: { symbol: 'USDT', decimals: 6 } },
      confirmPrepared: async (d) => {
        order.push('consent');
        shown = d.inputAmountText;
        return true;
      },
      submit: async (_tx, kind) => {
        order.push(kind);
        return { txHash: '0xfeed' as Hex, success: true };
      },
    });
    // Before the approval prompt, not after.
    expect(order).toEqual(['consent', 'approval', 'swap']);
    // The estimated INPUT — the amount the user never typed and the wallet is
    // about to ask for.
    expect(shown).toBe('2 USDC');
  });

  test('declining consent sends nothing at all', async () => {
    let submits = 0;
    const { session } = makeSession({ ...base, approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY) } });
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        display: { input: { symbol: 'USDC', decimals: 6 }, deposit: { symbol: 'USDT', decimals: 6 } },
        confirmPrepared: async () => false,
        submit: async () => { submits += 1; return { txHash: '0xfeed' as Hex, success: true }; },
      }),
    ).rejects.toBeInstanceOf(SwapDepositPreflightError);
    expect(submits).toBe(0);
  });

  test('a bad approval is refused before it can reach the wallet', async () => {
    let submits = 0;
    // Approval pointing at the wrong spender — must never be signed.
    const { session } = makeSession({ ...base, approvalTx: { to: USDC, data: approveCalldata(DUST) } });
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: async () => {
          submits += 1;
          return { txHash: '0xfeed' as Hex, success: true };
        },
      }),
    ).rejects.toBeInstanceOf(UnexpectedSwapTxError);
    expect(submits).toBe(0);
  });

  // The swap and the deposit are one atomic transaction: a revert means nothing
  // was spent AND nothing was shielded, so it must not report success.
  test('a reverted swap tx is reported as a failure, not a deposit', async () => {
    const { session } = makeSession(base);
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: async () => ({ txHash: '0xfeed' as Hex, success: false }),
      }),
    ).rejects.toThrow(/reverted on-chain/);
  });

  test('refuses a route with no swap transaction', async () => {
    const { session } = makeSession({ ...base, transactionData: '' as Hex });
    await expect(
      runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC,
        depositToken: USDT,
        depositAmountWei: 1n,
        submit: okSubmit,
      }),
    ).rejects.toBeInstanceOf(UnexpectedSwapTxError);
  });

  test('refuses a same-token "swap" and a zero amount, before any SDK call', async () => {
    let touched = false;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => {
        touched = true;
        return base;
      },
    };
    const shared = { fromChainId: 1, depositChainId: 11155111, submit: okSubmit };
    await expect(
      runSwapAndDeposit(session, { ...shared, inputToken: USDC, depositToken: USDC, depositAmountWei: 1n }),
    ).rejects.toThrow(/different token/);
    await expect(
      runSwapAndDeposit(session, { ...shared, inputToken: USDC, depositToken: USDT, depositAmountWei: 0n }),
    ).rejects.toThrow(/greater than zero/);
    expect(touched).toBe(false);
  });
});

describe('runSwapAndDeposit for someone else (DEV-489)', () => {
  const base: PreparedSwapDepositLike = {
    inputToken: USDC,
    estimatedInputAmount: '0x1e8480' as Hex,
    approvalAddress: LIFI_PROXY,
    approvalTx: null,
    transactionData: '0xdead' as Hex,
    transactionTo: LIFI_DIAMOND,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
    pendingNote: { commitment: COMMITMENT, isOwned: false },
  };
  const RECIPIENT = { discoveryData: { evmAddress: '0x1234567890abcdef1234567890abcdef12345678' as Address } };
  const run = (
    session: SwapDepositSessionLike,
    over: Partial<Parameters<typeof runSwapAndDeposit>[1]> = {},
  ) => runSwapAndDeposit(session, {
    depositChainId: 11155111,
    fromChainId: 1,
    inputToken: USDC,
    depositToken: USDT,
    depositAmountWei: 1_000_000n,
    submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
    ...over,
  });

  test('the recipient reaches EVERY prepare, a smaller retry target included', async () => {
    const seen: unknown[] = [];
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async (p) => { seen.push(p); return base; },
    };
    let sims = 0;
    await run(session, {
      recipient: RECIPIENT,
      simulateWithAllowance: async () => ({ ok: sims++ > 0, supported: true }),
    });
    expect(seen.length).toBe(2);
    for (const p of seen) expect((p as { recipient?: unknown }).recipient).toEqual(RECIPIENT);
  });

  test('without a recipient the prepare request carries no recipient key', async () => {
    const seen: Record<string, unknown>[] = [];
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async (p) => { seen.push(p as Record<string, unknown>); return base; },
    };
    await run(session);
    expect(Object.keys(seen[0]).sort()).toEqual(['depositAmount', 'depositToken', 'fromChainId', 'inputToken']);
  });

  test('beforeSwapSubmit sees the final route after the approval and before the swap prompt', async () => {
    const order: string[] = [];
    const approvalTx = { to: USDC, data: approveCalldata(LIFI_PROXY) };
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => ({ ...base, approvalTx }),
    };
    await run(session, {
      recipient: RECIPIENT,
      submit: async (_tx, kind) => { order.push(kind); return { txHash: '0xfeed' as Hex, success: true }; },
      beforeSwapSubmit: async (prepared, amountWei) => {
        order.push(`before:${prepared.pendingNote?.commitment}:${amountWei}`);
      },
    });
    expect(order).toEqual(['approval', `before:${COMMITMENT}:1000000`, 'swap']);
  });

  test('a throwing beforeSwapSubmit stops the swap from ever being submitted', async () => {
    const kinds: string[] = [];
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => base };
    await expect(run(session, {
      recipient: RECIPIENT,
      submit: async (_tx, kind) => { kinds.push(kind); return { txHash: '0xfeed' as Hex, success: true }; },
      beforeSwapSubmit: async () => { throw new Error('Cancelled before the swap was signed.'); },
    })).rejects.toThrow('Cancelled before the swap was signed.');
    expect(kinds).toEqual([]);
  });
});

describe('shapeReshieldForDisplay (flow 3)', () => {
  const estimate: ReshieldEstimateLike = {
    feeAmount: '0x2710', // 10_000 = 0.01 USDC
    netSwapAmount: '0xf4240', // 1_000_000 = 1 USDC
    estimatedOutput: '0xf3e58', // 999_000
    estimatedMinOutput: '0xf1b30', // 990_000
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8', // 1_000
    totalDepositCost: '0xf4240',
  };

  test('separates gross, fee, net and both output figures', () => {
    const d = shapeReshieldForDisplay(estimate, 1_010_000n, { symbol: 'USDC', decimals: 6 }, { symbol: 'USDT', decimals: 6 });
    expect(d.grossText).toBe('1.01 USDC');
    expect(d.feeText).toBe('0.01 USDC');
    expect(d.netText).toBe('1 USDC');
    expect(d.estimatedOutputText).toBe('0.999 USDT');
    expect(d.minOutputText).toBe('0.99 USDT');
    expect(d.vettingFeeText).toBe('0.001 USDT');
  });

  // Pat's screen: 1 USDC in, ETH out. Two token identities and two decimal
  // scales on one review, which is exactly where a line borrows the other
  // leg's symbol. The relayer fee comes off the POOL EXIT so it is in the
  // input token; the pool vetting fee is charged by Entrypoint.deposit on the
  // asset being DEPOSITED, which here is the swap OUTPUT, so it is in ETH.
  test('keeps each leg in its own token when the two differ', () => {
    const d = shapeReshieldForDisplay(
      {
        feeAmount: '185485', // 0.185485 USDC — 900k gas repriced in the withdrawn asset
        netSwapAmount: '814515', // 0.814515 USDC
        estimatedOutput: '336000000000000', // 0.000336 ETH
        estimatedMinOutput: '335000000000000', // 0.000335 ETH
        noteValue: toHex(328_000_000_000_000n), // 0.000328 ETH
        vettingFee: '3283600000000', // 0.0000032836 ETH
        totalDepositCost: '331283600000000',
      },
      1_000_000n,
      { symbol: 'USDC', decimals: 6 },
      { symbol: 'ETH', decimals: 18 },
    );
    expect(d.grossText).toBe('1 USDC');
    expect(d.feeText).toBe('0.185485 USDC');
    expect(d.netText).toBe('0.814515 USDC');
    expect(d.estimatedOutputText).toBe('0.000336 ETH');
    expect(d.minOutputText).toBe('0.000335 ETH');
    // Was "0.000003 ETH" at the flat 6dp cap.
    expect(d.vettingFeeText).toBe('0.000003283 ETH');
    expect(d.newNoteText).toBe('0.000328 ETH');
    expect(d.newNoteValueWei).toBe(328_000_000_000_000n);
  });
});

// Guide §10's first gotcha: prepare* takes GROSS, relay* takes quote.netAmount.
// Getting it backwards fails after proving with an opaque mismatch, so this is
// asserted before anything is submitted.
describe('assertReshieldRelayAmount', () => {
  /** net + fee = 1_010_000 (the gross), signed commitment agreeing. */
  const goodQuote = (over: Record<string, unknown> = {}): PreparedReshieldQuoteLike => ({
    selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: toHex(10_000n) } },
    swapCalldata: '0xcafe' as Hex,
    feeAmount: toHex(10_000n),
    netAmount: toHex(1_000_000n),
    swapTarget: SWAP_TARGET,
    approvalAddress: APPROVAL_ADDR,
    dustRecipient: DUST,
    ...over,
  });

  test('accepts a quote whose net + fee equals the reviewed gross', () => {
    expect(() => assertReshieldRelayAmount(goodQuote(), 1_010_000n)).not.toThrow();
  });

  test('refuses a zero net amount as a preflight error', () => {
    // Typed as ReshieldPreflightError specifically: the UI keys off that class
    // to say "nothing was signed or spent" rather than showing a generic
    // failure that implies funds may have moved.
    const q = goodQuote({ netAmount: '0x0' as Hex });
    expect(() => assertReshieldRelayAmount(q, 1_000n)).toThrow(/no net amount/);
    expect(caught(() => assertReshieldRelayAmount(q, 1_000n))).toBeInstanceOf(ReshieldPreflightError);
  });

  // `net <= gross` is NOT a sufficient invariant. This is the case that proves
  // it: gross 1_010_000, fee 10_000, net 1_010_000 — the net is not above the
  // gross, and the relay's own check (amountSent === net + fee) passes against
  // a commitment signed for 1_020_000, so the proof would spend MORE than the
  // user reviewed. Only the equality catches it.
  test('refuses net === gross with a nonzero fee (over-spend within a <= bound)', () => {
    const q = goodQuote({
      netAmount: toHex(1_010_000n),
      selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_020_000n) }, feeAmount: toHex(10_000n) } },
    });
    expect(() => assertReshieldRelayAmount(q, 1_010_000n)).toThrow(/but you asked to reshield/);
  });

  test('refuses a net amount above the gross. The gross-for-net mix-up', () => {
    expect(() => assertReshieldRelayAmount(goodQuote({ netAmount: toHex(2_000_000n) }), 1_010_000n))
      .toThrow(/but you asked to reshield/);
  });

  // The top-level figures are the relayer's report; feeCommitment is what it
  // SIGNED and what the contract enforces. A disagreement between them is the
  // exact shape of a quote that spends more than it admits to.
  test('refuses when the SIGNED commitment spends more than the reviewed gross', () => {
    const q = goodQuote({
      selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_020_000n) }, feeAmount: toHex(10_000n) } },
    });
    expect(() => assertReshieldRelayAmount(q, 1_010_000n)).toThrow(/signed relayer commitment spends/);
  });

  test('refuses when the signed fee disagrees with the reported fee', () => {
    const q = goodQuote({
      selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: toHex(99n) } },
    });
    expect(() => assertReshieldRelayAmount(q, 1_010_000n)).toThrow(/disagrees with the fee it signed/);
  });

  test('still validates when the quote carries no signed commitment fields', () => {
    expect(() => assertReshieldRelayAmount(goodQuote({ selectedQuote: {} }), 1_010_000n)).not.toThrow();
    expect(() => assertReshieldRelayAmount(goodQuote({ selectedQuote: null }), 1_010_000n)).not.toThrow();
  });
});

// Every number on the reshield Review screen comes from here, including the two
// guards that stop a user confirming a reshield that can only revert.
describe('estimateReshieldForReview (flow 3 review)', () => {
  const estimate: ReshieldEstimateLike = {
    feeAmount: '0x2710',
    netSwapAmount: '0xf4240',
    estimatedOutput: '0xf3e58',
    estimatedMinOutput: '0xf1b30',
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8',
    totalDepositCost: '0xf4240',
  };
  const usdc = { symbol: 'USDC', decimals: 6 };
  const usdt = { symbol: 'USDT', decimals: 6 };
  const session = (over: Partial<ReshieldEstimateLike> = {}) => ({
    estimateReshieldAmount: async () => ({ ...estimate, ...over }),
  });
  const args = {
    chainId: 11155111,
    relayerInfo: {},
    grossWei: 1_010_000n,
    inputToken: USDC,
    outputToken: USDT,
    input: usdc,
    output: usdt,
  };

  test('passes the gross as hex and shapes every Review figure', async () => {
    let seen: unknown = null;
    const { display, estimate: got } = await estimateReshieldForReview(
      { estimateReshieldAmount: async (p) => { seen = p; return estimate; } },
      { ...args, slippage: 0.01 },
    );
    expect(seen).toMatchObject({ amount: toHex(1_010_000n), tokenId: USDC, outputToken: USDT, slippage: 0.01 });
    expect(got.noteValue).toBe(estimate.noteValue);
    expect(display.grossText).toBe('1.01 USDC');
    expect(display.netText).toBe('1 USDC');
    expect(display.minOutputText).toBe('0.99 USDT');
  });

  test('refuses a zero/negative gross and a same-asset reshield before calling the SDK', async () => {
    let touched = false;
    const probe = { estimateReshieldAmount: async () => { touched = true; return estimate; } };
    await expect(estimateReshieldForReview(probe, { ...args, grossWei: 0n })).rejects.toThrow(/greater than zero/);
    await expect(estimateReshieldForReview(probe, { ...args, outputToken: USDC })).rejects.toThrow(/different asset/);
    expect(touched).toBe(false);
  });

  test('refuses an estimate with nothing to redeposit', async () => {
    await expect(estimateReshieldForReview(session({ noteValue: '0x0' as Hex }), args))
      .rejects.toBeInstanceOf(ReshieldPreflightError);
    await expect(estimateReshieldForReview(session({ noteValue: '0x0' as Hex }), args))
      .rejects.toThrow(/nothing to redeposit/);
  });

  // A fee at or above the gross leaves the swap with nothing; without this the
  // user reaches Confirm and burns a proof on a guaranteed revert.
  test('refuses when the relayer fee swallows the whole amount', async () => {
    await expect(estimateReshieldForReview(session({ netSwapAmount: '0x0' }), args))
      .rejects.toThrow(/at least the whole amount/);
  });
});

describe('runReshield (flow 3 orchestration)', () => {
  const estimate: ReshieldEstimateLike = {
    feeAmount: '0x2710',
    netSwapAmount: '0xf4240',
    estimatedOutput: '0xf3e58',
    estimatedMinOutput: '0xf1b30',
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8',
    totalDepositCost: '0xf4240',
  };
  const quote: PreparedReshieldQuoteLike = {
    // net (0xf4240 = 1_000_000) + fee (0x2710 = 10_000) === the 1_010_000 gross
    // used throughout, and the signed commitment says the same.
    selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: '0x2710' } },
    swapCalldata: '0xcafe' as Hex,
    feeAmount: '0x2710',
    netAmount: '0xf4240' as Hex,
    swapTarget: SWAP_TARGET,
    approvalAddress: APPROVAL_ADDR,
    dustRecipient: DUST,
  };
  /** The prepareDeposit result, whose pendingNote must survive to the caller. */
  const DEPOSIT_RESULT = { pendingNote: { isOwned: true, commitment: h2('a'), value: '0xf3e58' as Hex } };

  const makeSession = (over: Partial<ReshieldSessionLike> = {}) => {
    const calls: Record<string, unknown> = {};
    const session: ReshieldSessionLike = {
      estimateReshieldAmount: async (p) => {
        calls.estimate = p;
        return estimate;
      },
      prepareDeposit: async (p) => {
        calls.deposit = p;
        return DEPOSIT_RESULT;
      },
      prepareReshieldQuote: async (p) => {
        calls.quote = p;
        return quote;
      },
      relayReshield: async (p) => {
        calls.relay = p;
        // Real SDK receipts carry the mined status; the old status-less
        // fixture masked the accept-unknown-status bug (codex round 1).
        return { txHash: '0xabc' as Hex, status: true };
      },
      ...over,
    };
    return { session, calls };
  };

  test('runs estimate → prepareDeposit → quote → relay in order', async () => {
    const steps: string[] = [];
    const { session, calls } = makeSession();
    const result = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: { id: 'r' },
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
      onStep: (s) => steps.push(s),
    });

    expect(steps).toEqual(['estimate', 'proving', 'quote', 'relay']);
    expect(result.receipt.txHash).toBe('0xabc');
    // The deposit proof is sized off the estimate's noteValue and built for
    // the OUTPUT token — building it for the input token is the subtle
    // mistake this ordering exists to prevent.
    expect(calls.deposit).toEqual({ tokenId: USDT, value: estimate.noteValue });
  });

  test('prepare gets the GROSS and relay gets the quote NET', async () => {
    const { session, calls } = makeSession();
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect((calls.estimate as { amount: string }).amount).toBe(toHex(1_010_000n));
    expect((calls.quote as { amount: string }).amount).toBe(toHex(1_010_000n));
    expect((calls.relay as { amount: string }).amount).toBe(quote.netAmount);
  });

  // Guide §10: these are validated against what the relayer signed, so
  // dropping them is not a cosmetic omission.
  test('echoes swapTarget, approvalAddress and dustRecipient into the relay', async () => {
    const { session, calls } = makeSession();
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    // Distinct fixtures, so swapping the two echoes fails here.
    expect(calls.relay).toMatchObject({
      swapTarget: SWAP_TARGET,
      approvalAddress: APPROVAL_ADDR,
      dustRecipient: DUST,
      selectedQuote: quote.selectedQuote,
      swapCalldata: quote.swapCalldata,
    });
  });

  // DEV-538: a swap routed through the LiFi Executor carries the composed
  // call's pinned amounts, and the SDK refuses a relay that does not echo them
  // ("relay params must echo PreparedReshieldQuote.executorCall").
  test('echoes the prepared executorCall into the relay unchanged', async () => {
    const executorCall = { inputAmount: '14460000', callValue: '1', minOutput: '5' };
    const { session, calls } = makeSession({
      prepareReshieldQuote: async () => ({ ...quote, executorCall }),
    });
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect((calls.relay as { executorCall?: unknown }).executorCall).toBe(executorCall);
  });

  test('a quote without an executorCall sends none', async () => {
    const { session, calls } = makeSession();
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect('executorCall' in (calls.relay as object)).toBe(false);
  });

  // The entire four-step ordering exists to get the deposit proof INTO the
  // quote: without it the LiFi calldata contains no redeposit, the swap output
  // is never re-shielded, and the funds strand on the RelaySwaps processor. The
  // step-order assertion alone does not prove the proof travelled.
  test('the deposit proof and its cost reach prepareReshieldQuote', async () => {
    const { session, calls } = makeSession();
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect(calls.quote).toMatchObject({
      amount: toHex(1_010_000n),
      // The exact object prepareDeposit returned, not merely something truthy.
      depositResult: DEPOSIT_RESULT,
      totalDepositCost: estimate.totalDepositCost,
      tokenId: USDC,
      outputToken: USDT,
    });
  });

  // relayReshield persists the spent inputs and the input-asset change, but NOT
  // the note the embedded deposit created. Dropping it here means the old
  // balance disappears and the reshielded one is invisible until a full
  // discovery run recovers it.
  test('returns the new output note so the caller can register it', async () => {
    const { session } = makeSession();
    const result = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect(result.pendingNote).toEqual(DEPOSIT_RESULT.pendingNote);
  });

  // Confirm re-estimates, so the reviewed figure has to bind execution or it was
  // decoration.
  test('refuses to execute when the fresh estimate is worse than the reviewed one', async () => {
    let proved = false;
    const { session } = makeSession({
      estimateReshieldAmount: async () => ({ ...estimate, noteValue: toHex(900_000n) }),
      prepareDeposit: async () => { proved = true; return DEPOSIT_RESULT; },
    });
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1_010_000n,
        inputToken: USDC,
        outputToken: USDT,
        inputCommitments: [COMMITMENT],
        minNoteValueWei: 999_000n,
      }),
    ).rejects.toThrow(/rate moved against you/);
    expect(proved).toBe(false);
  });

  test('proceeds when the fresh estimate is at least as good as reviewed', async () => {
    const { session } = makeSession();
    const result = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
      // The fixture's noteValue is 0xf3e58 = 999_000.
      minNoteValueWei: 999_000n,
    });
    expect(result.receipt.txHash).toBe('0xabc');
  });

  test('refuses with no notes selected, before any SDK call', async () => {
    let touched = false;
    const { session } = makeSession({
      estimateReshieldAmount: async () => {
        touched = true;
        return estimate;
      },
    });
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1n,
        inputToken: USDC,
        outputToken: USDT,
        inputCommitments: [],
      }),
    ).rejects.toBeInstanceOf(ReshieldPreflightError);
    expect(touched).toBe(false);
  });

  test('refuses reshielding an asset into itself', async () => {
    const { session } = makeSession();
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1n,
        inputToken: USDC,
        outputToken: USDC,
        inputCommitments: [COMMITMENT],
      }),
    ).rejects.toThrow(/different asset/);
  });

  // A swap that nets nothing would build a zero-value deposit proof and fail
  // deep in the relay; catching it after the estimate is far cheaper.
  test('refuses when the estimate leaves nothing to redeposit', async () => {
    const { session } = makeSession({
      estimateReshieldAmount: async () => ({ ...estimate, noteValue: '0x0' as Hex }),
    });
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1_000n,
        inputToken: USDC,
        outputToken: USDT,
        inputCommitments: [COMMITMENT],
      }),
    ).rejects.toThrow(/nothing to redeposit/);
  });

  // The SDK's TxReceipt.status is the MINED outcome — a reverted relay resolves
  // normally. Reporting success would tell the user their asset changed when
  // their original note is untouched.
  test('a reverted relay is a failure carrying the tx hash, not a success', async () => {
    const { session } = makeSession({
      relayReshield: async () => ({ txHash: '0xbad' as Hex, status: false }),
    });
    const err = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReshieldRevertedError);
    expect((err as ReshieldRevertedError).txHash).toBe('0xbad');
    expect((err as Error).message).toMatch(/were NOT spent/);
  });

  // codex round 1: only literal `status: true` is success (the project rule).
  // An absent/undefined status used to pass as "reshielded" without any
  // confirmation — the happy-path fixture masked it.
  test('a relay with an UNKNOWN status is refused, not treated as success', async () => {
    const { session } = makeSession({
      relayReshield: async () => ({ txHash: '0xmaybe' as Hex }),
    });
    const err = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReshieldRevertedError);
    expect((err as Error).message).toMatch(/could not be confirmed/);
  });

  // DEV-433: the hash reaches the caller before the receipt, through the SDK's
  // onBroadcast (#481), with the quote the record needs.
  test('onBroadcast hands the relayed hash and quote over before the receipt resolves', async () => {
    const order: string[] = [];
    const { session } = makeSession({
      relayReshield: async (p) => {
        p.onBroadcast?.('0xb0' as Hex);
        order.push('receipt');
        return { txHash: '0xb0' as Hex, status: true };
      },
    });
    let seen: { hash: Hex; fee: string } | null = null;
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
      onBroadcast: (hash, { quote: q }) => { order.push('broadcast'); seen = { hash, fee: q.feeAmount }; },
    });
    expect(order).toEqual(['broadcast', 'receipt']);
    expect(seen).toEqual({ hash: '0xb0' as Hex, fee: '0x2710' });
  });

  test('no onBroadcast key reaches the SDK when the caller passes none', async () => {
    const { session, calls } = makeSession();
    await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect('onBroadcast' in (calls.relay as Record<string, unknown>)).toBe(false);
  });

  test('a successful relay (status true) resolves', async () => {
    const { session } = makeSession({
      relayReshield: async () => ({ txHash: '0xgood' as Hex, status: true }),
    });
    const result = await runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    expect(result.receipt.txHash).toBe('0xgood');
  });

  // Confirm re-estimates from scratch, so a fee spike between Review and
  // Confirm must be caught HERE too — Review having been fine proves nothing.
  test('re-checks the fee at confirm time, not just at review', async () => {
    let proved = false;
    const { session } = makeSession({
      estimateReshieldAmount: async () => ({ ...estimate, netSwapAmount: '0x0' }),
      prepareDeposit: async () => { proved = true; return DEPOSIT_RESULT; },
    });
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1_010_000n,
        inputToken: USDC,
        outputToken: USDT,
        inputCommitments: [COMMITMENT],
      }),
    ).rejects.toThrow(/covers the whole amount/);
    // And it aborts before spending seconds on a proof.
    expect(proved).toBe(false);
  });

  test('a bad net amount from the relayer stops the relay', async () => {
    let relayed = false;
    const { session } = makeSession({
      prepareReshieldQuote: async () => ({ ...quote, netAmount: '0xffffffff' as Hex }),
      relayReshield: async () => {
        relayed = true;
        return {};
      },
    });
    await expect(
      runReshield(session, {
        chainId: 11155111,
        relayerInfo: {},
        grossWei: 1_000n,
        inputToken: USDC,
        outputToken: USDT,
        inputCommitments: [COMMITMENT],
      }),
    ).rejects.toBeInstanceOf(ReshieldPreflightError);
    expect(relayed).toBe(false);
  });
});

describe('runReshieldCrosschain (flow 4 re-sizing, v2-monorepo#437)', () => {
  const estimate: ReshieldCrosschainEstimateLike = {
    feeAmount: '0x2710',
    netSwapAmount: '0xf4240',
    estimatedOutput: '0xf3e58',
    estimatedMinOutput: '0xf1b30',
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8',
    totalDepositCost: '0xf4240',
  };
  const quote: PreparedReshieldCrosschainQuoteLike = {
    selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: '0x2710' } },
    swapCalldata: '0xcafe' as Hex,
    feeAmount: '0x2710',
    netAmount: '0xf4240' as Hex,
    swapTarget: SWAP_TARGET,
    approvalAddress: APPROVAL_ADDR,
    dustRecipient: DUST,
  };
  const sdkError = (name: string, message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { name }, extra);
  const unaffordable = () => sdkError(
    'DestinationDepositUnaffordable',
    "Destination deposit cost 1000000 exceeds the bridge's guaranteed delivery 990000",
    { affordableNoteValue: '0xf0000' },
  );

  /** `prepareOutcomes[i]` answers the i-th prepare: a quote, or an error to throw. */
  const makeSessions = (prepareOutcomes: (Error | null)[], estimates: ReshieldCrosschainEstimateLike[] = []) => {
    const calls = { estimate: [] as Record<string, unknown>[], deposit: [] as unknown[], quote: [] as Record<string, unknown>[], relay: [] as Record<string, unknown>[] };
    let depositCount = 0;
    const source: ReshieldCrosschainSessionLike = {
      estimateReshieldCrosschainAmount: async (p) => {
        calls.estimate.push(p as Record<string, unknown>);
        return estimates[calls.estimate.length - 1] ?? estimate;
      },
      prepareReshieldCrosschainQuote: async (p) => {
        calls.quote.push(p as Record<string, unknown>);
        const outcome = prepareOutcomes[calls.quote.length - 1] ?? null;
        if (outcome) throw outcome;
        return quote;
      },
      relayReshieldCrosschain: async (p) => {
        calls.relay.push(p as Record<string, unknown>);
        return { txHash: '0xabc' as Hex, status: true };
      },
    };
    const destination: DestinationDepositSessionLike = {
      prepareDeposit: async (p) => {
        calls.deposit.push(p);
        depositCount += 1;
        return { pendingNote: { isOwned: true, commitment: h2(String(depositCount)), value: p.value } };
      },
    };
    return { source, destination, calls };
  };
  const run = (sessions: ReturnType<typeof makeSessions>, extra: Partial<Parameters<typeof runReshieldCrosschain>[2]> = {}) =>
    runReshieldCrosschain(sessions.source, sessions.destination, {
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      toChainId: 11155111,
      fallbackAddress: DUST,
      inputCommitments: [COMMITMENT],
      ...extra,
    });

  test('a guarantee that drifted under the deposit is sized again from a fresh estimate and proof', async () => {
    const sessions = makeSessions([unaffordable(), null]);
    const steps: string[] = [];
    const result = await run(sessions, { onStep: (step, detail) => steps.push(detail ? `${step}:${detail}` : step) });
    expect(sessions.calls.estimate.length).toBe(2);
    expect(sessions.calls.deposit.length).toBe(2);
    expect(sessions.calls.quote.length).toBe(2);
    expect(sessions.calls.relay.length).toBe(1);
    expect(steps).toEqual(['estimate', 'proving', 'quote', 'estimate:resize', 'proving', 'quote', 'relay']);
    // The note that is relayed and returned is the SECOND proof's, never the
    // discarded one.
    expect(result.pendingNote?.commitment).toBe(h2('2'));
    expect((sessions.calls.relay[0]!.depositNote as { commitment: Hash }).commitment).toBe(h2('2'));
  });

  test('onBroadcast passes the source hash, the quote and the relayed destination note', async () => {
    const sessions = makeSessions([null]);
    const base = sessions.source.relayReshieldCrosschain;
    sessions.source.relayReshieldCrosschain = async (p) => {
      p.onBroadcast?.('0xc0' as Hex);
      return base(p);
    };
    let seen: unknown = null;
    await run(sessions, { onBroadcast: (hash, ctx) => { seen = { hash, fee: ctx.quote.feeAmount, note: ctx.pendingNote?.commitment }; } });
    expect(seen).toEqual({ hash: '0xc0', fee: '0x2710', note: h2('1') });
  });

  // DEV-507: the re-vendored SDK refuses a cross-chain call unless it echoes the
  // session's destination chain TYPE next to the id ("Destination chain
  // undefined:1 does not match ..."). A fake that never checks hid it, so this one
  // applies the SDK's own rule to all three calls.
  test('estimate, quote and relay all name the destination chain type, as the SDK requires', async () => {
    const SESSION_DESTINATION = { id: 11155111, type: 'evm' };
    const enforce = (p: Record<string, unknown>) => {
      if (p.toChainId !== SESSION_DESTINATION.id || p.toChainType !== SESSION_DESTINATION.type) {
        throw new Error(`Destination chain ${String(p.toChainType)}:${String(p.toChainId)} does not match the configured destination`);
      }
    };
    const sessions = makeSessions([null]);
    const source = sessions.source;
    const checked: ReshieldCrosschainSessionLike = {
      estimateReshieldCrosschainAmount: async (p) => { enforce(p as Record<string, unknown>); return source.estimateReshieldCrosschainAmount(p); },
      prepareReshieldCrosschainQuote: async (p) => { enforce(p as Record<string, unknown>); return source.prepareReshieldCrosschainQuote(p); },
      relayReshieldCrosschain: async (p) => { enforce(p as Record<string, unknown>); return source.relayReshieldCrosschain(p); },
    };
    const result = await run({ ...sessions, source: checked });
    expect(result.receipt.txHash).toBe('0xabc');
    expect(sessions.calls.estimate[0]!.toChainType).toBe('evm');
    expect(sessions.calls.quote[0]!.toChainType).toBe('evm');
    expect(sessions.calls.relay[0]!.toChainType).toBe('evm');
  });

  // Mike, prod 2026-10-07: an Ethereum-destination reshield carries a B2 gas swap
  // the relayer signs into the routing. The SDK's relay re-checks it against what
  // it is passed (`gasSwapCalldata ?? "0x"`), so dropping it between prepare and
  // relay refused every such swap. This fake applies that same rule.
  test('an Ethereum-destination quote hands its B2 gas swap through to relay', async () => {
    const signedGasSwap = '0x5ae401dc00ff' as Hex;
    const b2Quote: PreparedReshieldCrosschainQuoteLike = {
      ...quote,
      swapValue: 123_000_000_000_000n,
      gasSwapMaxInput: 4_000_000n,
      gasSwapCalldata: signedGasSwap,
    };
    const sessions = makeSessions([null]);
    const checked: ReshieldCrosschainSessionLike = {
      ...sessions.source,
      prepareReshieldCrosschainQuote: async (p) => { await sessions.source.prepareReshieldCrosschainQuote(p); return b2Quote; },
      relayReshieldCrosschain: async (p) => {
        if (((p.gasSwapCalldata as Hex | undefined) ?? '0x').toLowerCase() !== signedGasSwap) {
          throw new Error("Invalid transact params: Relayer swapCommitment gasSwapCalldata does not match the caller's gas-swap calldata");
        }
        return sessions.source.relayReshieldCrosschain(p);
      },
    };
    await run({ ...sessions, source: checked });
    expect(sessions.calls.relay[0]).toMatchObject({
      swapValue: 123_000_000_000_000n,
      gasSwapMaxInput: 4_000_000n,
      gasSwapCalldata: signedGasSwap,
    });
  });

  test('a quote with no B2 leg relays without one', async () => {
    const sessions = makeSessions([null]);
    await run(sessions);
    expect('gasSwapCalldata' in sessions.calls.relay[0]!).toBe(false);
    expect('swapValue' in sessions.calls.relay[0]!).toBe(false);
  });

  test('every cross-chain quote denies fly, the estimate and the prepare alike', async () => {
    const sessions = makeSessions([null]);
    await run(sessions);
    expect(sessions.calls.estimate[0]!.denyExchanges).toContain('fly');
    expect(sessions.calls.quote[0]!.denyExchanges).toContain('fly');
  });

  test('a refusal that is final for this input is not retried', async () => {
    const native = sdkError('NativeDestinationDepositUnsupported', 'A cross-chain deposit into the native coin cannot succeed');
    const sessions = makeSessions([native]);
    await expect(run(sessions)).rejects.toBe(native);
    expect(sessions.calls.estimate.length).toBe(1);
    expect(sessions.calls.relay.length).toBe(0);
  });

  test('gives up after the attempt budget and reports the last refusal', async () => {
    const sessions = makeSessions(Array.from({ length: RESHIELD_CROSSCHAIN_MAX_ATTEMPTS + 2 }, unaffordable));
    await expect(run(sessions)).rejects.toMatchObject({ name: 'DestinationDepositUnaffordable' });
    expect(sessions.calls.quote.length).toBe(RESHIELD_CROSSCHAIN_MAX_ATTEMPTS);
    expect(sessions.calls.relay.length).toBe(0);
  });

  test('the next attempt is built at the note value the SDK said fits, not a fresh too-high estimate', async () => {
    // The 2026-09-27 BSC -> Ethereum case: the fresh estimate sizes from the same
    // preview route every time, so without the cap all four attempts failed alike.
    const refusal = sdkError(
      'DestinationDepositUnaffordable',
      "Destination deposit cost 1000000 exceeds the bridge's guaranteed delivery 900000",
      { affordableNoteValue: '0xd9490', destBudget: '900000' },
    );
    const sessions = makeSessions([refusal, null]);
    await run(sessions);
    const secondNote = BigInt((sessions.calls.deposit[1] as { value: bigint | string }).value);
    expect(secondNote).toBe(0xd9490n);
    // The deposit cost handed to prepare is the guarantee minus the SDK's 1% margin.
    expect(BigInt(sessions.calls.quote[1]!.totalDepositCost as string)).toBe((900_000n * 9_900n) / 10_000n);
    expect(sessions.calls.relay.length).toBe(1);
  });

  test('unaffordableRefit reads the carried fields, falls back to the message, and ignores anything else', () => {
    expect(unaffordableRefit(sdkError('DestinationDepositUnaffordable', 'x', { affordableNoteValue: '0x10', destBudget: '1000' })))
      .toEqual({ noteValue: 16n, totalDepositCost: 990n });
    expect(unaffordableRefit(sdkError('DestinationDepositUnaffordable', "exceeds the bridge's guaranteed delivery 2000 —", { affordableNoteValue: '0x10' })))
      .toEqual({ noteValue: 16n, totalDepositCost: 1980n });
    expect(unaffordableRefit(sdkError('DestinationDepositUnaffordable', 'no figure', { affordableNoteValue: '0x10' }))).toBeNull();
    expect(unaffordableRefit(new Error('other'))).toBeNull();
  });

  test('the consent floor is asked again on the re-sized estimate', async () => {
    const smaller = { ...estimate, noteValue: '0xe0000' as Hex };
    const sessions = makeSessions([unaffordable(), null], [estimate, smaller]);
    await expect(run(sessions, { minNoteValueWei: 0xf0000n })).rejects.toBeInstanceOf(ReshieldRateMovedError);
    expect(sessions.calls.deposit.length).toBe(1);
    expect(sessions.calls.relay.length).toBe(0);
  });
});

describe('isStaleCrosschainQuote', () => {
  const named = (name: string, message = '') => Object.assign(new Error(message), { name });
  test('the four stale-quote refusals are retryable', () => {
    expect(isStaleCrosschainQuote(named('DestinationDepositUnaffordable'))).toBe(true);
    expect(isStaleCrosschainQuote(new Error('LiFi needs 100 input but only 90 available after fee. Reduce the amount or retry.'))).toBe(true);
    expect(isStaleCrosschainQuote(new Error('router quote 5 exceeds the spendable budget 4: the rate or fee moved while sizing, size again'))).toBe(true);
    expect(isStaleCrosschainQuote(named('SwapQuoteFailed', 'LiFi quote failed: 422 Market conditions have changed'))).toBe(true);
  });
  test('anything else is final', () => {
    expect(isStaleCrosschainQuote(named('NativeDestinationDepositUnsupported'))).toBe(false);
    expect(isStaleCrosschainQuote(named('DepositBelowMinimum'))).toBe(false);
    expect(isStaleCrosschainQuote(new Error('422'))).toBe(false);
    expect(isStaleCrosschainQuote('DestinationDepositUnaffordable')).toBe(false);
  });
});

describe('runSwapAndDeposit refit (cross-chain, v2-monorepo#437)', () => {
  const prepared: PreparedSwapDepositLike = {
    inputToken: USDC,
    estimatedInputAmount: '0x1e8480' as Hex,
    approvalAddress: LIFI_PROXY,
    approvalTx: null,
    transactionData: '0xdead' as Hex,
    transactionTo: LIFI_DIAMOND,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };
  const unaffordable = () => Object.assign(new Error('exceeds the guaranteed delivery'), {
    name: 'DestinationDepositUnaffordable',
    affordableNoteValue: '0xf4240',
  });

  test('prepares once more at the amount that fits, and that is the amount the user confirms', async () => {
    const amounts: string[] = [];
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async (p) => {
        amounts.push(p.depositAmount);
        if (amounts.length === 1) throw unaffordable();
        return prepared;
      },
    };
    let confirmedText: string | null = null;
    const result = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 2_000_000n,
      submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
      display: { input: { symbol: 'USDC', decimals: 6 }, deposit: { symbol: 'USDT', decimals: 6 } },
      confirmPrepared: async (display) => {
        confirmedText = display.depositAmountText;
        return true;
      },
    });
    expect(amounts).toEqual([toHex(2_000_000n), toHex(1_000_000n)]);
    expect(confirmedText).toBe(`${formatUnitsText(1_000_000n, 6)} USDT`);
    // The caller's pending row reads this, so it shows what was deposited.
    expect(result.depositAmountWei).toBe(1_000_000n);
  });

  test('a same-chain deposit is never refit: the refusal is not about a bridge', async () => {
    const err = unaffordable();
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => { throw err; } };
    await expect(runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 11155111,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 2_000_000n,
      submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
    })).rejects.toBe(err);
  });

  test('affordableDepositAmount reads only the SDK refusal', () => {
    expect(affordableDepositAmount(unaffordable())).toBe(1_000_000n);
    expect(affordableDepositAmount(new Error('other'))).toBeNull();
    expect(affordableDepositAmount(Object.assign(new Error('x'), { name: 'DestinationDepositUnaffordable', affordableNoteValue: 'nope' }))).toBeNull();
  });
});


describe('describeSwapStatus (guide §9)', () => {
  test('DONE and FAILED are terminal', () => {
    expect(isTerminalSwapStatus({ status: 'DONE' })).toBe(true);
    expect(isTerminalSwapStatus({ status: 'FAILED' })).toBe(true);
    expect(isTerminalSwapStatus({ status: 'PENDING' })).toBe(false);
    expect(isTerminalSwapStatus(null)).toBe(false);
  });

  // NOT_FOUND just means LiFi has not indexed the source tx yet — normal for
  // the first seconds. Reading it as a failure would alarm users mid-bridge.
  test('NOT_FOUND reads as pending, not failure', () => {
    expect(describeSwapStatus({ status: 'NOT_FOUND' }).tone).toBe('pending');
  });

  test('surfaces the substatus message on failure', () => {
    expect(describeSwapStatus({ status: 'FAILED', substatusMessage: 'refunded' }).text).toMatch(/refunded/);
  });

  test('names the destination wait explicitly', () => {
    expect(describeSwapStatus({ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' }).text).toMatch(
      /destination/,
    );
  });

  test('polls within the guide’s 5-10s window', () => {
    expect(BRIDGE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(BRIDGE_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("bridge DONE is not the same as deposited (Pat's ETH → OP shield, 2026-08-29)", () => {
  test('DONE with substatus PARTIAL means the deposit call failed and funds went to the wallet', () => {
    const status = { status: 'DONE' as const, substatus: 'PARTIAL', substatusMessage: 'Some of the received tokens are not the requested destination tokens.' };
    expect(bridgeDeliveryOutcome(status)).toBe('recovered');
    const d = describeSwapStatus(status);
    expect(d.tone).toBe('failed');
    expect(d.text).toContain('did not execute');
    expect(d.text).toContain('destination chain');
  });

  test('DONE with REFUNDED names the source chain', () => {
    expect(bridgeDeliveryOutcome({ status: 'DONE', substatus: 'REFUNDED' })).toBe('recovered');
    expect(describeSwapStatus({ status: 'DONE', substatus: 'REFUNDED' }).text).toContain('source chain');
  });

  test('a plain DONE (or COMPLETED) is the happy path', () => {
    expect(bridgeDeliveryOutcome({ status: 'DONE' })).toBe('deposited');
    expect(bridgeDeliveryOutcome({ status: 'DONE', substatus: 'COMPLETED' })).toBe('deposited');
    expect(describeSwapStatus({ status: 'DONE', substatus: 'COMPLETED' }).tone).toBe('done');
  });

  test('FAILED and in-flight states map as before', () => {
    expect(bridgeDeliveryOutcome({ status: 'FAILED' })).toBe('failed');
    expect(bridgeDeliveryOutcome({ status: 'PENDING' })).toBe('pending');
    expect(bridgeDeliveryOutcome({ status: 'NOT_FOUND' })).toBe('pending');
    expect(bridgeDeliveryOutcome(null)).toBe('pending');
  });
});

describe('assertReshieldRelayAmount refusals read as amounts, not base units', () => {
  test('with units, the gross mismatch names the token with decimals applied', () => {
    const q = { netAmount: '0xf4240', feeAmount: '0x2710', selectedQuote: null } as never; // 1_000_000 + 10_000 = 1_010_000
    let msg = '';
    try { assertReshieldRelayAmount(q, 2_000_000n, { decimals: 6, symbol: 'USDC' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('1.01 USDC');
    expect(msg).toContain('2 USDC');
    expect(msg).not.toMatch(/\b1010000\b/);
  });

  test('without units the raw figures are still there (unchanged contract for callers that have none)', () => {
    const q = { netAmount: '0xf4240', feeAmount: '0x2710', selectedQuote: null } as never;
    let msg = '';
    try { assertReshieldRelayAmount(q, 2_000_000n); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('1010000');
  });
});


describe('assertReshieldNoteWorthIt (flow 4 sizing)', () => {
  const eth = { symbol: 'ETH', decimals: 18 };
  test('passes when the note keeps most of the swap output', () => {
    expect(() => assertReshieldNoteWorthIt({ noteValue: '0x1bc16d674ec80000', estimatedMinOutput: '0x1c6bf52634000000', totalDepositCost: '0x2386f26fc10000' }, eth, 'Ethereum')).not.toThrow();
  });
  test('refuses a sliver (the SDK unit-cap bug: note of 2 wei from a 0.00788 ETH output)', () => {
    // min output 0.00788 ETH, note 2 wei
    expect(() => assertReshieldNoteWorthIt({ noteValue: '0x2', estimatedMinOutput: '0x1c0e65aa00ccf5', totalDepositCost: '0x1bb6c2b0e6c000' }, eth, 'Ethereum'))
      .toThrow(/cannot be sized on Ethereum: the estimate would leave 0\.000000000000000002 ETH of the 0\.007897 ETH swap output/);
  });
  test('is inert when the route has no output at all (other guards own that)', () => {
    expect(() => assertReshieldNoteWorthIt({ noteValue: '0x0', estimatedMinOutput: '0x0' }, eth)).not.toThrow();
  });
});

// ─── "Nothing was sent." must never be a lie ──────────────────────────────
//
// QA, 2026-09-21: a swap-deposit failed with "…Nothing was sent." AFTER the
// input-token approval had been signed and mined. The user read it, saw a
// transaction in their wallet history, and concluded the app had taken their
// USDC and denied it ("RUGGEEDDDDDDD"). The approval only grants an allowance,
// so nothing was in fact debited, but the copy made that impossible to
// believe. Past the first submit the error must report what DID go out.
describe('post-submit errors cannot claim nothing was sent', () => {
  const USDC_IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const OUT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
  // The published mainnet ERC20Proxy: the spender a real route declares, and
  // the only kind this flow will sign for.
  const EXEC = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const pay = { symbol: 'USDC', decimals: 6 };

  const approve = (spender: Address, amount: bigint) =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex;

  const prepared = (): PreparedSwapDepositLike => ({
    inputToken: USDC_IN,
    estimatedInputAmount: toHex(5_000_000n),
    approvalAddress: EXEC,
    approvalTx: { to: USDC_IN, data: approve(EXEC, 5_000_000n) },
    transactionData: '0xdead' as Hex,
    transactionTo: EXEC,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  });

  test('describeSwapSendsSoFar says "Nothing was sent." only while nothing has been', () => {
    expect(describeSwapSendsSoFar([], pay)).toBe('Nothing was sent.');
    const after = describeSwapSendsSoFar(
      [{ txHash: '0xfeed' as Hex, spender: EXEC, amount: 5_000_000n, success: true }],
      pay,
    );
    expect(after).not.toMatch(/nothing was sent/i);
    expect(after).toMatch(/cost gas/);
    // The allowance the user is left holding, in token units, not base units.
    expect(after).toMatch(/up to 5 USDC/);
    // House rule: no em dashes in user-facing copy.
    expect(after).not.toContain('—');
  });

  test('the under-delivery error names the mined approval instead of denying it', async () => {
    const kinds: string[] = [];
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => prepared() };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC_IN,
        depositToken: OUT,
        depositAmountWei: 5_000_000n,
        submit: async (_tx, kind) => {
          kinds.push(kind);
          return { txHash: '0xfeed' as Hex, success: true };
        },
        // The route never delivers the exact target, so every attempt reverts.
        simulate: async () => ({ ok: false, revertData: '0x' }),
        display: { input: pay, deposit: { symbol: 'USDT', decimals: 6 } },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    const message = (thrown as Error).message;
    // At least one approval WAS submitted, and the swap was not.
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain('swap');
    expect(message).not.toMatch(/nothing was sent/i);
    expect(message).toMatch(/cost gas/);
    expect(message).toMatch(/USDC/);
    expect(message).toMatch(/smaller amount/);
  });

  test('with no approval needed the same error still says nothing was sent, because nothing was', async () => {
    const noApproval = { ...prepared(), approvalTx: null };
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => noApproval };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        depositChainId: 11155111,
        fromChainId: 1,
        inputToken: USDC_IN,
        depositToken: OUT,
        depositAmountWei: 5_000_000n,
        submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
        // Allowance already covers the route, so no top-up approval goes out.
        readAllowance: async () => (1n << 255n),
        simulate: async () => ({ ok: false, revertData: '0x' }),
        display: { input: pay, deposit: { symbol: 'USDT', decimals: 6 } },
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toContain('Nothing was sent.');
  });

  // Ratchet: a future error added below the first wallet prompt must not
  // reintroduce the claim. Source text, because only the source can prove it
  // for paths no fixture reaches.
  test('no literal "Nothing was sent" survives past the first submit in runSwapAndDeposit', async () => {
    const source = await Bun.file(new URL('../swap-flows.ts', import.meta.url).pathname).text();
    const start = source.indexOf('export async function runSwapAndDeposit');
    const end = source.indexOf('export function hexToBigInt');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const firstSubmit = body.indexOf("params.submit(");
    expect(firstSubmit).toBeGreaterThan(-1);
    expect(body.slice(firstSubmit)).not.toContain('Nothing was sent');
  });
});

// The retry ladder that made "swap on deposit" fail for every amount QA tried.
describe('swapDepositTargetLadder is sized against the executing slippage', () => {
  test('cross-chain keeps the SDK\'s 3%, same-chain keeps the proven 1%', () => {
    expect(swapDepositSlippage(1, 1)).toBe(0.01);
    expect(swapDepositSlippage(56, 1)).toBe(0.03);
  });

  test('the ladder spans the floor instead of a fraction of it', () => {
    const D = 1_000_000n;
    const sameChain = swapDepositTargetLadder(D, swapDepositSlippage(1, 1));
    // 4 attempts, strictly decreasing, first one untouched.
    expect(sameChain).toHaveLength(4);
    expect(sameChain[0]).toBe(D);
    for (let i = 1; i < sameChain.length; i++) {
      expect(sameChain[i]! < sameChain[i - 1]!).toBe(true);
    }
    // The OLD ladder was 3 attempts of 1%, bottoming out at 0.99^2 = 98.01%,
    // which is less than even the same-chain 1% floor plus its margin. The new
    // one reaches well past it.
    expect(sameChain.at(-1)! < (D * 9801n) / 10_000n).toBe(true);
    // Cross-chain has 3x the floor to clear, so it reaches 3x as far down.
    const crossChain = swapDepositTargetLadder(D, swapDepositSlippage(56, 1));
    expect(crossChain.at(-1)! < sameChain.at(-1)!).toBe(true);
    // Sanity: never a runaway cut.
    expect(crossChain.at(-1)! > D / 2n).toBe(true);
  });
});

// The whole point of the fix: a swap-into-deposit that gives up must not leave
// the swap router able to spend the user's token. The real incident it comes
// from (mainnet, 2026-09-21) was exactly this shape: the approval mined, the
// route failed simulation, the flow gave up, and the allowance was spent by
// someone else 85 seconds later.
describe('an abandoned swap-deposit leaves no live allowance', () => {
  const USDCX = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  // The published mainnet ERC20Proxy, because the spender is checked now.
  const EXECUTOR = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const prepared: PreparedSwapDepositLike = {
    inputToken: USDCX,
    estimatedInputAmount: '0x1e8480' as Hex,
    approvalAddress: EXECUTOR,
    approvalTx: { to: USDCX, data: `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000n).toString(16).padStart(64, '0')}` },
    transactionData: '0xdead' as Hex,
    transactionTo: EXECUTOR,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };
  const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => prepared };
  const shared = {
    depositChainId: 11155111,
    fromChainId: 1,
    inputToken: USDCX,
    depositToken: USDT,
    depositAmountWei: 5_000_000n,
    display: {
      input: { symbol: 'USDC', decimals: 6 },
      deposit: { symbol: 'USDT', decimals: 6 },
    },
  };
  /** The allowance an approve(spender, amount) calldata actually grants. */
  const grantedBy = (data: string) => BigInt(`0x${data.slice(74, 138)}`);

  /**
   * A wallet that records every transaction, and an allowance ledger that
   * applies each approve() exactly as the token would. The assertion is not
   * "a revoke was sent" but "the ledger is empty", which is the only thing
   * that would have protected the reviewer.
   */
  const wallet = (fail?: (kind: string, n: number) => 'reject' | 'revert' | undefined) => {
    const allowance = new Map<string, bigint>();
    const kinds: string[] = [];
    let n = 0;
    const submit = async (tx: { to: Address; data: Hex }, kind: 'approval' | 'swap' | 'revoke') => {
      kinds.push(kind);
      const verdict = fail?.(kind, ++n);
      if (verdict === 'reject') throw new Error('User rejected the request.');
      if (verdict === 'revert') return { txHash: '0xbad' as Hex, success: false };
      if (kind === 'approval' || kind === 'revoke') {
        allowance.set(`0x${tx.data.slice(34, 74)}`, grantedBy(tx.data));
      }
      return { txHash: '0xfeed' as Hex, success: true };
    };
    const live = () => [...allowance.values()].filter((v) => v > 0n);
    return { submit, kinds, live, allowance };
  };

  test('a route that cannot deliver is rejected BEFORE any approval, when the allowance can be simulated', async () => {
    const w = wallet();
    await expect(runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: false, supported: true, revertData: '0x' }),
      simulate: async () => ({ ok: false }),
    })).rejects.toThrow(/cannot deliver the full deposit amount/);
    // Nothing signed at all, so the message may say so and mean it.
    expect(w.kinds).toEqual([]);
    expect(w.live()).toEqual([]);
  });

  test('the pre-approval refusal is allowed to say nothing was sent, because nothing was', async () => {
    const w = wallet();
    const message = await runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: false, supported: true }),
    }).catch((err: Error) => err.message);
    expect(message).toMatch(/nothing was sent/i);
    expect(message).toMatch(/smaller amount/);
  });

  test('a validated route approves exactly once and swaps immediately after', async () => {
    const w = wallet();
    await runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
      // Present, and must NOT run a second ladder: the route is already proven.
      simulate: async () => { throw new Error('the post-approval ladder must not run on a validated route'); },
    });
    expect(w.kinds).toEqual(['approval', 'swap']);
  });

  test('an unsupported override falls back to approve-first, and the failure revokes', async () => {
    const w = wallet();
    await expect(runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: false, supported: false }),
      simulate: async () => ({ ok: false, revertData: '0x' }),
    })).rejects.toThrow(/cannot deliver the full deposit amount/);
    expect(w.kinds).toContain('approval');
    expect(w.kinds).toContain('revoke');
    expect(w.live()).toEqual([]);
  });

  test('rejecting the swap prompt after the approval mined still hands the allowance back', async () => {
    const w = wallet((kind) => (kind === 'swap' ? 'reject' : undefined));
    const message = await runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    }).catch((err: Error) => err.message);
    expect(w.kinds).toEqual(['approval', 'swap', 'revoke']);
    expect(w.live()).toEqual([]);
    expect(message).toMatch(/rejected/i);
    expect(message).toMatch(/set back to zero/);
  });

  test('a reverted swap hands the allowance back: the rollback does not undo the approval', async () => {
    const w = wallet((kind) => (kind === 'swap' ? 'revert' : undefined));
    await expect(runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    })).rejects.toThrow(/reverted on-chain/);
    expect(w.kinds).toEqual(['approval', 'swap', 'revoke']);
    expect(w.live()).toEqual([]);
  });

  test('a revoke the user refuses is reported, not swallowed', async () => {
    const w = wallet((kind) => (kind === 'swap' ? 'revert' : kind === 'revoke' ? 'reject' : undefined));
    const message = await runSwapAndDeposit(session, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    }).catch((err: Error) => err.message);
    // The allowance really is still there, and the copy says so plus what to do.
    expect(w.live()).toEqual([1_000_000n]);
    expect(message).toMatch(/reverted on-chain/);
    expect(message).toMatch(/did not go through/);
    expect(message).toMatch(/Revoke it in your wallet/);
    expect(message).not.toMatch(/set back to zero\./);
  });

  test('the USDT approve(0)-then-approve dance: failing on the second leaves nothing live', async () => {
    const reset = `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`;
    const cap = `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000n).toString(16).padStart(64, '0')}`;
    const twoStep: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => ({
        ...prepared,
        approvalTx: { to: USDCX, data: cap },
        approvalTxs: [{ to: USDCX, data: reset }, { to: USDCX, data: cap }],
      }),
    };
    // The reset mines, the cap reverts: the user is left mid-dance at zero.
    const w = wallet((kind, n) => (kind === 'approval' && n === 2 ? 'revert' : undefined));
    await expect(runSwapAndDeposit(twoStep, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    })).rejects.toThrow(/did not go through/);
    expect(w.live()).toEqual([]);
    // Nothing to revoke: the only approval that mined set the allowance to 0.
    expect(w.kinds).toEqual(['approval', 'approval']);
  });

  test('both legs mine and the swap then fails: the cap is taken back', async () => {
    const reset = `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}`;
    const cap = `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000n).toString(16).padStart(64, '0')}`;
    const twoStep: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => ({
        ...prepared,
        approvalTx: { to: USDCX, data: cap },
        approvalTxs: [{ to: USDCX, data: reset }, { to: USDCX, data: cap }],
      }),
    };
    const w = wallet((kind) => (kind === 'swap' ? 'revert' : undefined));
    await expect(runSwapAndDeposit(twoStep, {
      ...shared,
      submit: w.submit,
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    })).rejects.toThrow(/reverted on-chain/);
    expect(w.kinds).toEqual(['approval', 'approval', 'swap', 'revoke']);
    expect(w.live()).toEqual([]);
  });
});

describe('liveAllowancesAfter / revokeLiveApprovals', () => {
  const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const A = '0x2222222222222222222222222222222222222222' as Address;
  const B = '0x3333333333333333333333333333333333333333' as Address;

  test('a reverted approval granted nothing, so there is nothing to take back', () => {
    expect(liveAllowancesAfter([{ txHash: null, spender: A, amount: 5n, success: false }]).size).toBe(0);
  });

  test('the LAST mined approval per spender wins, and a zero one clears it', () => {
    const live = liveAllowancesAfter([
      { txHash: null, spender: A, amount: 9n, success: true },
      { txHash: null, spender: A, amount: 0n, success: true },
      { txHash: null, spender: B, amount: 0n, success: true },
      { txHash: null, spender: B, amount: 7n, success: true },
    ]);
    expect([...live]).toEqual([[B.toLowerCase(), 7n]]);
  });

  test('every live spender gets an approve(0), and the amount word is zero', async () => {
    const sent: { to: Address; data: string }[] = [];
    const cleanup = await revokeLiveApprovals(
      [
        { txHash: null, spender: A, amount: 5n, success: true },
        { txHash: null, spender: B, amount: 6n, success: true },
      ],
      TOKEN,
      async (tx) => { sent.push(tx as { to: Address; data: string }); return { txHash: '0x1' as Hex, success: true }; },
    );
    expect(sent.length).toBe(2);
    for (const tx of sent) {
      expect(tx.to).toBe(TOKEN);
      expect(tx.data.startsWith('0x095ea7b3')).toBe(true);
      expect(BigInt(`0x${tx.data.slice(74, 138)}`)).toBe(0n);
    }
    expect(cleanup.failed).toEqual([]);
    expect(cleanup.revoked.length).toBe(2);
  });

  test('a throwing wallet cannot break the error already on its way to the user', async () => {
    const cleanup = await revokeLiveApprovals(
      [{ txHash: null, spender: A, amount: 5n, success: true }],
      TOKEN,
      async () => { throw new Error('wallet is gone'); },
    );
    expect(cleanup.failed).toEqual([A.toLowerCase() as Address]);
    expect(cleanup.revoked).toEqual([]);
  });
});

// A wallet that throws says nothing about whether the transaction was
// broadcast. A rejection and a post-signature timeout are the same exception,
// and only one of them left an allowance behind.
describe('a wallet that throws is reconciled against the chain, not guessed at', () => {
  const USDCX = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  // The published mainnet ERC20Proxy, because the spender is checked now.
  const EXECUTOR = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const prepared: PreparedSwapDepositLike = {
    inputToken: USDCX,
    estimatedInputAmount: '0x1e8480' as Hex,
    approvalAddress: EXECUTOR,
    approvalTx: { to: USDCX, data: `0x095ea7b3${EXECUTOR.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000n).toString(16).padStart(64, '0')}` },
    transactionData: '0xdead' as Hex,
    transactionTo: EXECUTOR,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };
  const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => prepared };
  const shared = {
    depositChainId: 11155111,
    fromChainId: 1,
    inputToken: USDCX,
    depositToken: USDT,
    depositAmountWei: 5_000_000n,
    display: { input: { symbol: 'USDC', decimals: 6 }, deposit: { symbol: 'USDT', decimals: 6 } },
    simulateWithAllowance: async () => ({ ok: true, supported: true }),
  };

  test('an approval that mined despite the wallet throwing is found and taken back', async () => {
    const kinds: string[] = [];
    const message = await runSwapAndDeposit(session, {
      ...shared,
      // The chain says the allowance is there. The bookkeeping does not.
      readAllowance: async () => 1_000_000n,
      submit: async (_tx, kind) => {
        kinds.push(kind);
        if (kind === 'approval') throw new Error('Request timed out.');
        return { txHash: '0xfeed' as Hex, success: true };
      },
    }).catch((err: Error) => err.message);
    expect(kinds).toEqual(['approval', 'revoke']);
    expect(message).toMatch(/timed out/i);
    expect(message).not.toMatch(/nothing was sent/i);
  });

  test('a first approval the user simply declined grants nothing, so there is no second prompt', async () => {
    const kinds: string[] = [];
    await expect(runSwapAndDeposit(session, {
      ...shared,
      readAllowance: async () => 0n,
      submit: async (_tx, kind) => {
        kinds.push(kind);
        throw new Error('User rejected the request.');
      },
    })).rejects.toThrow(/User rejected/);
    // One prompt, declined, and no revoke chasing an allowance that never existed.
    expect(kinds).toEqual(['approval']);
  });

  test('with no allowance read available it cannot invent a leftover', async () => {
    const kinds: string[] = [];
    await expect(runSwapAndDeposit(session, {
      ...shared,
      submit: async (_tx, kind) => {
        kinds.push(kind);
        throw new Error('User rejected the request.');
      },
    })).rejects.toThrow(/User rejected/);
    expect(kinds).toEqual(['approval']);
  });
});

// ─── The review of 5e7e204: what the machinery around the spender fix got
// ─── wrong. Every case below is driven through runSwapAndDeposit, because the
// ─── messages that were untrue are built by helpers the source-text ratchets
// ─── above cannot follow.
describe('the swap-deposit flow keeps to the amount the user confirmed', () => {
  const IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const OUT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
  const PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const pay = { symbol: 'USDC', decimals: 6 };
  const display = { input: pay, deposit: { symbol: 'USDT', decimals: 6 } };

  const approveData = (spender: Address, amount: bigint) =>
    `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}` as Hex;

  const quote = (input: bigint): PreparedSwapDepositLike => ({
    inputToken: IN,
    estimatedInputAmount: toHex(input),
    approvalAddress: PROXY,
    approvalTx: { to: IN, data: approveData(PROXY, input) },
    transactionData: '0xdead' as Hex,
    transactionTo: PROXY,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  });

  /**
   * The reviewer's reproduction: the user confirms 100 in, the first route
   * fails simulation, the smaller DEPOSIT target comes back wanting 200 in,
   * and the second simulation passes. The old flow approved 200 and submitted.
   */
  test('a replacement quote that costs more than the confirmed amount is refused before any approval', async () => {
    const inputs = [100n, 200n];
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => quote(inputs[Math.min(prepares++, inputs.length - 1)]!),
    };
    const kinds: string[] = [];
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async (_tx, kind) => { kinds.push(kind); return { txHash: '0xfeed' as Hex, success: true }; },
        // First route reverts, the dearer replacement would pass.
        simulateWithAllowance: async () => ({ ok: prepares > 1, supported: true }),
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    const message = (thrown as Error).message;
    expect(message).toMatch(/wants 0\.0002 USDC, more than the 0\.0001 you confirmed/);
    expect(message).toContain('Nothing was sent.');
    // And it stopped before the wallet, which is the whole point.
    expect(kinds).toEqual([]);
  });

  test('a replacement that costs the same or less still runs', async () => {
    const inputs = [100n, 90n];
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => quote(inputs[Math.min(prepares++, inputs.length - 1)]!),
    };
    const kinds: string[] = [];
    const result = await runSwapAndDeposit(session, {
      fromChainId: 1,
      depositChainId: 11155111,
      inputToken: IN,
      depositToken: OUT,
      depositAmountWei: 1_000_000n,
      submit: async (_tx, kind) => { kinds.push(kind); return { txHash: '0xfeed' as Hex, success: true }; },
      simulateWithAllowance: async () => ({ ok: prepares > 1, supported: true }),
      confirmPrepared: async () => true,
      display,
    });
    expect(hexToBigInt(result.prepared.estimatedInputAmount)).toBe(90n);
    expect(kinds).toEqual(['approval', 'swap']);
  });

  test('the ceiling covers the native value a replacement asks for too', async () => {
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => (prepares++ === 0
        ? { ...quote(100n), msgValue: '0x0' as Hex }
        : { ...quote(100n), msgValue: toHex(5n) }),
    };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
        simulateWithAllowance: async () => ({ ok: prepares > 1, supported: true }),
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    expect((thrown as Error).message).toMatch(/you confirmed/);
  });
});

describe('every locally built top-up resets a partial allowance first', () => {
  const IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const OUT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
  const PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const pay = { symbol: 'USDT', decimals: 6 };
  const display = { input: pay, deposit: { symbol: 'USDC', decimals: 6 } };

  const amountOf = (data: string) => BigInt(`0x${data.slice(74, 138)}`);

  test('approvalAmountPlan is the one place that decides, and it is Tether-safe', () => {
    expect(approvalAmountPlan(200n, 100n)).toEqual([]);
    expect(approvalAmountPlan(100n, 100n)).toEqual([]);
    expect(approvalAmountPlan(0n, 100n)).toEqual([100n]);
    expect(approvalAmountPlan(40n, 100n)).toEqual([0n, 100n]);
    // Unknown is not zero. Guessing it zero is what dropped the reset.
    expect(approvalAmountPlan(null, 100n)).toEqual([0n, 100n]);
  });

  /**
   * The reviewer's reproduction: the retry path produced approvals [100, 110]
   * where the SDK's own sequence was [0, 110], and a Tether-style token
   * reverts the second of those.
   */
  test('the retry top-up resets before raising a partial allowance', async () => {
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => {
        const input = prepares++ === 0 ? 100n : 90n;
        return {
          inputToken: IN,
          estimatedInputAmount: toHex(input),
          approvalAddress: PROXY,
          approvalTx: { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${input.toString(16).padStart(64, '0')}` as Hex },
          transactionData: '0xdead' as Hex,
          transactionTo: PROXY,
          msgValue: '0x0' as Hex,
          estimatedDuration: 45,
        };
      },
    };
    const approvals: bigint[] = [];
    let simulations = 0;
    await runSwapAndDeposit(session, {
      fromChainId: 1,
      depositChainId: 11155111,
      inputToken: IN,
      depositToken: OUT,
      depositAmountWei: 1_000_000n,
      submit: async (tx, kind) => {
        if (kind === 'approval') approvals.push(amountOf(tx.data));
        return { txHash: '0xfeed' as Hex, success: true };
      },
      // No override available, so the flow approves first and retries after.
      simulate: async () => ({ ok: simulations++ > 0 }),
      // A partial allowance stands when the retry route is priced.
      readAllowance: async () => 40n,
      confirmPrepared: async () => true,
      display,
    });
    // First the SDK's own approval for 100, then the retry's reset and top-up.
    expect(approvals).toEqual([100n, 0n, 90n]);
  });

  test('an unreadable allowance on the retry path still gets its reset', async () => {
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => {
        const input = prepares++ === 0 ? 100n : 90n;
        return {
          inputToken: IN,
          estimatedInputAmount: toHex(input),
          approvalAddress: PROXY,
          approvalTx: { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${input.toString(16).padStart(64, '0')}` as Hex },
          transactionData: '0xdead' as Hex,
          transactionTo: PROXY,
          msgValue: '0x0' as Hex,
          estimatedDuration: 45,
        };
      },
    };
    const approvals: bigint[] = [];
    let simulations = 0;
    await runSwapAndDeposit(session, {
      fromChainId: 1,
      depositChainId: 11155111,
      inputToken: IN,
      depositToken: OUT,
      depositAmountWei: 1_000_000n,
      submit: async (tx, kind) => {
        if (kind === 'approval') approvals.push(amountOf(tx.data));
        return { txHash: '0xfeed' as Hex, success: true };
      },
      simulate: async () => ({ ok: simulations++ > 0 }),
      readAllowance: async () => { throw new Error('rpc down'); },
      confirmPrepared: async () => true,
      display,
    });
    expect(approvals).toEqual([100n, 0n, 90n]);
  });
});

describe('what the flow says about the swap transaction itself', () => {
  const IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const OUT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
  const PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const pay = { symbol: 'USDC', decimals: 6 };
  const display = { input: pay, deposit: { symbol: 'USDT', decimals: 6 } };

  const noApprovalNeeded: PreparedSwapDepositLike = {
    inputToken: IN,
    estimatedInputAmount: toHex(100n),
    approvalAddress: PROXY,
    approvalTx: null,
    transactionData: '0xdead' as Hex,
    transactionTo: PROXY,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };

  /**
   * Reachable without a malformed quote: an existing allowance covers the
   * route so nothing is approved, the swap goes out and reverts. `sent` tracks
   * approvals only, so the message used to end "Nothing was sent." after a
   * transaction the user can see in their own wallet history.
   */
  test('a swap that was submitted and reverted is not reported as nothing sent', async () => {
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => noApprovalNeeded };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async (_tx, kind) => ({ txHash: '0xfeed' as Hex, success: kind !== 'swap' }),
        readAllowance: async () => (1n << 255n),
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/nothing was sent/i);
    expect(message).toMatch(/the swap transaction was sent and cost gas/i);
    expect(message).not.toContain('—');
  });

  test('a swap whose submit threw is reported as an outcome this app could not confirm', async () => {
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => noApprovalNeeded };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async (_tx, kind) => {
          if (kind === 'swap') throw new Error('wallet connection lost');
          return { txHash: '0xfeed' as Hex, success: true };
        },
        readAllowance: async () => (1n << 255n),
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/nothing was sent/i);
    expect(message).toMatch(/could not confirm what the swap did/i);
    expect(message).toMatch(/check it in your wallet/i);
  });

  /**
   * The validator also runs on a RE-PREPARED route. Its own fixed text used to
   * say "nothing was signed and nothing was sent" over the top of an approval
   * that had already mined, and then the run's honest account was appended
   * after it, so the message contradicted itself.
   */
  test('a retry route with no approval address is refused without denying the mined approval', async () => {
    let prepares = 0;
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async () => {
        const first = prepares++ === 0;
        return {
          inputToken: IN,
          estimatedInputAmount: toHex(100n),
          ...(first ? { approvalAddress: PROXY } : {}) as { approvalAddress: Address },
          approvalTx: first
            ? { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${(100n).toString(16).padStart(64, '0')}` as Hex }
            : null,
          transactionData: '0xdead' as Hex,
          transactionTo: PROXY,
          msgValue: '0x0' as Hex,
          estimatedDuration: 45,
        } as PreparedSwapDepositLike;
      },
    };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
        simulate: async () => ({ ok: false }),
        readAllowance: async () => 0n,
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    const message = (thrown as Error).message;
    expect(message).toMatch(/approval was not signed/i);
    // The contradiction: it must not deny the approval it appends in the very
    // same sentence.
    expect(message).not.toMatch(/nothing was sent/i);
  });
});

describe('cleanup reads the token rather than trusting its own notes', () => {
  const IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const OUT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
  const PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
  const pay = { symbol: 'USDT', decimals: 6 };
  const display = { input: pay, deposit: { symbol: 'USDC', decimals: 6 } };

  const withReset: PreparedSwapDepositLike = {
    inputToken: IN,
    estimatedInputAmount: toHex(100n),
    approvalAddress: PROXY,
    approvalTx: { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${(100n).toString(16).padStart(64, '0')}` as Hex },
    approvalTxs: [
      { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${'0'.repeat(64)}` as Hex },
      { to: IN, data: `0x095ea7b3${PROXY.slice(2).toLowerCase().padStart(64, '0')}${(100n).toString(16).padStart(64, '0')}` as Hex },
    ],
    transactionData: '0xdead' as Hex,
    transactionTo: PROXY,
    msgValue: '0x0' as Hex,
    estimatedDuration: 45,
  };

  /**
   * Both prompts declined, over a PRE-EXISTING allowance. Reconciliation reads
   * that allowance and used to file it as an approval this run had sent, so
   * the message billed the user for gas on two prompts they had refused.
   */
  test('an allowance this run only read is never reported as an approval it sent', async () => {
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => withReset };
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        // Every prompt, including the revoke, is declined.
        submit: async () => { throw new Error('User rejected the request'); },
        readAllowance: async () => 40n,
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/approval was already sent/i);
    expect(message).not.toMatch(/cost gas/i);
    // But the standing allowance is still reported, because it is still there.
    expect(message).toMatch(/still spend up to 0\.00004 USDT/);
  });

  /**
   * The converse: a recorded approval whose allowance the swap already spent.
   * Cleanup used to skip the read entirely and prompt for an approve(0) on an
   * allowance that was already zero.
   */
  test('a recorded approval the chain says is already spent draws no revoke prompt', async () => {
    const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => ({ ...withReset, approvalTxs: undefined }) };
    const kinds: string[] = [];
    let thrown: unknown;
    try {
      await runSwapAndDeposit(session, {
        fromChainId: 1,
        depositChainId: 11155111,
        inputToken: IN,
        depositToken: OUT,
        depositAmountWei: 1_000_000n,
        submit: async (_tx, kind) => {
          kinds.push(kind);
          if (kind === 'swap') throw new Error('receipt request failed');
          return { txHash: '0xfeed' as Hex, success: true };
        },
        // The swap consumed it before the receipt request fell over.
        readAllowance: async () => 0n,
        confirmPrepared: async () => true,
        display,
      });
    } catch (err) { thrown = err; }
    expect(kinds).toEqual(['approval', 'swap']);
    expect(kinds).not.toContain('revoke');
    const message = (thrown as Error).message;
    expect(message).toMatch(/could not confirm what the swap did/i);
    expect(message).not.toMatch(/revoke/i);
  });
});

describe('the allowance cleanup is a boundary, not a promise', () => {
  const IN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
  const PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;

  test('an onStep callback that throws cannot abort the cleanup', async () => {
    const revoked: string[] = [];
    const cleanup = await revokeLiveApprovals(
      [{ txHash: '0xfeed' as Hex, spender: PROXY, amount: 100n, success: true }],
      IN,
      async (tx) => { revoked.push(tx.to); return { txHash: '0xbeef' as Hex, success: true }; },
      () => { throw new Error('setState after unmount'); },
    );
    // The callback threw, so this one could not be submitted, but the function
    // still returned an account of it instead of replacing the real error.
    expect(cleanup.failed.map((a) => a.toLowerCase())).toEqual([PROXY.toLowerCase()]);
    expect(revoked).toEqual([]);
  });
});

// Exercise the same send -> broadcast notification -> receipt boundary as the
// provider, with a ledger that changes only when a transaction actually mines.
describe('broadcast approval recovery and spender changes', () => {
  type Kind = 'approval' | 'swap' | 'revoke';
  type Outcome = 'reject' | 'pending' | 'revert' | undefined;
  const spenderOf = (data: Hex) => `0x${data.slice(34, 74)}`.toLowerCase() as Address;
  const amountOf = (data: Hex) => BigInt(`0x${data.slice(74, 138)}`);
  const proxy = LIFI_PROXY.toLowerCase() as Address;
  const diamond = LIFI_DIAMOND.toLowerCase() as Address;
  const quote = (spender = LIFI_PROXY, approval = true): PreparedSwapDepositLike => ({
    inputToken: USDC,
    estimatedInputAmount: toHex(100n),
    approvalAddress: spender,
    approvalTx: approval ? { to: USDC, data: approveCalldata(spender, 100n) } : null,
    transactionData: '0xdead',
    transactionTo: LIFI_DIAMOND,
    msgValue: '0x0',
    estimatedDuration: 45,
  });
  const shared = {
    fromChainId: 1,
    depositChainId: 11155111,
    inputToken: USDC,
    depositToken: USDT,
    depositAmountWei: 100n,
    display: { input: { symbol: 'USDC', decimals: 6 }, deposit: { symbol: 'USDT', decimals: 6 } },
  };
  const session = { prepareSwapAndDeposit: async () => quote() };
  const wallet = (outcome: (kind: Kind, prompt: number) => Outcome = () => undefined) => {
    const allowance = new Map<Address, bigint>();
    const prompts: Kind[] = [];
    const broadcasts: { hash: Hex; kind: Kind; data: Hex }[] = [];
    const receipts = new Map<Hex, { success: boolean }>();
    let swapSpender = proxy;
    const mine = (hash: Hex, success = true) => {
      const tx = broadcasts.find((entry) => entry.hash === hash)!;
      receipts.set(hash, { success });
      if (!success) return;
      if (tx.kind === 'swap') allowance.set(swapSpender, 0n);
      else allowance.set(spenderOf(tx.data), amountOf(tx.data));
    };
    const submit: SubmitSwapTx = async (tx, kind, onBroadcast) => {
      prompts.push(kind);
      const result = outcome(kind, prompts.length);
      return submitWalletTransaction(
        async () => {
          if (result === 'reject') throw new Error('User rejected the request.');
          const hash = toHex(BigInt(broadcasts.length + 1));
          broadcasts.push({ hash, kind, data: tx.data });
          return hash;
        },
        async (hash) => {
          if (result === 'pending') throw new Error('Receipt wait timed out.');
          mine(hash, result !== 'revert');
          return { status: result === 'revert' ? 'reverted' : 'success' };
        },
        onBroadcast,
      );
    };
    return {
      submit, allowance, prompts, broadcasts, mine,
      readAllowance: async (_token: Address, spender: Address) => allowance.get(spender.toLowerCase() as Address) ?? 0n,
      readApprovalReceipt: async (hash: Hex) => receipts.get(hash) ?? null,
      useSpender: (spender: Address) => { swapSpender = spender.toLowerCase() as Address; },
    };
  };

  test('a receipt timeout with zero allowance retains the broadcast hash and tells the user how to recover', async () => {
    const w = wallet((kind) => kind === 'approval' ? 'pending' : undefined);
    const recovery: SentApprovalRecord[] = [];
    const message = await runSwapAndDeposit(session, { ...shared, ...w, approvalRecovery: recovery })
      .catch((err: Error) => err.message);
    expect(w.prompts).toEqual(['approval']);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ txHash: '0x1', pending: true, success: false });
    expect(message).toContain('Approval confirmation is still unknown');
    expect(message).toContain('0x1');
    expect(message).toContain(LIFI_PROXY);
    expect(message).toMatch(/Check the transaction in your wallet/);
    expect(message).not.toMatch(/Nothing was sent|cost gas|no spending permission|set back to zero/);
  });

  test('retrying while it is pending preserves it and does not quote or sign again', async () => {
    const w = wallet(() => 'pending');
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(session, params).catch(() => undefined);
    let prepared = false;
    const message = await runSwapAndDeposit({ prepareSwapAndDeposit: async () => { prepared = true; return quote(); } }, params)
      .catch((err: Error) => err.message);
    expect(prepared).toBe(false);
    expect(w.prompts).toEqual(['approval']);
    expect(recovery).toHaveLength(1);
    expect(recovery[0].pending).toBe(true);
    expect(message).toContain('Approval confirmation is still unknown');
  });

  test('a late successful receipt is reconciled on retry and the actual grant is reset', async () => {
    const w = wallet((kind) => kind === 'approval' ? 'pending' : undefined);
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(session, params).catch(() => undefined);
    w.mine(recovery[0].txHash!);
    expect(w.allowance.get(proxy)).toBe(100n);
    const message = await runSwapAndDeposit(session, params).catch((err: Error) => err.message);
    expect(w.prompts).toEqual(['approval', 'revoke']);
    expect(w.allowance.get(proxy)).toBe(0n);
    expect(recovery).toEqual([]);
    expect(message).toContain('set back to zero');
    expect(message).not.toContain('still unknown');
  });

  test('a late reverted receipt needs no reset and clears recovery', async () => {
    const w = wallet(() => 'pending');
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(session, params).catch(() => undefined);
    w.mine(recovery[0].txHash!, false);
    const message = await runSwapAndDeposit(session, params).catch((err: Error) => err.message);
    expect(w.prompts).toEqual(['approval']);
    expect(recovery).toEqual([]);
    expect(message).toContain('no spending permission');
    expect(message).not.toContain('still unknown');
  });

  test('a late successful receipt whose allowance is already spent needs no reset', async () => {
    const w = wallet(() => 'pending');
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(session, params).catch(() => undefined);
    w.mine(recovery[0].txHash!);
    w.allowance.set(proxy, 0n);
    await runSwapAndDeposit(session, params).catch(() => undefined);
    expect(w.prompts).toEqual(['approval']);
    expect(recovery).toEqual([]);
  });

  test('failed recovery cleanup is retained and can be retried later', async () => {
    let declineReset = true;
    const w = wallet((kind) => kind === 'approval' ? 'pending' : declineReset ? 'reject' : undefined);
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(session, params).catch(() => undefined);
    w.mine(recovery[0].txHash!);
    const message = await runSwapAndDeposit(session, params).catch((err: Error) => err.message);
    expect(message).toContain('Revoke it in your wallet');
    expect(recovery).toHaveLength(1);
    declineReset = false;
    await runSwapAndDeposit(session, params).catch(() => undefined);
    expect(w.allowance.get(proxy)).toBe(0n);
    expect(recovery).toEqual([]);
  });

  test('a wallet client can notify a broadcast then throw without losing the pending row', async () => {
    const recovery: SentApprovalRecord[] = [];
    const message = await runSwapAndDeposit(session, {
      ...shared,
      approvalRecovery: recovery,
      readAllowance: async () => 0n,
      submit: async (_tx, _kind, onBroadcast) => {
        onBroadcast?.('0xbeef');
        throw new Error('Wallet disconnected after broadcast.');
      },
    }).catch((err: Error) => err.message);
    expect(recovery).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ txHash: '0xbeef', pending: true });
    expect(message).toContain('0xbeef');
    expect(message).not.toContain('Nothing was sent');
  });

  test('receipt and allowance read failures leave the pending broadcast recoverable', async () => {
    const w = wallet(() => 'pending');
    const recovery: SentApprovalRecord[] = [];
    await runSwapAndDeposit(session, {
      ...shared, ...w, approvalRecovery: recovery,
      readAllowance: async () => { throw new Error('RPC unavailable'); },
      readApprovalReceipt: async () => { throw new Error('RPC unavailable'); },
    }).catch(() => undefined);
    expect(recovery).toHaveLength(1);
    expect(recovery[0].pending).toBe(true);
    expect(w.prompts).toEqual(['approval']);
  });

  for (const readable of [true, false]) {
    test(`a declined prompt creates no pending row or warning (allowance readable: ${readable})`, async () => {
      const w = wallet(() => 'reject');
      const recovery: SentApprovalRecord[] = [];
      const message = await runSwapAndDeposit(session, {
        ...shared, ...w, approvalRecovery: recovery,
        readAllowance: readable ? w.readAllowance : undefined,
      }).catch((err: Error) => err.message);
      expect(message).toBe('User rejected the request.');
      expect(recovery).toEqual([]);
      expect(w.broadcasts).toEqual([]);
      expect(w.prompts).toEqual(['approval']);
      expect(message).not.toMatch(/pending|unknown|broadcast|cost gas|Revoke/);
    });
  }

  test('a normally confirmed notification updates one record instead of counting the approval twice', async () => {
    const w = wallet((kind) => kind === 'swap' ? 'reject' : undefined);
    const recovery: SentApprovalRecord[] = [];
    const message = await runSwapAndDeposit(session, { ...shared, ...w, approvalRecovery: recovery })
      .catch((err: Error) => err.message);
    expect(message).toMatch(/an approval/);
    expect(message).not.toMatch(/2 approvals|still unknown/);
    expect(recovery).toEqual([]);
    expect(w.prompts).toEqual(['approval', 'swap', 'revoke']);
  });

  const retrySession = (nextSpender = LIFI_DIAMOND, initialApproval = true) => {
    let calls = 0;
    return { prepareSwapAndDeposit: async () => calls++ === 0 ? quote(LIFI_PROXY, initialApproval) : quote(nextSpender) };
  };
  const retrySimulation = () => {
    let calls = 0;
    return {
      simulateWithAllowance: async () => ({ ok: false, supported: false }),
      simulate: async () => ({ ok: calls++ > 0 }),
    };
  };

  test('switching between vetted spenders resets X before granting Y and returns success with no leftover', async () => {
    const w = wallet();
    w.useSpender(diamond);
    const details: string[] = [];
    const result = await runSwapAndDeposit(retrySession(), {
      ...shared, ...w, ...retrySimulation(),
      onStep: (_step, detail) => { if (detail) details.push(detail); },
    });
    expect(result.txHash).toBe('0x4');
    expect(w.prompts).toEqual(['approval', 'revoke', 'approval', 'swap']);
    expect(w.broadcasts.slice(0, 3).map(({ data }) => [spenderOf(data), amountOf(data)]))
      .toEqual([[proxy, 100n], [proxy, 0n], [diamond, 100n]]);
    expect(w.allowance.get(proxy)).toBe(0n);
    expect(w.allowance.get(diamond)).toBe(0n);
    expect(details).toEqual(['The route changed. Reset the previous route’s token approval before continuing (sign in wallet).']);
  });

  for (const failure of ['reject', 'revert', 'pending'] as const) {
    test(`a ${failure} on the old spender reset blocks the new grant without repeating the prompt`, async () => {
      const w = wallet((kind) => kind === 'revoke' ? failure : undefined);
      const recovery: SentApprovalRecord[] = [];
      const message = await runSwapAndDeposit(retrySession(), {
        ...shared, ...w, ...retrySimulation(), approvalRecovery: recovery,
      }).catch((err: Error) => err.message);
      expect(w.prompts).toEqual(['approval', 'revoke']);
      expect(w.allowance.get(proxy)).toBe(100n);
      expect(w.allowance.has(diamond)).toBe(false);
      expect(message).not.toContain('Nothing was sent');
      if (failure === 'pending') {
        expect(recovery).toHaveLength(2);
        expect(recovery[1]).toMatchObject({ pending: true, amount: 0n });
        expect(message).toContain('Approval confirmation is still unknown');
      } else {
        expect(recovery.some((record) => record.success && record.amount === 100n)).toBe(true);
        expect(recovery.some((record) => record.pending)).toBe(false);
        expect(message).toContain('Revoke it in your wallet');
      }
    });
  }

  test('a same-spender retry (including address casing) does not add a reset prompt', async () => {
    const w = wallet();
    await runSwapAndDeposit(retrySession(proxy), { ...shared, ...w, ...retrySimulation() });
    expect(w.prompts).toEqual(['approval', 'swap']);
  });

  test('a pending route reset that later reverts preserves the older grant when allowance reads fail', async () => {
    let resetPending = true;
    const w = wallet((kind) => kind === 'revoke' && resetPending ? 'pending' : undefined);
    const recovery: SentApprovalRecord[] = [];
    const params = { ...shared, ...w, approvalRecovery: recovery };
    await runSwapAndDeposit(retrySession(), { ...params, ...retrySimulation() }).catch(() => undefined);
    w.mine(recovery.find((record) => record.pending)!.txHash!, false);
    resetPending = false;
    const message = await runSwapAndDeposit(session, {
      ...params,
      readAllowance: async () => { throw new Error('Read unavailable'); },
    }).catch((err: Error) => err.message);
    expect(w.prompts).toEqual(['approval', 'revoke', 'revoke']);
    expect(w.allowance.get(proxy)).toBe(0n);
    expect(recovery).toEqual([]);
    expect(message).toContain('set back to zero');
  });

  test('a grant already spent before the spender switch does not need a reset', async () => {
    const w = wallet();
    w.useSpender(diamond);
    let calls = 0;
    await runSwapAndDeposit(retrySession(), {
      ...shared, ...w,
      simulate: async () => { w.allowance.set(proxy, 0n); return { ok: calls++ > 0 }; },
    });
    expect(w.prompts).toEqual(['approval', 'approval', 'swap']);
  });

  test('an old spender allowance that predates this run is not reset when the route changes', async () => {
    const w = wallet();
    w.allowance.set(proxy, 100n);
    w.useSpender(diamond);
    await runSwapAndDeposit(retrySession(LIFI_DIAMOND, false), { ...shared, ...w, ...retrySimulation() });
    expect(w.prompts).toEqual(['approval', 'swap']);
    expect(w.allowance.get(proxy)).toBe(100n);
  });

  test('an unreadable old allowance still resets the confirmed grant before moving on', async () => {
    const w = wallet();
    w.useSpender(diamond);
    await runSwapAndDeposit(retrySession(), {
      ...shared, ...w, ...retrySimulation(),
      readAllowance: async (token, spender) => {
        if (spender.toLowerCase() === proxy) throw new Error('Read failed');
        return w.readAllowance(token, spender);
      },
    });
    expect(w.prompts).toEqual(['approval', 'revoke', 'approval', 'swap']);
    expect(w.allowance.get(proxy)).toBe(0n);
  });
});

describe('wallet submit notification is optional and precedes receipt waiting', () => {
  for (const status of ['success', 'reverted']) {
    test(`without an observer, ${status} keeps the receipt result`, async () => {
      const order: string[] = [];
      const result = await submitWalletTransaction(
        async () => { order.push('send'); return '0xbeef'; },
        async (hash) => { order.push(`wait:${hash}`); return { status }; },
      );
      expect(order).toEqual(['send', 'wait:0xbeef']);
      expect(result).toEqual({ txHash: '0xbeef', success: status === 'success' });
    });
  }

  test('receipt failure preserves the hash notification and the original exception', async () => {
    const order: string[] = [];
    const error = new Error('Timed out');
    await expect(submitWalletTransaction(
      async () => { order.push('send'); return '0xbeef'; },
      async () => { order.push('wait'); throw error; },
      (hash) => { order.push(`broadcast:${hash}`); },
    )).rejects.toBe(error);
    expect(order).toEqual(['send', 'broadcast:0xbeef', 'wait']);
  });

  test('a declined send neither notifies nor waits for a receipt', async () => {
    const order: string[] = [];
    const error = new Error('User rejected');
    await expect(submitWalletTransaction(
      async () => { throw error; },
      async () => { order.push('wait'); return { status: 'success' }; },
      () => { order.push('broadcast'); },
    )).rejects.toBe(error);
    expect(order).toEqual([]);
  });
});

describe('runReshield retries a relayer fee that outgrew the estimate', () => {
  const estimate: ReshieldEstimateLike = {
    feeAmount: '0x2710',
    netSwapAmount: '0xf4240',
    estimatedOutput: '0xf3e58',
    estimatedMinOutput: '0xf1b30',
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8',
    totalDepositCost: '0xf4240',
  };
  const quote: PreparedReshieldQuoteLike = {
    selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: '0x2710' } },
    swapCalldata: '0xcafe' as Hex,
    feeAmount: '0x2710',
    netAmount: '0xf4240' as Hex,
    swapTarget: SWAP_TARGET,
    approvalAddress: APPROVAL_ADDR,
    dustRecipient: DUST,
  };
  // The SDK's own wording (assertLifiBudget), Mike's 25 USDT swap on 2026-09-28.
  const DRIFT = new Error('Invalid transact params: LiFi needs 18524300000000000000 input but only 18219100000000000000 available after fee. Reduce the amount or retry.');

  const run = (failures: number, error: Error = DRIFT) => {
    const counts = { estimate: 0, deposit: 0, quote: 0, relay: 0 };
    const session: ReshieldSessionLike = {
      estimateReshieldAmount: async () => { counts.estimate += 1; return estimate; },
      prepareDeposit: async () => { counts.deposit += 1; return { pendingNote: { isOwned: true, commitment: h2('a'), value: '0xf3e58' as Hex } }; },
      prepareReshieldQuote: async () => {
        counts.quote += 1;
        if (counts.quote <= failures) throw error;
        return quote;
      },
      relayReshield: async () => { counts.relay += 1; return { txHash: '0xabc' as Hex, status: true }; },
    };
    const result = runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
    });
    return { result, counts };
  };

  test('one drift: re-estimates, re-proves, and relays once', async () => {
    const { result, counts } = run(1);
    expect((await result).receipt.txHash).toBe('0xabc');
    expect(counts).toEqual({ estimate: 2, deposit: 2, quote: 2, relay: 1 });
  });

  test('gives up after the attempt cap with the SDK error, relaying nothing', async () => {
    const { result, counts } = run(99);
    await expect(result).rejects.toThrow('available after fee');
    expect(counts.quote).toBe(RESHIELD_FEE_DRIFT_MAX_ATTEMPTS);
    expect(counts.relay).toBe(0);
  });

  test('any other refusal is not retried', async () => {
    const { result, counts } = run(99, new Error('Deposit value 1 is below the Entrypoint minimum 10'));
    await expect(result).rejects.toThrow('Entrypoint minimum');
    expect(counts.quote).toBe(1);
  });
});

describe('runReshield never retries past the relay', () => {
  test('a drift error from the relay step is thrown, not retried', async () => {
    const estimate: ReshieldEstimateLike = {
      feeAmount: '0x2710', netSwapAmount: '0xf4240', estimatedOutput: '0xf3e58',
      estimatedMinOutput: '0xf1b30', noteValue: '0xf3e58' as Hex, vettingFee: '0x3e8', totalDepositCost: '0xf4240',
    };
    let relays = 0;
    const session: ReshieldSessionLike = {
      estimateReshieldAmount: async () => estimate,
      prepareDeposit: async () => ({ pendingNote: { isOwned: true, commitment: h2('a'), value: '0xf3e58' as Hex } }),
      prepareReshieldQuote: async () => ({
        selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: '0x2710' } },
        swapCalldata: '0xcafe' as Hex, feeAmount: '0x2710', netAmount: '0xf4240' as Hex,
        swapTarget: SWAP_TARGET, approvalAddress: APPROVAL_ADDR, dustRecipient: DUST,
      }),
      relayReshield: async () => {
        relays += 1;
        throw new Error('Invalid transact params: LiFi needs 2 input but only 1 available after fee. Reduce the amount or retry.');
      },
    };
    await expect(runReshield(session, {
      chainId: 11155111, relayerInfo: {}, grossWei: 1_010_000n,
      inputToken: USDC, outputToken: USDT, inputCommitments: [COMMITMENT],
    })).rejects.toThrow('available after fee');
    expect(relays).toBe(1);
  });
});

describe('runReshield keeps the consent floor on a fee-drift retry', () => {
  test('a retried estimate below the reviewed floor refuses and relays nothing', async () => {
    const base: ReshieldEstimateLike = {
      feeAmount: '0x2710', netSwapAmount: '0xf4240', estimatedOutput: '0xf3e58',
      estimatedMinOutput: '0xf1b30', noteValue: '0xf3e58' as Hex, vettingFee: '0x3e8', totalDepositCost: '0xf4240',
    };
    let estimates = 0;
    let relays = 0;
    const session: ReshieldSessionLike = {
      // The fee rose, so the second estimate's note is smaller than the reviewed one.
      estimateReshieldAmount: async () => {
        estimates += 1;
        return estimates === 1 ? base : { ...base, noteValue: '0xe0000' as Hex };
      },
      prepareDeposit: async () => ({ pendingNote: { isOwned: true, commitment: h2('a'), value: '0xf3e58' as Hex } }),
      prepareReshieldQuote: async () => {
        throw new Error('Invalid transact params: LiFi needs 2 input but only 1 available after fee. Reduce the amount or retry.');
      },
      relayReshield: async () => { relays += 1; return { txHash: '0xabc' as Hex, status: true }; },
    };
    await expect(runReshield(session, {
      chainId: 11155111, relayerInfo: {}, grossWei: 1_010_000n,
      inputToken: USDC, outputToken: USDT, inputCommitments: [COMMITMENT],
      minNoteValueWei: 0xf0000n,
    })).rejects.toBeInstanceOf(ReshieldRateMovedError);
    expect(estimates).toBe(2);
    expect(relays).toBe(0);
  });
});

describe('runSwapAndDeposit sizes a yield deposit again (DEV-489)', () => {
  test('runSwapAndDeposit prepares again at the same amount instead of failing', async () => {
    const refusal = await sdkYieldSizingRefusal();
    const prepared: PreparedSwapDepositLike = {
      inputToken: USDC,
      estimatedInputAmount: '0x1' as Hex,
      approvalAddress: LIFI_PROXY,
      approvalTx: null,
      transactionData: '0xdead' as Hex,
      transactionTo: LIFI_DIAMOND,
      msgValue: '0x0' as Hex,
      estimatedDuration: 30,
    };
    const amounts: string[] = [];
    const session: SwapDepositSessionLike = {
      prepareSwapAndDeposit: async (p) => {
        amounts.push(p.depositAmount);
        if (amounts.length === 1) throw refusal;
        return prepared;
      },
    };
    const result = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 16_202_600_000_000_000_000n,
      submit: async () => ({ txHash: '0xfeed' as Hex, success: true }),
    });
    expect(amounts).toHaveLength(2);
    expect(amounts[0]).toBe(amounts[1]);
    expect(result.depositAmountWei).toBe(16_202_600_000_000_000_000n);
  });
});

// A swap-send is a reshield whose new note is FOR someone else
// (reshield-and-transfer, v2-monorepo #439). It reuses runReshield's gates and
// swaps only the four SDK calls, so these tests pin the parts that must differ.
describe('runReshield as a swap-send (reshield-and-transfer)', () => {
  const RECIPIENT = '0x6666666666666666666666666666666666666666' as Address;
  const recipient = { discoveryData: { evmAddress: RECIPIENT } };
  const estimate: ReshieldEstimateLike = {
    feeAmount: '0x2710',
    netSwapAmount: '0xf4240',
    estimatedOutput: '0xf3e58',
    estimatedMinOutput: '0xf1b30',
    noteValue: '0xf3e58' as Hex,
    vettingFee: '0x3e8',
    totalDepositCost: '0xf4240',
  };
  const quote: PreparedReshieldQuoteLike = {
    selectedQuote: { quote: { feeCommitment: { amountSent: toHex(1_010_000n) }, feeAmount: '0x2710' } },
    swapCalldata: '0xcafe' as Hex,
    feeAmount: '0x2710',
    netAmount: '0xf4240' as Hex,
    swapTarget: SWAP_TARGET,
    approvalAddress: APPROVAL_ADDR,
    dustRecipient: DUST,
  };
  const never = async (): Promise<never> => { throw new Error('the own-note call must not run for a swap-send'); };
  const run = (session: ReshieldSessionLike & Partial<ReshieldTransferSessionLike>, extra: Record<string, unknown> = {}) =>
    runReshield(session, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      inputCommitments: [COMMITMENT],
      recipient,
      ...extra,
    });
  const makeSession = (over: Partial<ReshieldTransferSessionLike> = {}) => {
    const calls: Record<string, unknown> = {};
    const order: string[] = [];
    const session: ReshieldSessionLike & ReshieldTransferSessionLike = {
      // The own-note calls exist on a real session; they must stay untouched.
      estimateReshieldAmount: never,
      prepareDeposit: never,
      prepareReshieldQuote: never,
      relayReshield: never,
      estimateReshieldTransferAmount: async (p) => { order.push('estimate'); calls.estimate = p; return estimate; },
      prepareReshieldTransferDeposit: async (p) => {
        order.push('deposit');
        calls.deposit = p;
        // The SDK hands one back; it is the recipient's, so it must not leak.
        return { pendingNote: { isOwned: false, commitment: h2('b'), value: '0xf3e58' as Hex } };
      },
      prepareReshieldTransferQuote: async (p) => { order.push('quote'); calls.quote = p; return quote; },
      relayReshieldTransfer: async (p) => {
        order.push('relay');
        calls.relay = p;
        return { txHash: '0xabc' as Hex, status: true };
      },
      ...over,
    };
    return { session, calls, order };
  };

  test('runs the four transfer calls in order and never the own-note ones', async () => {
    const { session, order } = makeSession();
    const result = await run(session);
    expect(order).toEqual(['estimate', 'deposit', 'quote', 'relay']);
    expect(result.receipt.txHash).toBe('0xabc');
  });

  test('builds the deposit FOR the recipient, sized off the estimate budget', async () => {
    const { session, calls } = makeSession();
    await run(session);
    // noteValue rides along for a plain pool asset (the SDK deposits exactly that
    // value and charges the vetting fee on top, already inside totalDepositCost).
    expect(calls.deposit).toEqual({
      discoveryData: { evmAddress: RECIPIENT },
      outputToken: USDT,
      totalDepositCost: estimate.totalDepositCost,
      noteValue: estimate.noteValue,
    });
  });

  // The sender must never persist a note it does not own: storing it would put
  // someone else's funds in the sender's balance.
  test('returns no note to store, even though the SDK hands one back', async () => {
    const { session } = makeSession();
    const result = await run(session);
    expect(result.pendingNote).toBeUndefined();
  });

  test('the relay carries no depositNote and echoes the signed routing', async () => {
    const { session, calls } = makeSession();
    await run(session);
    const relay = calls.relay as Record<string, unknown>;
    expect('depositNote' in relay).toBe(false);
    expect(relay.amount).toBe(quote.netAmount);
    expect(relay.swapTarget).toBe(SWAP_TARGET);
    expect(relay.approvalAddress).toBe(APPROVAL_ADDR);
    expect(relay.dustRecipient).toBe(DUST);
  });

  test('a session without the transfer calls is refused before any estimate', async () => {
    const own: ReshieldSessionLike = {
      estimateReshieldAmount: never,
      prepareDeposit: never,
      prepareReshieldQuote: never,
      relayReshield: never,
    };
    await expect(run(own)).rejects.toBeInstanceOf(ReshieldPreflightError);
    await expect(run(own)).rejects.toThrow(/not available on this network/);
  });

  test('a reverted receipt is a failure, not "sent"', async () => {
    const { session } = makeSession({
      relayReshieldTransfer: async () => ({ txHash: '0xdead' as Hex, status: false }),
    });
    await expect(run(session)).rejects.toBeInstanceOf(ReshieldRevertedError);
  });

  test('the consent floor still applies: a worse route than reviewed asks again', async () => {
    const { session, order } = makeSession();
    await expect(run(session, { minNoteValueWei: hexToBigInt(estimate.noteValue) + 1n }))
      .rejects.toBeInstanceOf(ReshieldRateMovedError);
    expect(order).toEqual(['estimate']);
  });

  test('Review prices a swap-send through the transfer estimate', async () => {
    const seen: string[] = [];
    const session = {
      estimateReshieldAmount: async () => { seen.push('own'); return estimate; },
      estimateReshieldTransferAmount: async () => { seen.push('transfer'); return estimate; },
    };
    await estimateReshieldForReview(session as never, {
      chainId: 11155111,
      relayerInfo: {},
      grossWei: 1_010_000n,
      inputToken: USDC,
      outputToken: USDT,
      input: { symbol: 'USDC', decimals: 6 },
      output: { symbol: 'USDT', decimals: 6 },
      transfer: true,
    });
    expect(seen).toEqual(['transfer']);
  });
});
