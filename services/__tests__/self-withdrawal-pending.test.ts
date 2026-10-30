import { describe, expect, test } from 'bun:test';
import {
  classifyDirectReceipt,
  directPendingMessage,
  isDirectPendingMessage,
  releasesSubmitGuard,
  SELF_WITHDRAW_METHOD,
} from '../self-withdrawal-pending';
import {
  addPendingRelay,
  findBlockingRelay,
  isPendingRelayBlocked,
  PendingRelayBlockedError,
  settleByReceipt,
  type PendingRelay,
} from '../pending-relays-core';

const HASH = `0x${'ab'.repeat(32)}`;
const N1 = '0x1111';
const T0 = 1_790_000_000_000;

describe('a receipt that cannot be read after the wallet broadcast', () => {
  test('is "sent, not confirmed yet", never a revert and never retryable', () => {
    expect(classifyDirectReceipt(null, true)).toEqual({ kind: 'sent-unconfirmed' });
    expect(classifyDirectReceipt(undefined, false)).toEqual({ kind: 'sent-unconfirmed' });
    // Even a receipt in hand does not count when the lookup itself failed.
    expect(classifyDirectReceipt({ status: 'reverted', blockNumber: 1n }, true)).toEqual({ kind: 'sent-unconfirmed' });
  });

  test('a real receipt decides: success confirms, reverted reverts', () => {
    expect(classifyDirectReceipt({ status: 'success', blockNumber: 42n }, false)).toEqual({ kind: 'confirmed', blockNumber: 42n });
    expect(classifyDirectReceipt({ status: 'reverted', blockNumber: 42n }, false)).toEqual({ kind: 'reverted' });
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
    const waitAt = branch.indexOf('waitForTransactionReceipt(');
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt).toBeLessThan(sendAt);
    expect(sendAt).toBeLessThan(recordAt);
    expect(recordAt).toBeLessThan(waitAt);
  });

  test('the shared catch only releases the submit guard through releasesSubmitGuard', () => {
    expect(source).toContain('if (releasesSubmitGuard(message)) submittedRef.current = false;');
  });
});
