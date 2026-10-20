import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeGaslessRegistrationBlocker,
  isRawWalletError,
  isAuthPolicyAlreadySetError,
  collectErrorText,
  REGISTRATION_TX_PENDING_MESSAGE,
  WALLET_SEND_FAILED_MESSAGE,
  classifyRegistrationError,
  describeRegistrationError,
  describeQuoteFailure,
  filterFeeNotesByAssociationSet,
  narrowFeeNotes,
  selectFeeNoteCandidates,
  GASLESS_REGISTRATION_MAX_CANDIDATES,
  GASLESS_REGISTRATION_MAX_INPUTS,
  type FeeNoteCandidate,
  type GaslessRegistrationBlocker,
  type GaslessRegistrationEligibility,
  HIGH_FEE_WARNING,
  isHighFeeShare,
} from '@/services/gasless-registration';
import { NoteStatus } from '@/services/sdk-types';
import type { Address, Hash, Hex, Note } from '@/services/sdk-types';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
// Two deposit lineages. registerAndRelay may spend both in one mixed-label
// proof and the SDK emits one change output for each.
const LABEL_A = '0xaaaa' as Hash;
const LABEL_B = '0xbbbb' as Hash;
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

let nextCommitment = 1;

// `value` is taken as a bigint (or a deliberately malformed string) and
// hex-encoded here, so the cases below read as amounts rather than as hex.
function note(overrides: Omit<Partial<Note>, 'value'> & { value: bigint | Hex }): Note {
  const value = typeof overrides.value === 'bigint'
    ? (`0x${overrides.value.toString(16)}` as Hex)
    : overrides.value;
  return {
    commitment: `0x${(nextCommitment++).toString(16).padStart(64, '0')}` as Hash,
    label: LABEL_A,
    tokenId: NATIVE,
    status: NoteStatus.ACTIVE,
    ownerAddress: '0x1111111111111111111111111111111111111111' as Address,
    noteSecret: '0x2' as Hex,
    isOwned: true,
    createdAtBlock: '0x1' as Hex,
    spentAtBlock: null,
    txHash: '0x3' as Hash,
    parentCommitmentHash: null,
    ...overrides,
    value,
  };
}

describe('selectFeeNoteCandidates', () => {
  test('groups by asset and orders each group largest-first', () => {
    const candidates = selectFeeNoteCandidates([
      note({ value: 10n, tokenId: NATIVE }),
      note({ value: 300n, tokenId: USDC }),
      note({ value: 50n, tokenId: NATIVE }),
      note({ value: 100n, tokenId: USDC }),
    ]);
    expect(candidates).toHaveLength(2);
    // Ordered by raw total: USDC 400 > native 60.
    expect(candidates[0].tokenId).toBe(USDC);
    expect(candidates[0].totalWei).toBe(400n);
    expect(candidates[0].notes.map((n) => BigInt(n.value))).toEqual([300n, 100n]);
    expect(candidates[1].tokenId).toBe(NATIVE);
    expect(candidates[1].notes.map((n) => BigInt(n.value))).toEqual([50n, 10n]);
  });

  // The SDK's getNotesTokenId compares input tokenIds with a raw `!==` and
  // throws 'All input notes must have the same tokenId'. Merging a checksummed
  // and a lowercase note of the same ERC-20 would build a candidate that dies
  // AFTER the user signed, so they stay apart and are each tried in turn.
  test('a token id differing only in case is NOT merged', () => {
    const candidates = selectFeeNoteCandidates([
      note({ value: 10n, tokenId: USDC }),
      note({ value: 20n, tokenId: USDC.toLowerCase() as Address }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.totalWei)).toEqual([20n, 10n]);
    expect(candidates.map((c) => c.tokenId)).toEqual([USDC.toLowerCase(), USDC]);
  });

  test('notes of the same asset from different labels form one mixed candidate', () => {
    const candidates = selectFeeNoteCandidates([
      note({ value: 10n, label: LABEL_A }),
      note({ value: 40n, label: LABEL_B }),
      note({ value: 5n, label: LABEL_A }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].totalWei).toBe(55n);
    expect(candidates[0].notes.map((n) => BigInt(n.value))).toEqual([40n, 10n, 5n]);
    expect(new Set(candidates[0].notes.map((n) => n.label)).size).toBe(2);
  });

  test('mixed labels can jointly fund a fee neither lineage covers alone', () => {
    const [candidate] = selectFeeNoteCandidates([
      note({ value: 60n, label: LABEL_A }),
      note({ value: 50n, label: LABEL_B }),
    ]);
    const narrowed = narrowFeeNotes(candidate, 100n);
    expect(narrowed).not.toBeNull();
    expect(narrowed!.notes).toHaveLength(2);
    expect(narrowed!.totalWei).toBe(110n);
    expect(new Set(narrowed!.notes.map((n) => n.label)).size).toBe(2);
  });

  test('only ACTIVE, owned, positively-valued notes can fund the fee', () => {
    expect(selectFeeNoteCandidates([
      note({ value: 100n, status: NoteStatus.PENDING }),
      note({ value: 100n, status: NoteStatus.SPENT }),
      note({ value: 100n, status: NoteStatus.EXITED }),
      note({ value: 100n, isOwned: false }),
      note({ value: 0n }),
      note({ value: 'not-hex' as Hex }),
    ])).toEqual([]);
  });

  test('a group is capped at the transact circuit input ceiling, keeping the biggest notes', () => {
    const values = [1n, 2n, 3n, 4n, 5n, 6n, 7n];
    const [candidate] = selectFeeNoteCandidates(values.map((value, i) => note({
      value,
      label: `0x${i + 1}` as Hash,
    })));
    expect(candidate.notes).toHaveLength(GASLESS_REGISTRATION_MAX_INPUTS);
    expect(candidate.notes.map((n) => BigInt(n.value))).toEqual([7n, 6n, 5n, 4n, 3n]);
    expect(new Set(candidate.notes.map((n) => n.label)).size).toBe(GASLESS_REGISTRATION_MAX_INPUTS);
    // The two smallest are left out, so the total is NOT the wallet's balance.
    expect(candidate.totalWei).toBe(25n);
  });

  test('a caller cannot raise the candidate above the shipped five-input ceiling', () => {
    const [candidate] = selectFeeNoteCandidates(
      Array.from({ length: 7 }, (_, i) => note({ value: BigInt(i + 1) })),
      { maxInputs: 99 },
    );
    expect(candidate.notes).toHaveLength(GASLESS_REGISTRATION_MAX_INPUTS);
    expect(candidate.totalWei).toBe(25n);
  });

  test('the number of assets priced is bounded', () => {
    const tokens = ['0xa1', '0xa2', '0xa3', '0xa4', '0xa5'] as Address[];
    const candidates = selectFeeNoteCandidates(
      tokens.map((tokenId, i) => note({ value: BigInt(i + 1), tokenId })),
    );
    expect(candidates).toHaveLength(GASLESS_REGISTRATION_MAX_CANDIDATES);
    // The bound keeps the biggest groups, not an arbitrary slice.
    expect(candidates.map((c) => c.totalWei)).toEqual([5n, 4n, 3n]);
  });

  test('an empty wallet yields no candidates', () => {
    expect(selectFeeNoteCandidates([])).toEqual([]);
  });
});

describe('filterFeeNotesByAssociationSet', () => {
  test('keeps approved mixed labels and drops a rejected label before selection', () => {
    const approvedA = note({ value: 60n, label: LABEL_A });
    const approvedB = note({ value: 50n, label: LABEL_B });
    const rejected = note({ value: 1_000n, label: '0xcccc' as Hash });
    const hashes = new Map<unknown, string>([
      [LABEL_A, '0xhash-a'],
      [LABEL_B, '0xhash-b'],
      [rejected.label, '0xhash-c'],
    ]);
    const kept = filterFeeNotesByAssociationSet(
      [rejected, approvedA, approvedB],
      ['0xHASH-A', '0xhash-b'],
      [],
      (label) => hashes.get(label),
    );
    expect(kept.map((n) => n.commitment)).toEqual([approvedA.commitment, approvedB.commitment]);
    const [candidate] = selectFeeNoteCandidates(kept);
    expect(candidate.totalWei).toBe(110n);
    expect(new Set(candidate.notes.map((n) => n.label)).size).toBe(2);
  });

  test('fails closed for an empty set or an unhashable label', () => {
    const candidate = note({ value: 10n });
    expect(filterFeeNotesByAssociationSet([candidate], [], [], () => '0xhash')).toEqual([]);
    expect(filterFeeNotesByAssociationSet([candidate], ['0xhash'], [], () => {
      throw new Error('bad label');
    })).toEqual([]);
  });

  test('rejection wins when a revoked hash remains in the append-only leaf set', () => {
    const revoked = note({ value: 100n, label: LABEL_A });
    expect(filterFeeNotesByAssociationSet(
      [revoked],
      ['0xHASH-A'],
      ['0xhash-a'],
      () => '0xhash-a',
    )).toEqual([]);
  });

  test('fund-moving gasless boundaries bypass the rejected-label TTL', () => {
    // This is a wiring invariant, not just a cache invariant: a cached empty
    // rejection set must not be reused before disclosing the selected balance
    // to the relayer, before asking for a signature, or before proving.
    const source = readFileSync(join(ROOT, 'hooks', 'use-gasless-registration.ts'), 'utf8');
    const quoteRefresh = source.indexOf(
      'readActiveNotes().filter((note) => offeredTokenIds.has(note.tokenId)),\n        { freshDecisions: true },',
    );
    const pricing = source.indexOf('const spent = await findSpentNotes', quoteRefresh);
    const preSign = source.indexOf("await assertPlanStillApproved('sign', { freshDecisions: true });");
    // Not `const`: a top-up has no signature.
    const signature = source.indexOf('signature = await signTypedDataAsync', preSign);
    const proofRefreshes = source.match(
      /await assertPlanStillApproved\('prove', \{ freshDecisions: true \}\);/g,
    ) ?? [];

    expect(quoteRefresh).toBeGreaterThan(-1);
    expect(pricing).toBeGreaterThan(quoteRefresh);
    expect(preSign).toBeGreaterThan(-1);
    expect(signature).toBeGreaterThan(preSign);
    expect(proofRefreshes).toHaveLength(2);
  });
});

describe('narrowFeeNotes', () => {
  const candidate = (values: bigint[]): FeeNoteCandidate => ({
    tokenId: NATIVE,
    notes: values.map((value) => note({ value })),
    totalWei: values.reduce((sum, v) => sum + v, 0n),
  });

  test('spends the fewest notes that clear the fee', () => {
    const narrowed = narrowFeeNotes(candidate([100n, 50n, 25n]), 80n);
    expect(narrowed).not.toBeNull();
    expect(narrowed!.notes).toHaveLength(1);
    expect(narrowed!.totalWei).toBe(100n);
  });

  test('combines notes when the largest alone cannot cover the fee', () => {
    const narrowed = narrowFeeNotes(candidate([100n, 50n, 25n]), 120n);
    expect(narrowed!.notes.map((n) => BigInt(n.value))).toEqual([100n, 50n]);
    expect(narrowed!.totalWei).toBe(150n);
  });

  test('a fee that consumes the whole balance is refused, not spent', () => {
    expect(narrowFeeNotes(candidate([100n, 50n]), 150n)).toBeNull();
    expect(narrowFeeNotes(candidate([100n, 50n]), 999n)).toBeNull();
  });

  test('an exact match is refused — it would leave a zero change note', () => {
    expect(narrowFeeNotes(candidate([100n]), 100n)).toBeNull();
    // One wei more than the fee is enough: something is left.
    expect(narrowFeeNotes(candidate([101n]), 100n)!.totalWei).toBe(101n);
  });

  test('a non-positive fee is a bad quote, not a free registration', () => {
    expect(narrowFeeNotes(candidate([100n]), 0n)).toBeNull();
    expect(narrowFeeNotes(candidate([100n]), -1n)).toBeNull();
  });

  test('carries the asset through so the transact proves one token', () => {
    const usdc: FeeNoteCandidate = {
      tokenId: USDC, notes: [note({ value: 10n, tokenId: USDC })], totalWei: 10n,
    };
    expect(narrowFeeNotes(usdc, 5n)!.tokenId).toBe(USDC);
  });
});

describe('describeGaslessRegistrationBlocker', () => {
  const ineligible = (
    blocker: Extract<GaslessRegistrationEligibility, { kind: 'ineligible' }>['blocker'],
    walletCanPay: boolean | null,
  ): GaslessRegistrationEligibility => ({ kind: 'ineligible', blocker, walletCanPay });

  test('says nothing when the relayer will carry the wallet', () => {
    expect(describeGaslessRegistrationBlocker({ kind: 'eligible', mode: 'register', candidates: [] }, 'ETH')).toBeNull();
  });

  test('says nothing when the wallet can pay for itself', () => {
    expect(describeGaslessRegistrationBlocker(ineligible('wallet-funded', true), 'ETH')).toBeNull();
    expect(describeGaslessRegistrationBlocker(ineligible('already-registered', null), 'ETH')).toBeNull();
    expect(describeGaslessRegistrationBlocker(ineligible('session-locked', null), 'ETH')).toBeNull();
  });

  // Every reachable dead end must be describable. A blocker whose only return
  // path carries walletCanPay !== false renders nothing at all, which is how
  // the first cut left a stuck wallet with no warning and a button that failed
  // inside the wallet.
  test('every dead end the probe can report has copy naming the native currency', () => {
    const deadEnds = ['chain-unsupported', 'other-chain', 'no-notes', 'probe-failed'] as const;
    for (const blocker of deadEnds) {
      const message = describeGaslessRegistrationBlocker(ineligible(blocker, false), 'cBTC');
      expect(message).toBeTruthy();
      expect(message).toContain('cBTC');
    }
  });

  // The probe must not be able to report anything that depends on pricing:
  // pricing means telling the relayer the wallet's balance, and the probe runs
  // on modal open, before the user has asked for anything.
  test('the probe cannot report a pricing-dependent verdict', () => {
    // Exhaustive by construction: `exhaustive` only typechecks when this list
    // covers the union exactly, so adding a pricing verdict back to
    // GaslessRegistrationBlocker fails the build here rather than silently
    // re-introducing an open-time relayer call.
    const probeBlockers = [
      'session-locked', 'not-wallet-session', 'already-registered', 'wallet-funded',
      'chain-unsupported', 'other-chain', 'no-notes', 'probe-failed',
    ] as const;
    const exhaustive: Record<GaslessRegistrationBlocker, true> = Object.fromEntries(
      probeBlockers.map((b) => [b, true]),
    ) as Record<GaslessRegistrationBlocker, true>;
    expect(Object.keys(exhaustive).sort()).toEqual([...probeBlockers].sort());
  });
});

describe('describeQuoteFailure', () => {
  // These are PRESS-time outcomes, not probe blockers — answering them needs a
  // quote, and a quote discloses the balance.
  test('a relayer outage is never described as a balance problem', () => {
    const outage = describeQuoteFailure('relayer-unavailable', 'ETH');
    expect(outage).toMatch(/can't be reached|cannot be reached/i);
    expect(outage).not.toMatch(/more than the shielded balance/i);
  });

  test('a genuinely-too-small balance says so, and how to fix it', () => {
    const tooSmall = describeQuoteFailure('fee-exceeds-balance', 'cBTC');
    expect(tooSmall).toMatch(/more than the shielded balance/i);
    expect(tooSmall).toContain('cBTC');
  });

  test('both say plainly that nothing was sent', () => {
    for (const reason of ['relayer-unavailable', 'fee-exceeds-balance'] as const) {
      expect(describeQuoteFailure(reason, 'ETH')).toMatch(/[Nn]othing was sent/);
    }
  });

  // A top-up-only run is already registered; the only thing that failed to
  // price is the gas top-up for setViewingKey. It must not read as a failed
  // registration.
  test('a top-up-only outage talks about gas, not registration', () => {
    const outage = describeQuoteFailure('relayer-unavailable', 'ETH', { topUpOnly: true });
    expect(outage).toMatch(/gas/i);
    expect(outage).not.toMatch(/regist/i);
  });

  test('a top-up-only too-small balance talks about finishing setup, not registration', () => {
    const tooSmall = describeQuoteFailure('fee-exceeds-balance', 'cBTC', { topUpOnly: true, minimum: '0.001 cBTC' });
    expect(tooSmall).toMatch(/finish setup/i);
    expect(tooSmall).not.toMatch(/regist/i);
    const tooSmallNoMinimum = describeQuoteFailure('fee-exceeds-balance', 'cBTC', { topUpOnly: true });
    expect(tooSmallNoMinimum).toMatch(/finish setup/i);
    expect(tooSmallNoMinimum).not.toMatch(/regist/i);
  });
});

describe('isRawWalletError', () => {
  test('flags a viem request dump and passes our own one-liners', () => {
    expect(isRawWalletError('An internal error was received.\n\nRequest Arguments:\n  chain: Ethereum (id: 1)\n\nDetails: RPC error/unknown\nVersion: viem@2.0.0')).toBe(true);
    expect(isRawWalletError('Transaction cancelled in your wallet.')).toBe(false);
    expect(isRawWalletError('Keystore registration is unavailable for this session.')).toBe(false);
  });

  test('a sent but unconfirmed registration tx says pending and blocks a resend', () => {
    const src = readFileSync(join(__dirname, '../../components/keystore-registration-modal-provider.tsx'), 'utf8');
    // Flag set between each send and its receipt, cleared once the receipt lands.
    expect(src).toMatch(/if \(keystoreHash\) \{\n\s+sentUnconfirmed = true;\n\s+sentHash = keystoreHash;\n\s+const keystoreReceipt = await publicClient\.waitForTransactionReceipt[^\n]*\n\s+sentUnconfirmed = false;/);
    expect(src).toMatch(/sendRegistrationLeg\(viewingKeyCalldata\);\n\s+sentUnconfirmed = true;\n\s+sentHash = viewingKeyHash;\n\s+const vkReceipt = await publicClient\.waitForTransactionReceipt[^\n]*\n\s+sentUnconfirmed = false;/);
    // The modal routes every failure through the classifier and locks the
    // button on a pending one.
    expect(src).toContain('classifyRegistrationError(message, sentUnconfirmed)');
    expect(src).toContain('if (sentUnconfirmed && sentHash) watchSentRegistration(sentHash);');
    expect(src).toContain('const txUnconfirmed = !!getPendingRegistration(');
    expect(src).toContain('disabled={pending || txUnconfirmed}');
    expect(REGISTRATION_TX_PENDING_MESSAGE).not.toMatch(/—/);
  });
});

describe('Keystore_AuthPolicyAlreadySet (DEV-566)', () => {
  test('found by name or by selector anywhere in the error chain', () => {
    expect(isAuthPolicyAlreadySetError('Keystore_AuthPolicyAlreadySet()')).toBe(true);
    const wallet = Object.assign(new Error('An internal error was received.'), {
      cause: { message: 'execution reverted', data: { data: '0x70d48a55' } },
    });
    expect(isAuthPolicyAlreadySetError(wallet.message)).toBe(false);
    expect(isAuthPolicyAlreadySetError(collectErrorText(wallet))).toBe(true);
    // The setAuthPolicy CALLDATA selector is not the revert.
    expect(isAuthPolicyAlreadySetError('data: 0x735aeddc0000')).toBe(false);
  });
});

describe('describeRegistrationError', () => {
  const dump = (head: string) => `${head}\n\nRequest Arguments:\n  chain: Ethereum (id: 1)\n\nDetails: RPC error/unknown\nVersion: viem@2.45.3`;
  const say = (m: string, sent = false) => describeRegistrationError(m, sent, 'Ethereum');

  test('a sent, unconfirmed tx is pending whatever the error says', () => {
    expect(say(dump('An internal error was received.'), true)).toBe(REGISTRATION_TX_PENDING_MESSAGE);
    expect(classifyRegistrationError('boom', true)).toBe('pending');
  });
  test('a viem receipt timeout is pending, never try again', () => {
    expect(say(dump('Timed out while waiting for transaction with hash "0xabc" to be confirmed.'))).toBe(REGISTRATION_TX_PENDING_MESSAGE);
    expect(classifyRegistrationError('WaitForTransactionReceiptTimeoutError: x', false)).toBe('pending');
  });
  test('a chain mismatch names the chain to switch to', () => {
    expect(say(dump('The current chain of the wallet (id: 10) does not match the target chain for the transaction (id: 1 – Ethereum).'))).toBe('Switch your wallet to Ethereum and try again.');
    expect(classifyRegistrationError('ChainMismatchError: x', false)).toBe('chain-mismatch');
  });
  test('a rejection says cancelled', () => {
    expect(say(dump('User rejected the request.'))).toBe('Transaction cancelled in your wallet.');
  });
  test('a revert says it failed onchain, not the generic line', () => {
    expect(classifyRegistrationError('Keystore registration reverted on-chain (tx 0xabc).', false)).toBe('reverted');
    expect(say('Viewing-key registration reverted on-chain (tx 0xabc).')).toBe('The registration transaction failed onchain. Try again to finish.');
    // A wallet preflight revert is pre-send: generic line, never "failed onchain".
    expect(say(dump('Execution reverted for an unknown reason.'))).toBe(WALLET_SEND_FAILED_MESSAGE);
  });
  test('only an unknown pre-send dump gets the generic line', () => {
    expect(say(dump('An internal error was received.'))).toBe(WALLET_SEND_FAILED_MESSAGE);
    expect(say('Keystore registration is unavailable for this session.')).toBe('Keystore registration is unavailable for this session.');
  });
});

describe('claim page shows the top-up payout (DEV-482)', () => {
  test('the hook records the split from the converged plan and the page renders it', () => {
    const hook = readFileSync(join(ROOT, 'hooks/use-note-import.ts'), 'utf8');
    expect(hook).toContain('setClaimSplit({ feeWei: BigInt(quote.feeAmount), payoutWei: plan.payoutWei, changeWei: plan.changeWei })');
    const page = readFileSync(join(ROOT, 'app/import-note/[encoded].tsx'), 'utf8');
    expect(page).toContain('{PUBLIC_PAYOUT_LABEL}: {linkAmountText(claimSplit.payoutWei, token)}');
    expect(page).toContain('Stays shielded: {linkAmountText(claimSplit.changeWei, token)}');
  });
});

describe('isHighFeeShare (DEV-482)', () => {
  test('warns only above 25% of the claim', () => {
    expect(isHighFeeShare(25n, 100n)).toBe(false);
    expect(isHighFeeShare(26n, 100n)).toBe(true);
    // The reported claim: a ~3.16 fee on ~12.
    expect(isHighFeeShare(3_163n, 12_000n)).toBe(true);
    expect(isHighFeeShare(1n, 0n)).toBe(true);
  });

  test('the copy is short and has no em dash', () => {
    expect(HIGH_FEE_WARNING).not.toContain('—');
    expect(HIGH_FEE_WARNING.length).toBeLessThan(60);
  });
});
