import { describe, expect, test } from 'bun:test';

import {
  runSwapAndDeposit,
  SwapDepositPreflightError,
  type PreparedSwapDepositLike,
  type SwapDepositSessionLike,
} from '@/services/swap-flows';
import { BatchNotSubmittedError, submitAtomicBatch, supportsAtomicBatch, type WalletBatchDeps } from '@/services/wallet-batch';
import type { Address, Hex } from '@/services/sdk-types';

// EIP-5792: approve + swap as one atomic wallet call where the wallet supports
// it on the chain, the step-by-step path everywhere else.

const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address;
const USDT = '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Address;
const LIFI_PROXY = '0x68E1Acfa805dcA813116Ed6507E01c38D44318f0' as Address;
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address;

function approveCalldata(spender: string, value = 1n): Hex {
  const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
  return `0x095ea7b3${word(spender)}${word(value.toString(16))}` as Hex;
}

const prepared: PreparedSwapDepositLike = {
  inputToken: USDC,
  estimatedInputAmount: '0x1e8480' as Hex,
  approvalAddress: LIFI_PROXY,
  approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY, 2_000_000n) },
  transactionData: '0xdead' as Hex,
  transactionTo: LIFI_DIAMOND,
  msgValue: '0x0' as Hex,
  estimatedDuration: 45,
};

const session: SwapDepositSessionLike = { prepareSwapAndDeposit: async () => prepared };

function harness(opts: {
  batch?: 'ok' | 'reverted' | 'unsupported' | 'absent';
  routeValidated?: boolean;
  unlimitedApproval?: boolean;
}) {
  const submitted: string[] = [];
  const batches: { to: string; data: string }[][] = [];
  const beforeSwap: number[] = [];
  const broadcasts: string[] = [];
  const run = () => runSwapAndDeposit(opts.unlimitedApproval ? { prepareSwapAndDeposit: async () => ({ ...prepared, approvalTx: { to: USDC, data: approveCalldata(LIFI_PROXY, (1n << 256n) - 1n) } }) } : session, {
    depositChainId: 11155111,
    fromChainId: 1,
    inputToken: USDC,
    depositToken: USDT,
    depositAmountWei: 1n,
    submit: async (_tx, kind) => {
      submitted.push(kind);
      return { txHash: (kind === 'swap' ? '0x5a' : '0xa1') as Hex, success: true };
    },
    ...(opts.batch && opts.batch !== 'absent'
      ? {
        submitBatch: async (txs, onBroadcast) => {
          // Claim backup/confirmation must finish before a batch can prompt.
          expect(beforeSwap).toEqual([1]);
          if (opts.batch === 'unsupported') return null;
          batches.push(txs.map((tx) => ({ to: tx.to, data: tx.data })));
          onBroadcast?.('0xba' as Hex);
          return { txHash: '0xba' as Hex, success: opts.batch === 'ok' };
        },
      }
      : {}),
    ...(opts.routeValidated === false
      ? {}
      : { simulateWithAllowance: async () => ({ ok: true, supported: true }) }),
    beforeSwapSubmit: async () => { beforeSwap.push(1); },
    onSwapBroadcast: (hash) => { broadcasts.push(hash); },
  });
  return { run, submitted, batches, beforeSwap, broadcasts };
}

describe('runSwapAndDeposit with an atomic batch (EIP-5792)', () => {
  test('a validated route sends approval and swap as one call, nothing step by step', async () => {
    const h = harness({ batch: 'ok' });
    const result = await h.run();
    expect(h.batches).toEqual([[
      { to: USDC, data: approveCalldata(LIFI_PROXY, 2_000_000n) },
      { to: LIFI_DIAMOND, data: '0xdead' },
    ]]);
    expect(h.submitted).toEqual([]);
    expect(result.txHash).toBe('0xba');
    expect(h.beforeSwap).toEqual([1]);
    expect(h.broadcasts).toEqual(['0xba']);
  });

  test('replaces an external unlimited approval with the exact reviewed input', async () => {
    const h = harness({batch:'ok',unlimitedApproval:true});
    await h.run();
    expect(h.batches[0][0].data.toLowerCase()).toBe(approveCalldata(LIFI_PROXY,2_000_000n).toLowerCase());
  });

  test('a wallet that cannot batch falls back to approve then swap, asking beforeSwapSubmit once', async () => {
    const h = harness({ batch: 'unsupported' });
    const result = await h.run();
    expect(h.submitted).toEqual(['approval', 'swap']);
    expect(result.txHash).toBe('0x5a');
    expect(h.beforeSwap).toEqual([1]);
  });

  test('a reverted batch is reported as nothing shielded', async () => {
    const h = harness({ batch: 'reverted' });
    const thrown = await h.run().catch((err) => err);
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    expect((thrown as Error).message).toMatch(/nothing was shielded/);
    expect(h.submitted).toEqual([]);
    // Same as the single swap: the hash is reported when it exists, and the
    // revert then fails the run, as a reverted single swap does.
    expect(h.broadcasts).toEqual(['0xba']);
  });

  test('a route not proven before approval never batches', async () => {
    const h = harness({ batch: 'ok', routeValidated: false });
    await h.run();
    expect(h.batches).toEqual([]);
    expect(h.submitted).toEqual(['approval', 'swap']);
  });

  test('without submitBatch the flow is unchanged', async () => {
    const h = harness({ batch: 'absent' });
    await h.run();
    expect(h.submitted).toEqual(['approval', 'swap']);
  });
});

describe('submitAtomicBatch', () => {
  const calls = [{ to: USDC, data: '0x01' }, { to: LIFI_DIAMOND, data: '0x02' }];
  const deps = (over: Partial<WalletBatchDeps> = {}): WalletBatchDeps & { sent: number } => {
    const state = { sent: 0 };
    return Object.assign(state, {
      getCapabilities: async () => ({ atomic: { status: 'supported' } }),
      sendCalls: async () => { state.sent++; return { id: 'bundle-1' }; },
      getCallsStatus: async () => ({ status: 'success', receipts: [{ transactionHash: '0xabc', status: 'success' }] }),
      sleep: async () => {},
      ...over,
    });
  };

  test('requires the current atomic capability', () => {
    expect(supportsAtomicBatch({ atomic: { status: 'supported' } })).toBe(true);
    expect(supportsAtomicBatch({ atomic: { status: 'ready' } })).toBe(true);
    expect(supportsAtomicBatch({ atomic: { status: 'unsupported' } })).toBe(false);
    expect(supportsAtomicBatch({ atomicBatch: { supported: true } })).toBe(false);
    expect(supportsAtomicBatch({})).toBe(false);
    expect(supportsAtomicBatch(undefined)).toBe(false);
  });

  test('sends once and reports the mined hash', async () => {
    const d = deps();
    const hashes: string[] = [];
    const result = await submitAtomicBatch(d, { chainId: 1, calls, onBroadcast: (h) => hashes.push(h) });
    expect(result).toEqual({ txHash: '0xabc' as Hex, success: true });
    expect(d.sent).toBe(1);
    expect(hashes).toEqual(['0xabc']);
  });

  test('a wallet without wallet_getCapabilities (Rabby) gets null and nothing is sent', async () => {
    const d = deps({ getCapabilities: async () => { throw Object.assign(new Error('nope'), { code: 4200 }); } });
    expect(await submitAtomicBatch(d, { chainId: 56, calls })).toBeNull();
    expect(d.sent).toBe(0);
  });

  test('a chain the wallet cannot batch on gets null and nothing is sent', async () => {
    const d = deps({ getCapabilities: async () => ({ atomic: { status: 'unsupported' } }) });
    expect(await submitAtomicBatch(d, { chainId: 56, calls })).toBeNull();
    expect(d.sent).toBe(0);
  });

  test('a method-not-supported answer to sendCalls is null, a user rejection is thrown', async () => {
    const unsupported = deps({ sendCalls: async () => { throw Object.assign(new Error('x'), { code: 4200 }); } });
    expect(await submitAtomicBatch(unsupported, { chainId: 1, calls })).toBeNull();
    const rejected = deps({ sendCalls: async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); } });
    await expect(submitAtomicBatch(rejected, { chainId: 1, calls })).rejects.toThrow('User rejected');
  });

  test('a failed bundle is reported as not successful', async () => {
    const d = deps({ getCallsStatus: async () => ({ status: 'failure', receipts: [{ transactionHash: '0xdef', status: 'reverted' }] }) });
    expect(await submitAtomicBatch(d, { chainId: 1, calls })).toEqual({ txHash: '0xdef' as Hex, success: false });
  });
});

describe('submitAtomicBatch follows the bundle until it has a hash', () => {
  const calls = [{ to: USDC, data: '0x01' }];
  const base = (statuses: Array<{ status: string; receipts?: { transactionHash?: string; status?: string }[] } | Error>): WalletBatchDeps & { reads: number } => {
    const state = { reads: 0 };
    return Object.assign(state, {
      getCapabilities: async () => ({ atomic: { status: 'supported' } }),
      sendCalls: async () => ({ id: 'bundle' }),
      getCallsStatus: async () => {
        const next = statuses[Math.min(state.reads, statuses.length - 1)]!;
        state.reads++;
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async () => {},
    });
  };

  test('reports the hash the moment a read carries one, before the final status', async () => {
    const events: string[] = [];
    const d = base([
      { status: 'pending' },
      { status: 'pending', receipts: [{ transactionHash: '0x77' }] },
      { status: 'success', receipts: [{ transactionHash: '0x77', status: 'success' }] },
    ]);
    const result = await submitAtomicBatch(d, { chainId: 1, calls, onBroadcast: (h) => events.push(`broadcast:${h}:${d.reads}`) });
    expect(events).toEqual(['broadcast:0x77:2']);
    expect(result).toEqual({ txHash: '0x77' as Hex, success: true });
  });

  test('a failed status read is not an outcome: it keeps following the bundle', async () => {
    const d = base([new Error('rpc hiccup'), { status: 'success', receipts: [{ transactionHash: '0x88', status: 'success' }] }]);
    expect(await submitAtomicBatch(d, { chainId: 1, calls })).toEqual({ txHash: '0x88' as Hex, success: true });
  });

  test('success without a transaction hash is an unknown outcome, never success', async () => {
    const d = base([{ status: 'success', receipts: [] }]);
    await expect(submitAtomicBatch(d, { chainId: 1, calls })).rejects.toThrow(/outcome is unknown/);
  });

  test('a bundle that never settles throws as not confirmed, naming the hash it saw', async () => {
    const d = base([{ status: 'pending', receipts: [{ transactionHash: '0x99' }] }]);
    await expect(submitAtomicBatch(d, { chainId: 1, calls })).rejects.toThrow(/not confirmed in time \(transaction 0x99\)/);
  });
});

describe('batch failures read the allowance back and say only what is true (codex review)', () => {
  test('a reverted batch over an older allowance reads it back and hands it back', async () => {
    const revoked: string[] = [];
    const reads: string[] = [];
    const thrown = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async (tx, kind) => {
        if (kind === 'revoke') revoked.push(tx.data);
        return { txHash: '0x5e' as Hex, success: true };
      },
      submitBatch: async () => ({ txHash: '0xba' as Hex, success: false }),
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
      // The token still reports the allowance that stood before this run.
      readAllowance: async (_token, spender) => { reads.push(spender); return 1_000_000n; },
    }).catch((err) => err);
    expect(thrown).toBeInstanceOf(SwapDepositPreflightError);
    expect((thrown as Error).message).not.toMatch(/no approval was left/);
    expect(reads.length).toBeGreaterThan(0);
    expect(revoked.map((d) => d.toLowerCase())).toEqual([approveCalldata(LIFI_PROXY, 0n).toLowerCase()]);
  });

  test('a batch the wallet never included is reported as nothing sent', async () => {
    const thrown = await runSwapAndDeposit(session, {
      depositChainId: 11155111,
      fromChainId: 1,
      inputToken: USDC,
      depositToken: USDT,
      depositAmountWei: 1n,
      submit: async () => ({ txHash: '0x5e' as Hex, success: true }),
      submitBatch: async () => { throw new BatchNotSubmittedError('The wallet did not submit the approve and swap batch, so nothing was sent.'); },
      simulateWithAllowance: async () => ({ ok: true, supported: true }),
    }).catch((err) => err);
    expect((thrown as Error).message).toBe('The wallet did not submit the approve and swap batch, so nothing was sent.');
  });

  test('status 4xx with no receipts is a definitive not-submitted, not an unknown outcome', async () => {
    const deps: WalletBatchDeps = {
      getCapabilities: async () => ({ atomic: { status: 'supported' } }),
      sendCalls: async () => ({ id: 'b' }),
      getCallsStatus: async () => ({ status: 'failure', statusCode: 400, receipts: [] }),
      sleep: async () => {},
    };
    await expect(submitAtomicBatch(deps, { chainId: 1, calls: [{ to: USDC, data: '0x01' }] })).rejects.toBeInstanceOf(BatchNotSubmittedError);
  });

  test('a method-not-supported error wrapped by viem still falls back with nothing sent', async () => {
    const wrapped = Object.assign(new Error('Transaction failed'), {
      name: 'TransactionExecutionError',
      cause: Object.assign(new Error('Method not supported'), { name: 'MethodNotSupportedRpcError', code: -32004 }),
    });
    const deps: WalletBatchDeps = {
      getCapabilities: async () => ({ atomic: { status: 'supported' } }),
      sendCalls: async () => { throw wrapped; },
      getCallsStatus: async () => ({ status: 'success', receipts: [] }),
      sleep: async () => {},
    };
    expect(await submitAtomicBatch(deps, { chainId: 1, calls: [{ to: USDC, data: '0x01' }] })).toBeNull();
  });
});
