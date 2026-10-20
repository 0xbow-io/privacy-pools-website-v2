import { describe, expect, test } from 'bun:test';
import {
  bestConsolidation,
  assertConsolidationWorthIt,
  consolidationFeeError,
  consolidationCandidates,
  consolidationGroups,
  consolidationNet,
  planConsolidation,
  selectConsolidationGroup,
  consolidationWorthIt,
  MAX_CONSOLIDATION_INPUTS,
  resolveForcedInputs,
  unavailableConsolidationCommitments,
  type ConsolidatableNote,
} from '../consolidate-notes';

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

test('Back removes proven unavailable notes without hiding notes after a transient verification failure', () => {
  const rejected = [
    { commitment: '0xAA', rejectReasons: [{ code: 'nullifier-already-spent' }] },
    { commitment: '0xBB', rejectReasons: [{ code: 'commitment-not-on-chain' }] },
    { commitment: '0xCC', rejectReasons: [{ code: 'note-not-active' }] },
    { commitment: '0xDD', rejectReasons: [{ code: 'nullifier-fetch-failed' }] },
    { commitment: '0xEE', rejectReasons: [{ code: 'asp-membership-missing' }] },
    { commitment: '0xFF', rejectReasons: [{ code: 'timestamp-unverified' }] },
  ];
  expect(unavailableConsolidationCommitments(rejected)).toEqual(['0xaa', '0xbb', '0xcc']);
});

test('a positive remainder survives at base-unit precision, without the old reserve or 50% floor', () => {
  expect(consolidationNet(101n, 100n)).toBe(1n);
  expect(consolidationNet(100n, 100n)).toBeNull();
  expect(consolidationNet(99n, 100n)).toBeNull();
  expect(consolidationNet(101n, null)).toBeNull();
  expect(consolidationFeeError(101n, 100n)).toBeNull();
});

let seq = 0;
const note = (value: bigint, label: string, over: Partial<ConsolidatableNote> = {}): ConsolidatableNote => ({
  commitment: `0x${(++seq).toString(16).padStart(64, '0')}`,
  label,
  tokenId: ETH,
  value: `0x${value.toString(16)}`,
  status: 'ACTIVE',
  ...over,
});

describe('consolidationCandidates', () => {
  test('groups by (token, label); needs at least two spendable positive notes', () => {
    const notes = [
      note(3n, 'A'), note(1n, 'A'), note(2n, 'A'),
      note(5n, 'B'),
      note(4n, 'C', { tokenId: USDC }), note(6n, 'C', { tokenId: USDC }),
      note(9n, 'A', { status: 'SPENT' }),
      note(0n, 'A'),
    ];
    const cands = consolidationCandidates(notes);
    expect(cands.map((c) => `${c.label}:${c.notes.length}`)).toEqual(['a:3', 'c:2']);
    expect(cands[0].total).toBe(6n);
    expect(cands[0].lineageNoteCount).toBe(3);
  });

  test('picks the smallest notes first and caps at the input limit', () => {
    const notes = [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((v) => note(v, 'A'));
    const [c] = consolidationCandidates(notes);
    expect(c.notes).toHaveLength(MAX_CONSOLIDATION_INPUTS);
    expect(c.notes.map((n) => BigInt(n.value))).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(c.lineageNoteCount).toBe(7);
  });

  test('honours the association-set spendable filter and a token filter', () => {
    const a = note(1n, 'A'); const b = note(2n, 'A'); const c = note(3n, 'A');
    const spendable = new Set([a.commitment.toLowerCase(), b.commitment.toLowerCase()]);
    const cands = consolidationCandidates([a, b, c], spendable);
    expect(cands[0].notes.map((n) => n.commitment)).toEqual([a.commitment, b.commitment]);
    expect(consolidationCandidates([a, b, c], undefined, USDC)).toEqual([]);
    expect(bestConsolidation([a, b, c], ETH, 0n)?.notes).toHaveLength(3);
    expect(bestConsolidation([a, b, c], USDC, 0n)).toBeNull();
  });

  test('ranks lineages with more notes first, then larger totals', () => {
    const notes = [note(50n, 'big'), note(50n, 'big'), note(1n, 'many'), note(1n, 'many'), note(1n, 'many')];
    expect(consolidationCandidates(notes).map((c) => c.label)).toEqual(['many', 'big']);
  });
});

describe('fee-relative consolidation prompts', () => {
  const fee = 42_500_000_000_000n;
  const pick = (notes: ConsolidatableNote[]) => bestConsolidation(notes, ETH, fee);

  test('hides the reported dust pair and preserves meaningful consolidations', () => {
    expect(pick([note(578_025_000_000n, 'dust'), note(400_000_000_000n, 'dust')])).toBeNull();
    expect(pick([note(4_000_000_000_000_000n, 'real'), note(4_000_000_000_000_000n, 'real')])?.notes).toHaveLength(2);
    expect(pick(Array.from({ length: 3 }, () => note(5_000_000_000_000_000n, 'real')))?.notes).toHaveLength(3);
  });

  test('requires value strictly above the fee for every token scale', () => {
    for (const scale of [1n, 10n ** 6n, 10n ** 18n]) {
      for (const tokenId of [ETH, USDC, 'another-asset']) {
        const fee = 40n * scale;
        const pair = (total: bigint) => [note(total / 2n, 'A', { tokenId }), note(total - total / 2n, 'A', { tokenId })];
        expect(bestConsolidation(pair(40n * scale), tokenId, fee)).toBeNull();
        expect(bestConsolidation(pair(40n * scale - 1n), tokenId, fee)).toBeNull();
        expect(bestConsolidation(pair(40n * scale + 1n), tokenId, fee)?.total).toBe(40n * scale + 1n);
        expect(bestConsolidation(pair(100n * scale), tokenId, null)).toBeNull();
        expect(bestConsolidation(pair(40n * scale + 1n), tokenId, fee * 2n)).toBeNull();
      }
    }
  });

  test('skips a higher-ranked dust lineage to offer an eligible lineage', () => {
    const notes = [
      ...Array.from({ length: 3 }, () => note(400_000_000_000n, 'dust')),
      note(fee * 2n, 'real'), note(fee * 2n, 'real'),
    ];
    expect(pick(notes)?.label).toBe('real');
  });

  test('offers an economical subset when the smallest five cannot cover the fee', () => {
    const notes = [...Array.from({ length: 5 }, () => note(400_000_000_000n, 'A')), note(fee * 10n, 'A')];
    const selected = pick(notes)!;
    expect(selected.notes).toHaveLength(5);
    expect(selected.notes).toContain(notes[5]);
    expect(selected.total).toBe(fee * 10n + 4n * 400_000_000_000n);
    expect(bestConsolidation(notes, ETH, selected.total)).toBeNull();
  });

  test('execution refuses missing or increased fees even after an eligible prompt', () => {
    expect(() => assertConsolidationWorthIt(100n, 40n)).not.toThrow();
    expect(() => assertConsolidationWorthIt(100n, 100n)).toThrow('worth more');
    expect(() => assertConsolidationWorthIt(100n, null)).toThrow('unavailable');
  });
});

describe('consolidationWorthIt', () => {
  test('a known fee must leave a strictly positive value', () => {
    expect(consolidationWorthIt(100n, null)).toBe(false);
    expect(consolidationWorthIt(100n, -1n)).toBe(false);
    expect(consolidationWorthIt(100n, 0n)).toBe(true);
    expect(consolidationWorthIt(100n, 10n)).toBe(true);      // keeps 90
    expect(consolidationWorthIt(100n, 40n)).toBe(true);      // keeps 60
    expect(consolidationWorthIt(100n, 99n)).toBe(true);
    expect(consolidationWorthIt(10n, 10n)).toBe(false);
  });
});

describe('resolveForcedInputs', () => {
  test('returns the live notes in forced order when all match one lineage/token', () => {
    const a = note(1n, 'A'); const b = note(2n, 'A');
    expect(resolveForcedInputs([b.commitment.toUpperCase(), a.commitment], [a, b])?.map((n) => n.commitment)).toEqual([b.commitment, a.commitment]);
  });

  test('rejects single, duplicate, missing, spent, singleton-label, cross-token and oversized sets', () => {
    const a = note(1n, 'A'); const b = note(2n, 'B'); const s = note(2n, 'A', { status: 'SPENT' }); const u = note(2n, 'A', { tokenId: USDC });
    expect(resolveForcedInputs([a.commitment], [a])).toBeNull();
    expect(resolveForcedInputs([a.commitment, a.commitment.toUpperCase()], [a])).toBeNull();
    expect(resolveForcedInputs(['0xdead', a.commitment], [a])).toBeNull();
    expect(resolveForcedInputs([a.commitment, s.commitment], [a, s])).toBeNull();
    expect(resolveForcedInputs([a.commitment, b.commitment], [a, b])).toBeNull();
    expect(resolveForcedInputs([a.commitment, u.commitment], [a, u])).toBeNull();
    const many = Array.from({ length: 6 }, () => note(1n, 'A'));
    expect(resolveForcedInputs(many.map((n) => n.commitment), many)).toBeNull();
    expect(resolveForcedInputs([], [a])).toBeNull();
  });
});

describe('the prompt does not come back right after a consolidation (Mike, 2026-09-24)', () => {
  const note = (commitment: string, value: bigint, label = 'L1'): ConsolidatableNote => ({
    commitment, label, tokenId: USDC, value: value.toString(), status: 'ACTIVE',
  });

  test('the folded note plus its leftover change is not offered again', () => {
    // 5.33 USDC in two notes, consolidated: one ~5.29 note and ~0.01 of change.
    const after = [note('0xfolded', 5_290_000n), note('0xchange', 10_000n)];
    expect(bestConsolidation(after, USDC, 0n)).toBeNull();
  });

  test('two real small notes are still offered, and dust is swept into the pick', () => {
    const before = [note('0xa', 2_600_000n), note('0xb', 2_730_000n), note('0xdust', 10_000n)];
    const pick = bestConsolidation(before, USDC, 0n);
    expect(pick).not.toBeNull();
    expect(pick!.notes.map((n) => n.commitment)).toContain('0xdust');
  });

  test('one large note beside several dust notes is still offered', () => {
    // Only one leftover is ignored: four dust notes are what consolidating is for.
    const lineage = [note('0xbig', 1_000_000n), note('0xd1', 1_000n), note('0xd2', 1_000n), note('0xd3', 1_000n), note('0xd4', 1_000n)];
    const pick = bestConsolidation(lineage, USDC, 0n);
    expect(pick).not.toBeNull();
    expect(pick!.notes.map((n) => n.commitment)).toContain('0xd1');
  });

  test('the dust line is 2% of the largest note in the lineage', () => {
    expect(bestConsolidation([note('0xbig', 10_000n), note('0xat', 200n)], USDC, 0n)).not.toBeNull();
    expect(bestConsolidation([note('0xbig', 10_000n), note('0xunder', 199n)], USDC, 0n)).toBeNull();
  });
});

test('the modal exposes every note in a group while the suggested selection respects the proof cap', () => {
  const notes = Array.from({ length: 8 }, (_, i) => note(BigInt(i + 1), 'A'));
  expect(consolidationGroups(notes)[0].notes).toHaveLength(8);
  expect(consolidationCandidates(notes)[0].notes).toHaveLength(5);
  const custom = notes.slice(3, 8).map((n) => n.commitment);
  expect(resolveForcedInputs(custom, notes)?.map((n) => n.commitment)).toEqual(custom);
  expect(resolveForcedInputs(custom, notes.filter((n) => n.commitment !== custom[0]))).toBeNull();
});

describe('multi-group fee-only consolidation', () => {
  test('accepts 3+2 and 2+2, rejects singleton groups and a sixth input', () => {
    const a = [note(10n, 'A'), note(20n, 'A'), note(30n, 'A')];
    const b = [note(4n, 'B'), note(6n, 'B')];
    expect(resolveForcedInputs([...a, ...b].map(n => n.commitment), [...a, ...b])).toHaveLength(5);
    expect(resolveForcedInputs([...a.slice(0, 2), ...b].map(n => n.commitment), [...a, ...b])).toHaveLength(4);
    expect(resolveForcedInputs([...a, b[0]].map(n => n.commitment), [...a, ...b])).toBeNull();
    const six = [...a, ...b, note(10n, 'B')];
    expect(resolveForcedInputs(six.map(n => n.commitment), six)).toBeNull();
  });

  test('puts the fee-bearing group first without moving value between lineages', () => {
    const inputs = [note(4n, 'B'), note(10n, 'A'), note(6n, 'B'), note(20n, 'A'), note(30n, 'A')];
    const plan = planConsolidation(inputs, 7n);
    expect(plan.notes.map(n => n.label)).toEqual(['A', 'A', 'A', 'B', 'B']);
    expect(plan.outputs).toEqual([
      { label: 'a', inputCount: 3, value: 53n, fee: 7n },
      { label: 'b', inputCount: 2, value: 10n, fee: 0n },
    ]);
    expect(plan.net).toBe(63n);
    expect(plan.outputs.reduce((s, n) => s + n.value, 0n) + plan.fee).toBe(plan.total);
  });

  test('binding fee changes leave exactly one positive note per group or stop before submission', () => {
    const inputs = [note(30n, 'A'), note(30n, 'A'), note(5n, 'B'), note(5n, 'B')];
    expect(planConsolidation(inputs, 59n).outputs.map(n => n.value)).toEqual([1n, 10n]);
    expect(planConsolidation(inputs, 0n).outputs.map(n => n.value)).toEqual([60n, 10n]);
    expect(() => planConsolidation(inputs, 60n)).toThrow('One selected group');
    expect(() => planConsolidation(inputs, null)).toThrow('unavailable');
    expect(() => planConsolidation(inputs, -1n)).toThrow();
    expect(() => planConsolidation(inputs.slice(1), 1n)).toThrow('at least two');
  });

  test('pinned SDK creates only owned change outputs for a zero-amount transfer', async () => {
    const { TransactOrchestrator } = await import('@privacy-pools-v2/sdk');
    // Exercise the actual vendored output builder, stubbing note cryptography only.
    // TS-private is intentionally reached here to catch a changed SDK output policy.
    const core = Object.create(TransactOrchestrator.prototype);
    const owner = '0x1234';
    core.generatePendingNote = (tokenId: string, label: string, value: string) => ({ tokenId, label, value, ownerAddress: owner });
    const inputs = [note(4n, 'B'), note(10n, 'A'), note(6n, 'B'), note(20n, 'A'), note(30n, 'A')];
    const plan = planConsolidation(inputs, 7n);
    for (const fee of [0n, 7n, 59n]) {
      const outputs = core.getTransactOutputNotes(plan.notes, '0x0', `0x${fee.toString(16)}`, ETH, undefined);
      expect(outputs.recipientNotes).toEqual([]);
      expect(outputs.changeNotes).toHaveLength(2);
      expect(outputs.changeNotes.map((n: { value: string }) => BigInt(n.value))).toEqual([60n - fee, 10n]);
      expect(outputs.changeNotes.map((n: { ownerAddress: string }) => n.ownerAddress)).toEqual([owner, owner]);
    }
    const single = planConsolidation(inputs.filter(n => n.label === 'A'), 7n);
    expect(core.getTransactOutputNotes(single.notes, '0x0', '0x7', ETH, undefined).changeNotes).toHaveLength(1);
  });
});

test('pinned relay path keeps zero recipient amount and uses the signed fee for both group outputs', async () => {
  const { PoolSessionTransfer, TransactOrchestrator } = await import('@privacy-pools-v2/sdk');
  const inputs = [note(30n, 'A'), note(30n, 'A'), note(5n, 'B'), note(5n, 'B')];
  const core = Object.create(TransactOrchestrator.prototype);
  core.generatePendingNote = (tokenId: string, label: string, value: string) => ({ tokenId, label, value });
  const session = Object.create(PoolSessionTransfer.prototype);
  let submissions = 0;
  session.runPrepareTransact = async (params: { amount: string; feeAmount: string; tokenId: string }) => {
    expect(params.amount).toBe('0x0');
    expect(BigInt(params.feeAmount)).toBe(9n);
    const outputs = core.getTransactOutputNotes(inputs, params.amount, params.feeAmount, params.tokenId, undefined);
    expect(outputs.recipientNotes).toEqual([]);
    expect(outputs.changeNotes.map((n: { value: string }) => BigInt(n.value))).toEqual([51n, 10n]);
    return { spentNotes: inputs, spentNullifiers: [], changePendingNotes: outputs.changeNotes,
      recipientPendingNotes: outputs.recipientNotes, notesData: [], proof: {} };
  };
  session.relayerInteractor = { relayTransfer: async (_relayer: unknown, payload: { outputCommitmentNumber: number; inputNullifierNumber: number }) => {
    submissions++;
    expect(payload.outputCommitmentNumber).toBe(2);
    expect(payload.inputNullifierNumber).toBe(4);
    return '0xtest';
  } };
  session.rpcInteractor = { waitForTransactionReceipt: async () => ({ status: true }) };
  session.finalizeTransfer = async () => ({ complete: true });
  const params = { amount: '0x0', feeAmount: '0x0', tokenId: ETH, selectedQuote: {
    relayerInfo: { address: '0xrelayer' }, quote: { feeCommitment: { asset: ETH, feeAmount: '9', data: '0x', expiration: Date.now() + 60_000 } },
  } };
  expect(await session.relayTransfer(params)).toEqual({ complete: true });
  expect(submissions).toBe(1);
  params.selectedQuote.quote.feeCommitment.expiration = Date.now() - 60_000;
  await expect(session.relayTransfer(params)).rejects.toThrow();
  expect(submissions).toBe(1);
});

test('group inclusion and bulk selection preserve other groups and the five-note cap', () => {
  const notes = [1n, 2n, 3n, 4n, 5n, 6n].map(v => note(v, 'A'));
  const group = consolidationGroups(notes)[0];
  const other = ['other-1', 'other-2'];
  const included = selectConsolidationGroup(group, other, 'include');
  expect(included.selected).toEqual([...other, notes[0].commitment, notes[1].commitment]);
  const filled = selectConsolidationGroup(group, included.selected, 'fill');
  expect(filled.selected).toEqual([...other, ...notes.slice(0, 3).map(n => n.commitment)]);
  expect(selectConsolidationGroup(group, filled.selected, 'clear').selected).toEqual(other);
  expect(selectConsolidationGroup(group, [], 'fill').selected).toHaveLength(5);
  const blocked = selectConsolidationGroup(group, ['a','b','c','d'], 'include');
  expect(blocked.selected).toEqual(['a','b','c','d']);
  expect(blocked.error).toContain('another group');
  const partial = selectConsolidationGroup(group, [...other, notes[0].commitment], 'fill');
  expect(partial.selected).toHaveLength(5);
  expect(new Set(partial.selected).size).toBe(5);
});
