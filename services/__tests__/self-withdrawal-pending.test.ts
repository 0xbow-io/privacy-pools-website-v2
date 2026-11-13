import { describe, expect, test } from 'bun:test';
import {
  classifyDirectReceipt,
  directCancelledMessage,
  directPendingMessage,
  isDirectPendingMessage,
  releasesSubmitGuard,
  SELF_WITHDRAW_METHOD,
  waitForDirectWithdrawal,
} from '../self-withdrawal-pending';
import {
  addPendingRelay,
  findBlockingRelay,
  isPendingRelayBlocked,
  landedTxHash,
  PendingRelayBlockedError,
  settleByReceipt,
  settledByOtherSpend,
  type PendingRelay,
} from '../pending-relays-core';

const HASH = `0x${'ab'.repeat(32)}`;
const N1 = '0x1111';
const T0 = 1_790_000_000_000;

const H = HASH as `0x${string}`;
const classify = (receipt: Parameters<typeof classifyDirectReceipt>[0]['receipt'], failed: boolean) =>
  classifyDirectReceipt({ submittedHash: H, receipt, replacement: null, failed });

describe('a receipt that cannot be read after the wallet broadcast', () => {
  test('is "sent, not confirmed yet", never a revert and never retryable', () => {
    expect(classify(null, true)).toEqual({ kind: 'sent-unconfirmed' });
    expect(classify(undefined, false)).toEqual({ kind: 'sent-unconfirmed' });
    // Even a receipt in hand does not count when the lookup itself failed.
    expect(classify({ transactionHash: H, status: 'reverted', blockNumber: 1n }, true)).toEqual({ kind: 'sent-unconfirmed' });
  });

  test('a real receipt decides: success confirms, reverted reverts', () => {
    expect(classify({ transactionHash: H, status: 'success', blockNumber: 42n }, false)).toEqual({ kind: 'confirmed', blockNumber: 42n, minedHash: H });
    expect(classify({ transactionHash: H, status: 'reverted', blockNumber: 42n }, false)).toEqual({ kind: 'reverted', minedHash: H });
  });
});

// The receipts and the replacement signal come from viem's own
// waitForTransactionReceipt, driven over a scripted JSON-RPC node, so the
// classification is tested against what the real producer emits (including
// the successful receipt of a cancel), not a hand-written lookalike.
describe('own-wallet receipt wait through the real viem waitForTransactionReceipt', () => {
  const WALLET = '0x00000000000000000000000000000000000000a1';
  const POOL = '0x00000000000000000000000000000000000000b2';
  const SENT = `0x${'11'.repeat(32)}` as `0x${string}`;
  const MINED = `0x${'22'.repeat(32)}` as `0x${string}`;
  const CALLDATA = '0xdeadbeef';
  const BLOCK = 0x10;

  const rpcTx = (hash: string, fields: { to: string; value: string; input: string }, blockNumber: number | null) => ({
    hash, from: WALLET, nonce: '0x7', gas: '0x5208', gasPrice: '0x1', type: '0x0', chainId: '0x1',
    blockHash: blockNumber === null ? null : `0x${'cc'.repeat(32)}`,
    blockNumber: blockNumber === null ? null : `0x${blockNumber.toString(16)}`,
    transactionIndex: blockNumber === null ? null : '0x0',
    v: '0x25', r: '0x1', s: '0x1', ...fields,
  });
  const rpcReceipt = (hash: string, to: string, status: '0x1' | '0x0') => ({
    transactionHash: hash, from: WALLET, to, status, blockNumber: `0x${BLOCK.toString(16)}`,
    blockHash: `0x${'cc'.repeat(32)}`, transactionIndex: '0x0', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
    cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, type: '0x0',
  });

  /** A node where SENT sits in the mempool and `replacement` (or SENT itself) mines in BLOCK. */
  async function clientFor(scenario: 'confirmed' | 'reverted' | 'sped-up' | 'cancelled') {
    const { createPublicClient, custom } = await import('viem');
    const original = rpcTx(SENT, { to: POOL, value: '0x0', input: CALLDATA }, null);
    const replacement = scenario === 'sped-up'
      ? rpcTx(MINED, { to: POOL, value: '0x0', input: CALLDATA }, BLOCK)
      : scenario === 'cancelled'
        ? rpcTx(MINED, { to: WALLET, value: '0x0', input: '0x' }, BLOCK)
        : null;
    let polls = 0;
    const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
      const hash = Array.isArray(params) ? String(params[0]) : '';
      switch (method) {
        case 'eth_chainId': return '0x1';
        case 'eth_blockNumber': return `0x${BLOCK.toString(16)}`;
        case 'eth_getTransactionByHash':
          if (hash === SENT) return replacement ? original : { ...original, ...rpcTx(SENT, { to: POOL, value: '0x0', input: CALLDATA }, BLOCK) };
          if (replacement && hash === MINED) return replacement;
          return null;
        case 'eth_getTransactionReceipt':
          polls++;
          if (hash === SENT && !replacement && polls > 1) return rpcReceipt(SENT, POOL, scenario === 'reverted' ? '0x0' : '0x1');
          if (replacement && hash === MINED) return rpcReceipt(MINED, String(replacement.to), '0x1');
          return null;
        case 'eth_getBlockByNumber':
          return {
            number: `0x${BLOCK.toString(16)}`, hash: `0x${'cc'.repeat(32)}`, parentHash: `0x${'dd'.repeat(32)}`,
            timestamp: '0x1', gasLimit: '0x1', gasUsed: '0x1', miner: WALLET, nonce: '0x0', difficulty: '0x0',
            extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1',
            stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`,
            uncles: [], transactions: replacement ? [replacement] : [],
          };
        default: throw new Error(`unscripted ${method}`);
      }
    };
    return createPublicClient({ transport: custom({ request }), pollingInterval: 5 });
  }

  const wait = async (scenario: Parameters<typeof clientFor>[0]) =>
    (await waitForDirectWithdrawal(await clientFor(scenario), SENT)).outcome;

  test('a plain confirmation is confirmed under the sent hash', async () => {
    expect(await wait('confirmed')).toEqual({ kind: 'confirmed', blockNumber: BigInt(BLOCK), minedHash: SENT });
  });

  test('a revert is a revert', async () => {
    expect(await wait('reverted')).toEqual({ kind: 'reverted', minedHash: SENT });
  });

  test('a wallet cancel mines a SUCCESSFUL receipt but is never a confirmed withdrawal', async () => {
    const outcome = await wait('cancelled');
    expect(outcome).toEqual({ kind: 'cancelled', replacementHash: MINED });
  });

  test('a speed-up is confirmed under the MINED hash', async () => {
    expect(await wait('sped-up')).toEqual({ kind: 'confirmed', blockNumber: BigInt(BLOCK), minedHash: MINED });
  });

  test('no client, or a throwing wait, stays sent-unconfirmed', async () => {
    expect((await waitForDirectWithdrawal(null, SENT)).outcome).toEqual({ kind: 'sent-unconfirmed' });
    const boom = await waitForDirectWithdrawal({ async waitForTransactionReceipt() { throw new Error('timed out'); } }, SENT);
    expect(boom.outcome).toEqual({ kind: 'sent-unconfirmed' });
    expect((boom.error as Error).message).toBe('timed out');
  });

  test('the pending record: a cancel releases the inputs, a speed-up clears the sent record and names the mined hash', async () => {
    const record: PendingRelay = {
      id: `1:${SENT}`, chainId: 1, method: SELF_WITHDRAW_METHOD, nullifiers: [N1], txHash: SENT, owner: null, at: T0,
    };
    const list = addPendingRelay([], record, T0);

    const cancelled = await wait('cancelled');
    expect(cancelled.kind).toBe('cancelled');
    // What the provider does on 'cancelled': settle the sent hash as NOT spent.
    const released = settleByReceipt(list, SENT, false);
    expect(released.kept).toEqual([]);
    expect(released.settled[0].spent).toBe(false);
    expect(landedTxHash(released.settled[0])).toBeNull();
    expect(findBlockingRelay(released.kept, 1, [N1], T0 + 60_000)).toBeNull();

    const sped = await wait('sped-up');
    if (sped.kind !== 'confirmed') throw new Error(`expected confirmed, got ${sped.kind}`);
    // What finishDirectWithdrawal does: settle the SENT record, naming the mined hash.
    const settled = settleByReceipt(list, SENT, true, sped.minedHash);
    expect(settled.kept).toEqual([]);
    expect(settled.settled[0].spent).toBe(true);
    expect(settled.settled[0].spentBy).toBe(MINED);
    expect(settledByOtherSpend(settled.settled[0])).toBe(false);
    expect(landedTxHash(settled.settled[0])).toBe(MINED);
  });

  test('the cancel copy says nothing was spent and carries no em dash', () => {
    expect(directCancelledMessage()).toContain('NOT spent');
    expect(directCancelledMessage()).not.toContain('—');
    expect(releasesSubmitGuard(directCancelledMessage())).toBe(true);
  });
});

describe('the pending message and the submit guard', () => {
  test('names the hash and says not to withdraw again', () => {
    const message = directPendingMessage(HASH);
    expect(message).toContain(HASH.slice(0, 8));
    expect(message).toContain(HASH.slice(-6));
    expect(message).toContain('Do not withdraw these funds again');
    expect(message).toContain('can still land');
    expect(isDirectPendingMessage(message)).toBe(true);
  });

  test('only the pending state keeps the submit guard; every other failure releases it', () => {
    expect(releasesSubmitGuard(directPendingMessage(HASH))).toBe(false);
    expect(releasesSubmitGuard('Withdrawal failed: user rejected the request')).toBe(true);
    expect(releasesSubmitGuard('Withdrawal transaction reverted on-chain. Your notes were NOT spent.')).toBe(true);
  });
});

describe('a wallet-sent withdrawal blocks a second proof over the same notes', () => {
  const record = (): PendingRelay => ({
    id: `1:${HASH}`, chainId: 1, method: SELF_WITHDRAW_METHOD, nullifiers: [N1], txHash: HASH, owner: null, at: T0,
  });

  test('the recorded nullifiers block Confirm until it settles', () => {
    const list = addPendingRelay([], record(), T0);
    expect(findBlockingRelay(list, 1, [N1], T0 + 60_000)?.method).toBe(SELF_WITHDRAW_METHOD);
    // Another chain or other notes are not held.
    expect(findBlockingRelay(list, 10, [N1], T0 + 60_000)).toBeNull();
    expect(findBlockingRelay(list, 1, ['0x9999'], T0 + 60_000)).toBeNull();
  });

  test('the block reads as a wallet transaction and is recognised by the shared handler', () => {
    const err = new PendingRelayBlockedError(record(), T0 + 3 * 60_000);
    expect(err.message).toContain('from your wallet');
    expect(err.message).not.toContain('through the relayer');
    expect(isPendingRelayBlocked(err.message)).toBe(true);
  });

  test('a reverted receipt releases it, a confirmed one settles it as spent', () => {
    const list = addPendingRelay([], record(), T0);
    const reverted = settleByReceipt(list, HASH, false);
    expect(reverted.kept).toEqual([]);
    expect(reverted.settled[0].spent).toBe(false);
    const confirmed = settleByReceipt(list, HASH, true);
    expect(confirmed.settled[0].spent).toBe(true);
    expect(findBlockingRelay(reverted.kept, 1, [N1], T0 + 60_000)).toBeNull();
  });
});

describe('the withdraw modal wires the guard in the right order', () => {
  const source = require('node:fs').readFileSync(new URL('../../components/withdraw-modal-provider.tsx', import.meta.url), 'utf8') as string;
  const branch = source.slice(source.indexOf("reviewContext?.mode === 'direct') {\n        const sender"));

  test('a second wallet transaction is refused before the wallet is asked, and the hash is recorded before the receipt wait', () => {
    const assertAt = branch.indexOf('assertNoPendingRelay(chainId, directPrepared.spentNullifiers)');
    const sendAt = branch.indexOf('sendTransactionAsync(');
    const recordAt = branch.indexOf('recordPendingRelay({');
    const waitAt = branch.indexOf('waitForDirectWithdrawal(publicClient, directHash)');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(sendAt);
    expect(sendAt).toBeLessThan(recordAt);
    expect(recordAt).toBeLessThan(waitAt);
  });

  test('a cancelled withdrawal releases the record and returns before any note is marked spent', () => {
    const end = branch.indexOf("if (!activeFeeCommitment) {");
    const direct = branch.slice(0, end);
    const cancelAt = direct.indexOf("directOutcome.kind === 'cancelled'");
    const finishAt = direct.indexOf('await finishDirectWithdrawal(directFlight, directOutcome.blockNumber, directOutcome.minedHash');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(finishAt);
    const cancelBlock = direct.slice(cancelAt, finishAt);
    expect(cancelBlock).toContain('settlePendingRelayByReceipt(directHash, false)');
    expect(cancelBlock).toContain('throw new Error(directCancelledMessage())');
    expect(cancelBlock).not.toContain('markNotesSpent');
    // The own-wallet branch never reads the receipt status on its own.
    expect(direct).not.toContain('publicClient.waitForTransactionReceipt(');
  });

  test('a speed-up settles the SENT hash and records the MINED one everywhere after', () => {
    const start = source.indexOf('const finishDirectWithdrawal = useCallback(');
    const finish = source.slice(start, source.indexOf('const recheckDirectWithdrawal', start));
    expect(finish).toContain('settlePendingRelayByReceipt(flight.hash, true, minedHash)');
    expect(finish).toContain('txHash: minedHash');
    expect(finish).toContain('setTxHash(minedHash)');
    expect(finish).not.toContain('txHash: flight.hash');
    expect(finish).not.toContain('setTxHash(flight.hash)');
  });

  test('the shared catch only releases the submit guard through releasesSubmitGuard', () => {
    expect(source).toContain('if (releasesSubmitGuard(message)) submittedRef.current = false;');
  });
});
