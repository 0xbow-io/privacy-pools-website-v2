import { describe, expect, test } from 'bun:test';

import {
  describePaymentTxOutcome,
  interpretPaymentReceipt,
  waitForPaymentTx,
  type PaymentTxOutcome,
  type ReceiptWaiterClient,
  type ReplacementReason,
} from '@/services/tx-finality';
import type { Hex } from '@/services/sdk-types';

const SUBMITTED = '0xaaaa' as Hex;
const REPLACEMENT = '0xbbbb' as Hex;

describe('interpretPaymentReceipt. The plain cases', () => {
  test('original hash + success => success under the original hash', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: SUBMITTED,
      receiptSucceeded: true,
      replacement: null,
    })).toEqual({ kind: 'success', finalHash: SUBMITTED, replacedFrom: null });
  });

  test('original hash + revert => reverted', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: SUBMITTED,
      receiptSucceeded: false,
      replacement: null,
    })).toEqual({ kind: 'reverted', finalHash: SUBMITTED });
  });

  test('hash comparison is case-insensitive', () => {
    const outcome = interpretPaymentReceipt({
      submittedHash: '0xAAAA' as Hex,
      receiptHash: '0xaaaa' as Hex,
      receiptSucceeded: true,
      replacement: null,
    });
    expect(outcome.kind).toBe('success');
  });
});

describe('interpretPaymentReceipt. Replacements', () => {
  // Speed-up: viem proved the payload is identical, so this IS the payment.
  // The final hash must be the replacement's — stamping/displaying the old one
  // is exactly the bug this module exists to close.
  test('repriced + success => success under the REPLACEMENT hash', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: REPLACEMENT,
      receiptSucceeded: true,
      replacement: { reason: 'repriced', hash: REPLACEMENT },
    })).toEqual({ kind: 'success', finalHash: REPLACEMENT, replacedFrom: SUBMITTED });
  });

  test('repriced + revert => reverted under the replacement hash', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: REPLACEMENT,
      receiptSucceeded: false,
      replacement: { reason: 'repriced', hash: REPLACEMENT },
    })).toEqual({ kind: 'reverted', finalHash: REPLACEMENT });
  });

  // THE LIE THIS CLOSES: a cancel is a 0-value self-send that SUCCEEDS, so the
  // receipt says success while the payment never happened. The receipt status
  // must be ignored for cancelled/replaced.
  test('cancelled + successful receipt => not-sent, NOT success', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: REPLACEMENT,
      receiptSucceeded: true,
      replacement: { reason: 'cancelled', hash: REPLACEMENT },
    })).toEqual({ kind: 'not-sent', reason: 'cancelled', replacementHash: REPLACEMENT });
  });

  // codex: viem's 'replaced' label is a heuristic over RPC-rendered strings
  // (case-SENSITIVE to/value/input compare) — it can cover our own payment
  // re-rendered with different casing. A definitive "not sent" here invites
  // paying twice, so it must be indeterminate, for BOTH receipt statuses.
  test("generic 'replaced' is indeterminate, never a definitive not-sent", () => {
    for (const receiptSucceeded of [true, false]) {
      expect(interpretPaymentReceipt({
        submittedHash: SUBMITTED,
        receiptHash: REPLACEMENT,
        receiptSucceeded,
        replacement: { reason: 'replaced', hash: REPLACEMENT },
      })).toEqual({ kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: REPLACEMENT });
    }
  });

  // codex: cancelled must ignore the receipt status in BOTH directions — a
  // mutation returning 'reverted' for a failed cancel receipt survived the
  // success-only assertion.
  test('cancelled ignores the receipt status entirely', () => {
    for (const receiptSucceeded of [true, false]) {
      expect(interpretPaymentReceipt({
        submittedHash: SUBMITTED,
        receiptHash: REPLACEMENT,
        receiptSucceeded,
        replacement: { reason: 'cancelled', hash: REPLACEMENT },
      })).toEqual({ kind: 'not-sent', reason: 'cancelled', replacementHash: REPLACEMENT });
    }
  });

  // kimi's surviving mutant 4a: no test exercised a receipt-vs-replacement
  // hash pair differing only by case, so dropping lower() on that comparison
  // passed. The wrapper feeds the replacement hash from a block payload,
  // unnormalized — the classifier must not care.
  test('replacement-hash comparison is case-insensitive', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: REPLACEMENT,
      receiptSucceeded: true,
      replacement: { reason: 'repriced', hash: '0xBBBB' as Hex },
    })).toEqual({ kind: 'success', finalHash: REPLACEMENT, replacedFrom: SUBMITTED });
  });

  // codex: a "replacement" carrying the submitted hash is self-contradictory
  // (a tx cannot replace itself) — a lagging RPC can produce it, and it must
  // land on indeterminate rather than not-sent.
  test('a self-replacement signal is a contradiction, not a cancellation', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: SUBMITTED,
      receiptSucceeded: true,
      replacement: { reason: 'cancelled', hash: SUBMITTED },
    })).toEqual({ kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: SUBMITTED });
  });
});

describe('interpretPaymentReceipt. Contradictions never guess', () => {
  // A wrong "failed" makes the user pay twice; a wrong "sent" hides that they
  // never paid. Contradictory signals must land on indeterminate.
  test('foreign receipt hash with NO replacement signal => indeterminate', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: REPLACEMENT,
      receiptSucceeded: true,
      replacement: null,
    })).toEqual({ kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: REPLACEMENT });
  });

  test('replacement signal whose hash matches neither => indeterminate', () => {
    expect(interpretPaymentReceipt({
      submittedHash: SUBMITTED,
      receiptHash: '0xcccc' as Hex,
      receiptSucceeded: true,
      replacement: { reason: 'repriced', hash: REPLACEMENT },
    })).toEqual({ kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: '0xcccc' });
  });
});

describe('waitForPaymentTx. The viem glue', () => {
  const clientReturning = (
    receipt: { transactionHash: Hex; status: 'success' | 'reverted' },
    replaced?: { reason: ReplacementReason; hash: Hex },
  ): ReceiptWaiterClient => ({
    async waitForTransactionReceipt(args) {
      // Mirror viem's verified ordering: onReplaced fires BEFORE resolution.
      if (replaced) args.onReplaced?.({ reason: replaced.reason, transaction: { hash: replaced.hash } });
      return receipt;
    },
  });

  test('captures the onReplaced signal and classifies a speed-up', async () => {
    const outcome = await waitForPaymentTx(
      clientReturning({ transactionHash: REPLACEMENT, status: 'success' }, { reason: 'repriced', hash: REPLACEMENT }),
      SUBMITTED,
    );
    expect(outcome).toEqual({ kind: 'success', finalHash: REPLACEMENT, replacedFrom: SUBMITTED });
  });

  test('classifies a cancel as not-sent despite the successful receipt', async () => {
    const outcome = await waitForPaymentTx(
      clientReturning({ transactionHash: REPLACEMENT, status: 'success' }, { reason: 'cancelled', hash: REPLACEMENT }),
      SUBMITTED,
    );
    expect(outcome.kind).toBe('not-sent');
  });

  test('plain confirmation stays a plain success', async () => {
    const outcome = await waitForPaymentTx(
      clientReturning({ transactionHash: SUBMITTED, status: 'success' }),
      SUBMITTED,
    );
    expect(outcome).toEqual({ kind: 'success', finalHash: SUBMITTED, replacedFrom: null });
  });

  test('propagates a wait failure (timeout/network) rather than inventing an outcome', async () => {
    const boom: ReceiptWaiterClient = {
      async waitForTransactionReceipt() { throw new Error('timed out'); },
    };
    await expect(waitForPaymentTx(boom, SUBMITTED)).rejects.toThrow('timed out');
  });

  test('passes a default timeout so a dead RPC cannot hang the flow forever', async () => {
    let seenTimeout: number | undefined;
    const spy: ReceiptWaiterClient = {
      async waitForTransactionReceipt(args) {
        seenTimeout = args.timeout;
        return { transactionHash: SUBMITTED, status: 'success' };
      },
    };
    await waitForPaymentTx(spy, SUBMITTED);
    expect(seenTimeout).toBe(180_000);
  });
});

describe('describePaymentTxOutcome', () => {
  test('success carries no error copy; every failure kind does', () => {
    const success: PaymentTxOutcome = { kind: 'success', finalHash: SUBMITTED, replacedFrom: null };
    expect(describePaymentTxOutcome(success)).toBeNull();
    for (const outcome of [
      { kind: 'reverted', finalHash: SUBMITTED },
      { kind: 'not-sent', reason: 'cancelled', replacementHash: REPLACEMENT },
      { kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: REPLACEMENT },
    ] as PaymentTxOutcome[]) {
      const text = describePaymentTxOutcome(outcome);
      expect(typeof text).toBe('string');
      expect((text ?? '').length).toBeGreaterThan(20);
    }
  });

  test('cancelled names the cancel; indeterminate sends the user to the explorer', () => {
    expect(describePaymentTxOutcome({ kind: 'not-sent', reason: 'cancelled', replacementHash: REPLACEMENT }))
      .toMatch(/cancelled/);
    expect(describePaymentTxOutcome({ kind: 'indeterminate', submittedHash: SUBMITTED, receiptHash: REPLACEMENT }))
      .toMatch(/explorer/);
  });
});
