import { describe, expect, mock, test } from 'bun:test';
import { RelayerRejected, TransactOrchestrator } from '@privacy-pools-v2/sdk';
import { encodeErrorResult, parseAbi, toFunctionSelector } from 'viem';
import {
  associationSetMovedPast,
  isPlainRelayRevert,
  mentionsInvalidAspRoot,
  POOL_VAULT_INVALID_ASP_ROOT_SELECTOR,
  proofAssociationSetRoot,
  RELAYED_REVERT_MESSAGE,
  RelayedRevertError,
  STALE_ASP_ROOT_MESSAGE,
  StaleAspRootError,
} from '@/services/stale-asp-root';
import { isStaleAspRootRejection } from '@/services/relayed-withdrawal';

// The pool's error, as the contract declares it. Everything below derives the
// selector and the revert data from this signature rather than restating them.
const POOL_ERRORS = parseAbi(['error PoolVault_InvalidASPRoot()']);
const revertData = encodeErrorResult({ abi: POOL_ERRORS, errorName: 'PoolVault_InvalidASPRoot' });

describe('PoolVault_InvalidASPRoot detection', () => {
  test('the selector constant is the one the error signature hashes to', () => {
    expect(toFunctionSelector('PoolVault_InvalidASPRoot()')).toBe(POOL_VAULT_INVALID_ASP_ROOT_SELECTOR);
    expect(revertData).toBe(POOL_VAULT_INVALID_ASP_ROOT_SELECTOR);
  });

  // The relayer's simulation refusal, by name (as seen in CI) and as bare revert data.
  for (const message of [
    'HTTP 400: {"message":"PoolVault transact failed: The contract function \\"transact\\" reverted (PoolVault_InvalidASPRoot).","error":"Bad Request","statusCode":400}',
    `HTTP 400: {"message":"execution reverted: ${revertData}","statusCode":400}`,
    `HTTP 400: {"message":"reverted with data ${revertData.toUpperCase().replace('0X', '0x')}"}`,
  ]) {
    test(`a RelayerRejected carrying it is a stale-root refusal: ${message.slice(0, 60)}`, () => {
      expect(mentionsInvalidAspRoot(message)).toBe(true);
      expect(isStaleAspRootRejection(new RelayerRejected(message))).toBe(true);
    });
  }

  test('only the relayer refusal class counts, not any error that mentions it', () => {
    expect(isStaleAspRootRejection(new Error(`Receipt wait failed: ${revertData}`))).toBe(false);
    expect(isStaleAspRootRejection(new RelayerRejected('HTTP 400: PoolVault_InvalidKeystoreRoot'))).toBe(false);
    expect(isStaleAspRootRejection(new RelayerRejected('HTTP 400: execution reverted: 0xbc158617'))).toBe(false);
  });
});

describe('proofAssociationSetRoot', () => {
  // Public signals in the transact circuit's layout, read back with the SDK's
  // own restructuring (the struct the pool checks) to pin the index.
  function relayParams(nInputs: number, mOutputs: number, aspRoot: bigint) {
    const signals: string[] = [];
    for (let i = 0; i < nInputs; i++) signals.push(`0x${(0x100 + i).toString(16)}`);
    for (let i = 0; i < mOutputs; i++) signals.push(`0x${(0x200 + i).toString(16)}`);
    signals.push('0x5157', '0x6b65', `0x${aspRoot.toString(16)}`, '0x64', '0x01', '0xc0');
    return {
      signedFeeCommitment: {},
      proof: { proof: { pi_a: [], pi_b: [], pi_c: [], protocol: 'groth16', curve: 'bn128' }, publicSignals: signals },
      noteData: [],
      inputNullifierNumber: nInputs,
      outputCommitmentNumber: mOutputs,
    };
  }

  for (const [n, m] of [[1, 1], [2, 1], [3, 2], [1, 0]] as const) {
    test(`reads the root the pool checks for ${n} inputs and ${m} outputs`, () => {
      const root = 0x1234_5678_9abc_def0_1122_3344_5566_7788n;
      const params = relayParams(n, m, root);
      const sdkView = (TransactOrchestrator.prototype as unknown as {
        restructureTransactPubSignals: (p: { publicSignals: string[] }, n: number, m: number) => bigint[][];
      }).restructureTransactPubSignals.call(null, params.proof, n, m);
      expect(sdkView[4][0]).toBe(root);
      expect(proofAssociationSetRoot(params)).toBe(root);
    });
  }

  test('anything without the transact shape gives null', () => {
    expect(proofAssociationSetRoot(null)).toBeNull();
    expect(proofAssociationSetRoot({ proof: { publicSignals: ['0x1'] }, inputNullifierNumber: 1, outputCommitmentNumber: 1 })).toBeNull();
    expect(proofAssociationSetRoot({ proof: {}, inputNullifierNumber: 1, outputCommitmentNumber: 1 })).toBeNull();
  });
});

describe('associationSetMovedPast', () => {
  const PROOF_ROOT = 0xabcn;
  const watch = (held: string | null, next: string | null = null) => ({
    held: () => held,
    next: mock(async (_timeoutMs?: number) => next),
  });

  test('a held root past the proof root is a move, without waiting', async () => {
    const w = watch(String(0xdefn));
    expect(await associationSetMovedPast(PROOF_ROOT, w, { wait: true })).toBe(true);
    expect(w.next).toHaveBeenCalledTimes(0);
  });

  test('the same root in decimal and hex is not a move', async () => {
    expect(await associationSetMovedPast(PROOF_ROOT, watch(String(PROOF_ROOT)), { wait: false })).toBe(false);
    expect(await associationSetMovedPast(PROOF_ROOT, watch('0x0abc'), { wait: false })).toBe(false);
  });

  test("an unmoved held root waits for the grid's next refresh", async () => {
    const w = watch('0xabc', '0xdef');
    expect(await associationSetMovedPast(PROOF_ROOT, w, { wait: true })).toBe(true);
    expect(w.next).toHaveBeenCalledTimes(1);
  });

  test('a refresh that brings the same root, or none, is not a move', async () => {
    expect(await associationSetMovedPast(PROOF_ROOT, watch('0xabc', '0xabc'), { wait: true })).toBe(false);
    expect(await associationSetMovedPast(PROOF_ROOT, watch(null, null), { wait: true })).toBe(false);
  });

  test('without the proof root nothing is a move', async () => {
    const w = watch('0xdef', '0xdef');
    expect(await associationSetMovedPast(null, w, { wait: true })).toBe(false);
    expect(w.next).toHaveBeenCalledTimes(0);
  });
});

describe('user-facing copy', () => {
  for (const copy of [STALE_ASP_ROOT_MESSAGE, RELAYED_REVERT_MESSAGE]) {
    test(`short, plain and without jargon: ${copy}`, () => {
      expect(copy.length).toBeLessThan(90);
      expect(copy).not.toMatch(/[—–;]/);
      expect(copy).not.toMatch(/ASP|root|revert|nullifier|relayer/i);
    });
  }

  test('both outcomes are shown as they are', () => {
    expect(isPlainRelayRevert(new StaleAspRootError())).toBe(true);
    expect(isPlainRelayRevert(new RelayedRevertError(1n))).toBe(true);
    expect(isPlainRelayRevert(new Error(STALE_ASP_ROOT_MESSAGE))).toBe(false);
  });
});
