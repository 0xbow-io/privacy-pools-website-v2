import { describe, expect, test } from 'bun:test';
import {
  buildPaymentRequestDepositNoteData,
  PaymentRequestDepositError,
  DEPOSIT_SLOT_INDEX,
  type NoteComputationLike,
  type SdkNativeRequestLike,
} from '../payment-request-deposit';

const TAG = '0x1111111111111111111111111111111111111111111111111111111111111111';
const PUBKEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const SLOT_A = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const SLOT_B = '0xbbbb000000000000000000000000000000000000000000000000000000000002';
const PLACEHOLDER = `0x${'00'.repeat(32)}`;
const SECRET = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';

const request = (over: Partial<SdkNativeRequestLike> = {}): SdkNativeRequestLike => ({
  tokenId: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  amount: '0x038d7ea4c68000',
  paymentPubKey: PUBKEY,
  tag: TAG,
  noteSecretsMap: [[SLOT_A, PLACEHOLDER], [SLOT_B, PLACEHOLDER]],
  ...over,
});

/** Records what it was asked, and echoes the hint back like the real SDK does. */
function noteComputation(over: Partial<NoteComputationLike> = {}) {
  const calls: Record<string, unknown[]> = { precommitment: [], label: [], noteData: [] };
  const svc: NoteComputationLike = {
    computePrecommitment(noteAddressHash, tokenId, value) {
      calls.precommitment.push([noteAddressHash, tokenId, value]);
      return '0xprecommit';
    },
    computeLabel(precommitment, depositSecret) {
      calls.label.push([precommitment, depositSecret]);
      return '0xlabel';
    },
    generatePaymentRequestNoteData(payload, recipientViewingPubKey, hint) {
      calls.noteData.push([payload, recipientViewingPubKey, hint]);
      return { hint: hint as string, data: '0xciphertext' };
    },
    ...over,
  };
  return { svc, calls };
}

describe('buildPaymentRequestDepositNoteData', () => {
  test('tags the note with the request tag, which is the whole point', () => {
    const { svc } = noteComputation();
    const out = buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET });
    // A deposit that does not carry the tag is invisible to the receiver's
    // scanPaymentRequests, which is the bug the original gate prevented.
    expect(out.noteData.hint).toBe(TAG);
    expect(out.noteData.data).toBe('0xciphertext');
  });

  test('encrypts to the per-request paymentPubKey, not a wallet viewing key', () => {
    const { svc, calls } = noteComputation();
    buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET });
    const [, pubkey, hint] = calls.noteData[0] as [unknown, string, string];
    expect(pubkey).toBe(PUBKEY);
    expect(hint).toBe(TAG);
  });

  test('binds to a slot the RECEIVER pre-allocated, and takes the first', () => {
    const { svc, calls } = noteComputation();
    const out = buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET });
    expect(out.noteAddressHash).toBe(SLOT_A);
    expect(DEPOSIT_SLOT_INDEX).toBe(0);
    const [payload] = calls.noteData[0] as [{ noteAddressHash: string }];
    expect(payload.noteAddressHash).toBe(SLOT_A);
  });

  test('derives the label from OUR depositSecret, so the payload names the real lineage', () => {
    const { svc, calls } = noteComputation();
    const out = buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET });
    expect(calls.precommitment[0]).toEqual([SLOT_A, request().tokenId, request().amount]);
    expect(calls.label[0]).toEqual(['0xprecommit', SECRET]);
    const [payload] = calls.noteData[0] as [{ label: string; value: string; tokenId: string }];
    expect(payload.label).toBe('0xlabel');
    expect(payload.value).toBe(request().amount);
    expect(payload.tokenId).toBe(request().tokenId);
    // Returned so the caller submits the SAME secret it committed to; a
    // mismatch reverts on-chain with PoolVault_ProofContextMismatch.
    expect(out.depositSecret).toBe(SECRET);
    expect(out.label).toBe('0xlabel');
  });

  test('does not need the slot SECRETS, which a shared link never carries', () => {
    // Every secret in a shared payload is the placeholder; requiring one would
    // make wallet-pay impossible for exactly the links people actually send.
    const { svc } = noteComputation();
    const out = buildPaymentRequestDepositNoteData({
      request: request({ noteSecretsMap: [[SLOT_A, PLACEHOLDER]] }),
      noteComputation: svc,
      depositSecret: SECRET,
    });
    expect(out.noteAddressHash).toBe(SLOT_A);
  });

  test('refuses when the SDK hands back a hint that is not the tag', () => {
    // The untagged-note case is unrecoverable once broadcast, so it must fail
    // BEFORE any transaction rather than be discovered afterwards.
    const { svc } = noteComputation({
      generatePaymentRequestNoteData: () => ({ hint: '0xdead', data: '0xciphertext' }),
    });
    expect(() => buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET }))
      .toThrow();
  });

  test('refuses an empty note payload rather than broadcasting one', () => {
    const { svc } = noteComputation({
      generatePaymentRequestNoteData: () => ({ hint: TAG, data: '' }),
    });
    expect(() => buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET }))
      .toThrow();
  });

  test('refuses a request with no slots, no tag, or no payment key', () => {
    const { svc } = noteComputation();
    const cases: Array<Partial<SdkNativeRequestLike>> = [
      { noteSecretsMap: [] },
      { tag: '' },
      { paymentPubKey: '' },
    ];
    for (const over of cases) {
      expect(() => buildPaymentRequestDepositNoteData({ request: request(over), noteComputation: svc, depositSecret: SECRET }))
        .toThrow();
    }
  });

  test('refuses an empty slot entry', () => {
    const { svc } = noteComputation();
    expect(() => buildPaymentRequestDepositNoteData({
      request: request({ noteSecretsMap: [['', PLACEHOLDER]] }),
      noteComputation: svc,
      depositSecret: SECRET,
    })).toThrow();
  });

  test('refuses a missing deposit secret', () => {
    const { svc } = noteComputation();
    expect(() => buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: '' }))
      .toThrow();
  });

  test('tag comparison is case-insensitive, so hex casing is not a false failure', () => {
    const { svc } = noteComputation({
      generatePaymentRequestNoteData: (_p, _k, hint) => ({ hint: (hint as string).toUpperCase(), data: '0xc' }),
    });
    const out = buildPaymentRequestDepositNoteData({ request: request(), noteComputation: svc, depositSecret: SECRET });
    expect(out.noteData.hint.toLowerCase()).toBe(TAG.toLowerCase());
  });
});
