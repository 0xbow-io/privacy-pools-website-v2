import { describe, expect, test } from 'bun:test';

import { upgradeLegacyPaymentRequestState } from '@/services/payment-request-state-migration';
import { PaymentRequestServiceStateSchema } from '@/services/payment-request-state-schema';

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const addr = (byte: string) => `0x${byte.repeat(20)}`;

// A record as the pre-v2.0 SDK persisted it: paymentPrivKey present,
// no noteAddressHashes, noteSecretsMap as array-of-entries.
function legacyRecord() {
  return {
    paymentId: hex('11'),
    noteSecretsMap: [
      [hex('aa'), hex('a1')],
      [hex('bb'), hex('b1')],
    ],
    amount: '0x2386f26fc10000',
    tokenId: addr('ee'),
    tag: hex('22'),
    paymentPubKey: hex('33'),
    paymentPrivKey: hex('44'),
    recipientAddress: addr('cd'),
    status: 'OPEN',
    createdAt: '0x1972d3f3a00',
    fulfilledByCommitments: [],
  };
}

describe('v2.0 payment-request state migration', () => {
  test('backfills noteAddressHashes from noteSecretsMap keys and RETAINS paymentPrivKey', () => {
    const upgraded = upgradeLegacyPaymentRequestState({ requests: [legacyRecord()] }) as {
      requests: Record<string, unknown>[];
    };
    expect(upgraded.requests[0].noteAddressHashes).toEqual([hex('aa'), hex('bb')]);
    // The legacy stored key is a RANDOM ephemeral key the current SDK cannot
    // re-derive — dropping it would permanently break discovery for
    // payments made against the old link. It must survive the upgrade.
    expect(upgraded.requests[0].paymentPrivKey).toBe(hex('44'));
  });

  test('upgraded legacy state passes the v2.0 stored-state schema', () => {
    const upgraded = upgradeLegacyPaymentRequestState({ requests: [legacyRecord()] });
    const parsed = PaymentRequestServiceStateSchema.safeParse(upgraded);
    expect(parsed.success).toBe(true);
  });

  test('raw legacy state (pre-upgrade) is rejected by the v2.0 schema. The migration is load-bearing', () => {
    const parsed = PaymentRequestServiceStateSchema.safeParse({ requests: [legacyRecord()] });
    expect(parsed.success).toBe(false);
  });

  test('handles Map-shaped noteSecretsMap (old adapter persisted real Maps via the Map-aware serializer)', () => {
    const record = legacyRecord() as Record<string, unknown>;
    record.noteSecretsMap = new Map([
      [hex('aa'), hex('a1')],
      [hex('bb'), hex('b1')],
    ]);
    const upgraded = upgradeLegacyPaymentRequestState({ requests: [record] }) as {
      requests: Record<string, unknown>[];
    };
    expect(upgraded.requests[0].noteAddressHashes).toEqual([hex('aa'), hex('bb')]);
  });

  test('returns v2.0-shaped state untouched (idempotent, same reference)', () => {
    const record = legacyRecord() as Record<string, unknown>;
    delete record.paymentPrivKey;
    record.noteAddressHashes = [hex('aa'), hex('bb')];
    const state = { requests: [record] };
    expect(upgradeLegacyPaymentRequestState(state)).toBe(state);
  });
});
