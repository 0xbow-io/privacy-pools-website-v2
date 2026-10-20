import { describe, expect, test } from 'bun:test';

import {
  classifyTransactShape,
  feedEventType,
  feedLooksLikeTransfer,
  mayClaimWithdrawal,
  outflowIsFee,
  type TransactShapeInput,
} from '@/services/transact-shape';

const shape = (over: Partial<TransactShapeInput>) =>
  classifyTransactShape({
    outputCount: 1,
    nonOwnedOutputs: 0,
    withdrawnValue: 0n,
    distinctInputLabels: 1,
    ...over,
  });

describe('transact shape', () => {
  test('an output owned by someone else is a transfer, whatever the arity', () => {
    expect(shape({ outputCount: 2, nonOwnedOutputs: 1, withdrawnValue: 5n })).toBe('transfer');
    // The protocol permits a 1x1 transfer with a single output and no
    // withdrawal (v2-monorepo Transact.t.sol:650-689). Arity must not veto it.
    expect(shape({ outputCount: 1, nonOwnedOutputs: 1, withdrawnValue: 0n })).toBe('transfer');
  });

  test('nothing left the pool and every output is mine: internal', () => {
    expect(shape({ outputCount: 1, withdrawnValue: 0n })).toBe('internal');
    expect(shape({ outputCount: 3, withdrawnValue: 0n, distinctInputLabels: 3 })).toBe('internal');
  });

  test('one change note per input label with value out is withdrawal-shaped', () => {
    expect(shape({ outputCount: 1, withdrawnValue: 100n, distinctInputLabels: 1 })).toBe('withdrawal');
  });

  test('a MIXED-LABEL withdrawal is still a withdrawal, though it has 2-5 outputs', () => {
    // The regression that a bare `M >= 2 => transfer` rule would cause. The SDK
    // emits one change note per distinct input label, and
    // services/withdraw-note-selection.ts permits mixed-label withdrawals on
    // purpose; there are pinned two-label and five-label fixtures for them.
    expect(shape({ outputCount: 2, withdrawnValue: 100n, distinctInputLabels: 2 })).toBe('withdrawal');
    expect(shape({ outputCount: 5, withdrawnValue: 100n, distinctInputLabels: 5 })).toBe('withdrawal');
  });

  test('a full-balance withdrawal still emits a zero-value change note per label', () => {
    // "No change" does not mean "no output": the SDK emits the change note
    // anyway, so arity is unchanged and this stays a withdrawal.
    expect(shape({ outputCount: 1, withdrawnValue: 1000n, distinctInputLabels: 1 })).toBe('withdrawal');
  });

  test('the anchor: one input label, two owned outputs, value out is a FEE not a payout', () => {
    // Pat's transaction, 2026-09-01: 1 nullifier, 2 owned output commitments,
    // withdrawnValue 539379930021000 wei, all of it the relayer's fee.
    const s = shape({ outputCount: 2, withdrawnValue: 539379930021000n, distinctInputLabels: 1 });
    expect(s).toBe('anchor-shaped');
    expect(outflowIsFee(s)).toBe(true);
    expect(mayClaimWithdrawal(s)).toBe(false);
  });

  test('a multi-label self-transfer is anchor-shaped too: N labels, N+1 outputs', () => {
    expect(shape({ outputCount: 4, withdrawnValue: 7n, distinctInputLabels: 3 })).toBe('anchor-shaped');
  });

  test('dust consolidation is a self-transfer and must not read as a withdrawal', () => {
    // services/consolidate-notes.ts is a relayed self-transfer with several
    // owned inputs and all-owned outputs; it hit the identical bad branch.
    expect(shape({ outputCount: 2, withdrawnValue: 42n, distinctInputLabels: 1 })).toBe('anchor-shaped');
  });

  test('a one-note-per-deposit consolidation on the transfer route is a fee, though its arity matches a withdrawal', () => {
    // services/consolidate-notes.ts keeps one owned note per deposit and has no
    // recipient output, so M === labels. Only the caller (the relayer's
    // transfer-route signer) separates it from a payout.
    expect(shape({ outputCount: 1, withdrawnValue: 42n, distinctInputLabels: 1, transferRoute: true })).toBe('anchor-shaped');
    expect(shape({ outputCount: 2, withdrawnValue: 42n, distinctInputLabels: 2, transferRoute: true })).toBe('anchor-shaped');
    expect(shape({ outputCount: 2, withdrawnValue: 42n, distinctInputLabels: null, transferRoute: true })).toBe('anchor-shaped');
  });

  test('the transfer route changes nothing when value reached someone else or nothing left', () => {
    expect(shape({ outputCount: 2, nonOwnedOutputs: 1, withdrawnValue: 42n, transferRoute: true })).toBe('transfer');
    expect(shape({ outputCount: 1, withdrawnValue: 0n, transferRoute: true })).toBe('internal');
  });

  test('unknown input labels yield ambiguity, never a guessed withdrawal', () => {
    const s = shape({ outputCount: 2, withdrawnValue: 100n, distinctInputLabels: null });
    expect(s).toBe('ambiguous-outflow');
    expect(mayClaimWithdrawal(s)).toBe(false);
    // Zero is the same as unknown: no labels matched, so nothing is proven.
    expect(shape({ outputCount: 1, withdrawnValue: 100n, distinctInputLabels: 0 })).toBe('ambiguous-outflow');
  });

  test('only a real withdrawal may be stated as one', () => {
    const shapes = ['transfer', 'withdrawal', 'anchor-shaped', 'ambiguous-outflow', 'internal'] as const;
    expect(shapes.filter(mayClaimWithdrawal)).toEqual(['withdrawal']);
  });

  test('fee-bearing shapes are exactly transfer and anchor-shaped', () => {
    const shapes = ['transfer', 'withdrawal', 'anchor-shaped', 'ambiguous-outflow', 'internal'] as const;
    expect(shapes.filter(outflowIsFee)).toEqual(['transfer', 'anchor-shaped']);
  });
});

describe('feedLooksLikeTransfer', () => {
  test('the caller names the route before arity guesses', () => {
    // Relay, yield router or swap route: value paid out, a withdrawal even
    // with one change note per label.
    expect(feedLooksLikeTransfer(3, { transfer: false, withdrawal: true })).toBe(false);
    // The relayer's transfer route: a transfer even at arity 1.
    expect(feedLooksLikeTransfer(1, { transfer: true, withdrawal: false })).toBe(true);
    // No route named: arity, as before.
    expect(feedLooksLikeTransfer(2, { transfer: false, withdrawal: false })).toBe(true);
    expect(feedLooksLikeTransfer(1, { transfer: false, withdrawal: false })).toBe(false);
  });
});

describe('feedEventType', () => {
  const transfers = new Set(['0xt']);
  const withdrawalRoutes = new Set(['0xw']);
  test("the snapshot's verdict corrects the ASP's word both ways", () => {
    // The ASP typed a relayed ppETH withdrawal through the yield router
    // 'transfer' (prod event 153, 0xffb2fbe0...): it left three change notes.
    expect(feedEventType('transfer', '0xw', transfers, withdrawalRoutes)).toBe('withdrawal');
    expect(feedEventType('withdrawal', '0xt', transfers, withdrawalRoutes)).toBe('transfer');
    expect(feedEventType('transfer', '0xother', transfers, withdrawalRoutes)).toBe('transfer');
    expect(feedEventType('withdrawal', '0xother', transfers, withdrawalRoutes)).toBe('withdrawal');
    expect(feedEventType('deposit', '0xw', transfers, withdrawalRoutes)).toBe('deposit');
  });
});
