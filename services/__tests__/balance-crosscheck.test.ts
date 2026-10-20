import { describe, expect, test } from 'bun:test';
import {
  balanceCrossCheckLogPayload,
  balanceIsOverstated,
  captureRpcProvenSpent,
  crossCheckBalance,
  finalizedRpcProof,
} from '../balance-crosscheck';

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const note = (commitment: string, value: string, tokenId = ETH) => ({ commitment, value, tokenId });

/** Every note answers the same way, so each test states only what it varies. */
const all = (spent: boolean | null, observed = true) => ({
  isSpentOnChain: () => spent,
  isObservedOnChain: () => observed,
});

describe('crossCheckBalance', () => {
  test('a clean portfolio reports nothing to act on', () => {
    const r = crossCheckBalance({ notes: [note('0xa', '0x10'), note('0xb', '0x20')], ...all(false) });
    expect(r).toMatchObject({ checked: 2, provenSpent: 0, unobserved: 0, indeterminate: 0 });
    expect(r.provenSpentCommitments).toEqual([]);
    expect(balanceIsOverstated(r)).toBe(false);
  });

  test('a note the chain proves spent is the overstatement, and is named for healing', () => {
    const r = crossCheckBalance({
      notes: [note('0xa', '0x10'), note('0xb', '0x20')],
      isSpentOnChain: (c) => c === '0xb',
      isObservedOnChain: () => true,
    });
    expect(r.provenSpent).toBe(1);
    expect(r.provenSpentCommitments).toEqual(['0xb']);
    expect(r.provenSpentValueByToken).toEqual({ [ETH.toLowerCase()]: '32' });
    expect(balanceIsOverstated(r)).toBe(true);
  });

  test('overstated value is summed PER TOKEN — the native sentinel is shared across chains', () => {
    const r = crossCheckBalance({
      notes: [note('0xa', '0x10'), note('0xb', '0x20'), note('0xc', '5', USDC)],
      ...all(true),
    });
    expect(r.provenSpentValueByToken).toEqual({
      [ETH.toLowerCase()]: '48',
      [USDC.toLowerCase()]: '5',
    });
  });

  test('decimal and hex values both sum, and a token id is compared case-insensitively', () => {
    const r = crossCheckBalance({
      notes: [note('0xa', '0x0a', ETH.toUpperCase()), note('0xb', '10', ETH.toLowerCase())],
      ...all(true),
    });
    expect(r.provenSpentValueByToken).toEqual({ [ETH.toLowerCase()]: '20' });
  });

  test('an unparseable value is still counted as spent, just not summed', () => {
    // Dropping the note because its value is malformed would leave the balance
    // overstated by exactly the note we proved was gone.
    const r = crossCheckBalance({ notes: [note('0xa', 'not-a-number')], ...all(true) });
    expect(r.provenSpent).toBe(1);
    expect(r.provenSpentCommitments).toEqual(['0xa']);
    expect(r.provenSpentValueByToken).toEqual({});
  });

  test('ABSENCE is reported, never promoted to a spend', () => {
    // The index lags the chain, and answering from that absence has already
    // dropped a payee's just-received note once.
    const r = crossCheckBalance({ notes: [note('0xa', '0x10')], ...all(false, false) });
    expect(r).toMatchObject({ unobserved: 1, provenSpent: 0 });
    expect(balanceIsOverstated(r)).toBe(false);
  });

  test('a spent note is never also counted unobserved — proof outranks absence', () => {
    const r = crossCheckBalance({ notes: [note('0xa', '0x10')], ...all(true, false) });
    expect(r).toMatchObject({ provenSpent: 1, unobserved: 0 });
  });

  test('an unanswerable nullifier is indeterminate, NOT spent', () => {
    // The failure direction matters: treating "cannot tell" as spent would
    // mark real money gone.
    const r = crossCheckBalance({ notes: [note('0xa', '0x10')], ...all(null) });
    expect(r).toMatchObject({ indeterminate: 1, provenSpent: 0, unobserved: 0 });
  });

  test('a predicate that throws is no evidence, never evidence of a spend', () => {
    const r = crossCheckBalance({
      notes: [note('0xa', '0x10')],
      isSpentOnChain: () => { throw new Error('rpc gone'); },
      isObservedOnChain: () => true,
    });
    expect(r).toMatchObject({ indeterminate: 1, provenSpent: 0 });
  });

  test('a throwing observation predicate degrades to indeterminate, not to a false alarm', () => {
    const r = crossCheckBalance({
      notes: [note('0xa', '0x10')],
      isSpentOnChain: () => false,
      isObservedOnChain: () => { throw new Error('boom'); },
    });
    expect(r).toMatchObject({ indeterminate: 1, unobserved: 0, provenSpent: 0 });
  });

  test('no notes is a clean report, not a divergence', () => {
    const r = crossCheckBalance({ notes: [], ...all(true) });
    expect(r).toMatchObject({ checked: 0, provenSpent: 0 });
    expect(balanceIsOverstated(r)).toBe(false);
  });

  test('the actual caller-bound log payload contains public context and counts only', () => {
    const r = crossCheckBalance({ notes: [note('0xa', '0x10')], ...all(true) });
    expect(balanceCrossCheckLogPayload(r, { chainId: 11155111, markedSpent: 1, markedExited: 0 })).toEqual({
      chainId: 11155111,
      checked: 1,
      provenSpent: 1,
      unobserved: 0,
      indeterminate: 0,
      markedSpent: 1,
      markedExited: 0,
    });
  });
});

describe('captureRpcProvenSpent', () => {
  test('constructing and querying the capture adds no request', () => {
    let calls = 0;
    const source = {
      getStateLeaves: async () => { calls += 1; return []; },
      getDepositedEvents: async () => { calls += 1; return []; },
      getTransactedEvents: async () => { calls += 1; return []; },
      getRagequitEvents: async () => { calls += 1; return []; },
    };
    const capture = captureRpcProvenSpent(source);
    expect(capture.proofOf('0xabc')).toBeNull();
    expect(capture.isProvenSpent('0xabc')).toBe(false);
    expect(calls).toBe(0);
  });

  test('forwarded RPC terminal reads retain proof kind and block provenance', async () => {
    const transacted = [{
      blockNumber: '0x10' as const,
      txHash: '0xaaa' as const,
      outputCommitments: ['0xc1' as const],
      nullifierHashes: ['0xAbC' as const],
    }];
    const ragequits = [{
      blockNumber: '0x11' as const,
      txHash: '0xbbb' as const,
      commitment: '0xc2' as const,
      nullifierHash: '0xdef' as const,
    }];
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    const capture = captureRpcProvenSpent({
      getStateLeaves: async () => [],
      getDepositedEvents: async () => [],
      getTransactedEvents: async (from, to) => {
        calls.push(['transacted', from, to]);
        return transacted;
      },
      getRagequitEvents: async (from, to) => {
        calls.push(['ragequit', from, to]);
        return ragequits;
      },
    });

    expect(capture.isProvenSpent('0xabc')).toBe(false);
    expect(await capture.interactor.getTransactedEvents('0x1', '0x20')).toBe(transacted);
    expect(capture.isProvenSpent('0xabc')).toBe(true);
    expect(capture.proofOf('0xabc')).toEqual({
      terminalStatus: 'SPENT', blockNumber: '0x10', txHash: '0xaaa',
    });
    expect(await capture.interactor.getRagequitEvents('0x2', '0x21')).toBe(ragequits);
    expect(capture.isProvenSpent('0xdef')).toBe(true);
    expect(capture.proofOf('0xdef')).toEqual({
      terminalStatus: 'EXITED', blockNumber: '0x11', txHash: '0xbbb',
    });
    expect(calls).toEqual([
      ['transacted', '0x1', '0x20'],
      ['ragequit', '0x2', '0x21'],
    ]);
  });

  test('a proof is actionable only at or below the finalized block', () => {
    const proof = { terminalStatus: 'SPENT' as const, blockNumber: '0x10' as const };
    expect(finalizedRpcProof(proof, null)).toBeNull();
    expect(finalizedRpcProof(proof, 15n)).toBeNull();
    expect(finalizedRpcProof(proof, 16n)).toBe(proof);
    expect(finalizedRpcProof(proof, 17n)).toBe(proof);
  });

  test('contradictory terminal rows fail closed', async () => {
    const capture = captureRpcProvenSpent({
      getStateLeaves: async () => [],
      getDepositedEvents: async () => [],
      getTransactedEvents: async () => [{
        blockNumber: '0x10', outputCommitments: [], nullifierHashes: ['0xabc'],
      }],
      getRagequitEvents: async () => [{
        blockNumber: '0x11', commitment: '0xc1', nullifierHash: '0xabc',
      }],
    });
    await capture.interactor.getTransactedEvents();
    await capture.interactor.getRagequitEvents();
    expect(capture.proofOf('0xabc')).toBeNull();
    expect(capture.isProvenSpent('0xabc')).toBe(false);
  });
});

describe('nullifier keys are canonical, or the whole check silently no-ops', () => {
  const PADDED = `0x${(0xabcn).toString(16).padStart(64, '0')}`;
  const events = (nullifier: string) => ({
    getStateLeaves: async () => [],
    getDepositedEvents: async () => [],
    getTransactedEvents: async () => [
      { blockNumber: '0x64', txHash: '0xdead', outputCommitments: [], nullifierHashes: [nullifier] },
    ],
    getRagequitEvents: async () => [],
  });

  test('a chain log and a locally derived nullifier match across padding and case', async () => {
    // The chain emits a padded 32-byte word; the SDK hash service and the ASP
    // render the same value unpadded or in decimal. A raw lowercase key makes
    // every lookup miss, which would leave the cross-check finding nothing —
    // forever, and silently.
    for (const emitted of [PADDED, PADDED.toUpperCase(), '0xabc', '2748']) {
      const captured = captureRpcProvenSpent(events(emitted) as never);
      await captured.interactor.getTransactedEvents();
      for (const queried of [PADDED, '0xabc', '0xABC', '2748']) {
        expect(captured.isProvenSpent(queried)).toBe(true);
      }
    }
  });

  test('a nullifier that was never emitted stays unproven', async () => {
    const captured = captureRpcProvenSpent(events(PADDED) as never);
    await captured.interactor.getTransactedEvents();
    expect(captured.isProvenSpent('0x1')).toBe(false);
  });

  test('an unparseable nullifier does not collapse into a single bucket', async () => {
    const captured = captureRpcProvenSpent(events('zzz') as never);
    await captured.interactor.getTransactedEvents();
    expect(captured.isProvenSpent('zzz')).toBe(true);
    expect(captured.isProvenSpent('qqq')).toBe(false);
  });
});
