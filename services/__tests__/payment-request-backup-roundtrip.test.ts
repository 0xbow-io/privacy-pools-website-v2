// Round-trips payment-request state through the exact pure serializers the
// backup/restore paths use:
//   - prepareAccountBackup / parseAccountBackup (wallet-backup-encryption.ts)
//     serialize the envelope with stringifyWithMaps and parse it back with
//     parseWithMaps (both the plain path and the encrypted plaintext), then
//     validate with PaymentRequestServiceStateSchema before merging.
//   - the SDK's exportAccount emits paymentRequests with noteSecretsMap as
//     entries arrays; its importAccount validates against the same schema
//     shape our local mirror reproduces.
// The storage adapters and WebCrypto wrappers around these are react-native
// bound and covered by the app; the wire format is what must not drift.

import { describe, expect, test } from 'bun:test';

import { parseWithMaps, stringifyWithMaps } from '@/services/json-maps';
import { PaymentRequestServiceStateSchema } from '@/services/payment-request-state-schema';
import { upgradeLegacyPaymentRequestState } from '@/services/payment-request-state-migration';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;

function storedRecord(n: number, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: hash(n),
    noteAddressHashes: [hash(n + 1), hash(n + 2)],
    noteSecretsMap: new Map([
      [hash(n + 1), hash(n + 3)],
      [hash(n + 2), hash(n + 4)],
    ]),
    amount: '0xde0b6b3a7640000',
    tokenId: addr(0xeee),
    tag: hash(n + 5),
    paymentPubKey: hash(n + 6),
    recipientAddress: addr(0x111),
    status: 'OPEN' as const,
    createdAt: '0x19794ba2c00',
    fulfilledByCommitments: [],
    ...overrides,
  };
}

describe('payment-request state round-trip through the backup serializers', () => {
  test('Map-carrying state survives stringifyWithMaps → parseWithMaps → schema', () => {
    const state = { requests: [storedRecord(1)] };
    const envelope = {
      notes: [],
      syncCursor: '0x0',
      paymentRequests: state,
    };

    const revived = parseWithMaps(stringifyWithMaps(envelope)) as typeof envelope;
    // The slot map must come back as a REAL Map — plain JSON.stringify would
    // have dropped it to {} and the schema would reject the whole blob.
    const revivedMap = revived.paymentRequests.requests[0].noteSecretsMap;
    expect(revivedMap instanceof Map).toBe(true);
    expect((revivedMap as Map<string, string>).size).toBe(2);

    const parsed = PaymentRequestServiceStateSchema.safeParse(revived.paymentRequests);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requests[0].paymentId).toBe(hash(1));
    expect(parsed.data.requests[0].noteSecretsMap.get(hash(2))).toBe(hash(4));
  });

  test('plain JSON round-trip drops Maps. The failure mode the tagged codec exists for', () => {
    const state = { requests: [storedRecord(1)] };
    const naive = JSON.parse(JSON.stringify(state));
    // Naive stringify turns the Map into {} — an empty slot map, which the
    // schema rejects (noteSecretsMap must contain at least one slot).
    expect(PaymentRequestServiceStateSchema.safeParse(naive).success).toBe(false);
    // The tagged codec keeps it valid.
    expect(
      PaymentRequestServiceStateSchema.safeParse(parseWithMaps(stringifyWithMaps(state))).success,
    ).toBe(true);
  });

  test('SDK exportAccount shape (entries arrays) validates and normalizes to Maps', () => {
    // exportState() serializes noteSecretsMap as Array.from(map.entries()).
    const serialized = {
      requests: [storedRecord(1, {
        noteSecretsMap: [
          [hash(2), hash(4)],
          [hash(3), hash(5)],
        ],
      })],
    };
    const roundTripped = JSON.parse(JSON.stringify(serialized));
    const parsed = PaymentRequestServiceStateSchema.safeParse(roundTripped);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.requests[0].noteSecretsMap instanceof Map).toBe(true);
    expect(parsed.data.requests[0].noteSecretsMap.get(hash(3))).toBe(hash(5));
  });

  test('legacy (pre-v2.0) records upgrade, round-trip, and RETAIN the stored private key', () => {
    // The old SDK generated a RANDOM ephemeral keypair per request and
    // persisted the private half; the current SDK derives the key from the
    // viewing key instead, so for legacy records the stored key is the ONLY
    // copy that pairs with the published paymentPubKey. Upgrading or backing
    // the record up must never drop it.
    const legacyState = {
      requests: [{
        paymentId: hash(1),
        paymentPrivKey: hash(9),
        noteSecretsMap: { [hash(2)]: hash(4) },
        amount: '0xde0b6b3a7640000',
        tokenId: addr(0xeee),
        tag: hash(6),
        paymentPubKey: hash(7),
        recipientAddress: addr(0x111),
        status: 'OPEN',
        createdAt: '0x19794ba2c00',
        fulfilledByCommitments: [],
      }],
    };
    const upgraded = upgradeLegacyPaymentRequestState(
      parseWithMaps(stringifyWithMaps(legacyState)),
    );
    const parsed = PaymentRequestServiceStateSchema.safeParse(upgraded);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const record = parsed.data.requests[0] as unknown as Record<string, unknown>;
    expect(record.noteAddressHashes).toEqual([hash(2)]);
    expect(record.paymentPrivKey).toBe(hash(9));

    // And it survives the backup serializers end to end.
    const roundTripped = PaymentRequestServiceStateSchema.safeParse(
      parseWithMaps(stringifyWithMaps(parsed.data)),
    );
    expect(roundTripped.success).toBe(true);
    if (!roundTripped.success) return;
    expect((roundTripped.data.requests[0] as unknown as Record<string, unknown>).paymentPrivKey).toBe(hash(9));
  });
});

// ---------------------------------------------------------------------------
// P0: rendering must never mutate storage, and the historical random-key
// fixture must keep its working keypair through upgrade + round-trip.
// ---------------------------------------------------------------------------

import { x25519 } from '@noble/curves/ed25519.js';

import {
  paymentRequestStateKey,
  readAllPaymentRequestStatesNoWrite,
  readPaymentRequestStateNoWrite,
} from '@/services/payment-request-store-read';

const OWNER = addr(0x111);
const CHAIN = 11155111;

/** Storage double that records every call; the reader must never write. */
function recordingStorage(seed: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(key: string): Promise<T | null> {
      calls.push(`get:${key}`);
      return (key in seed ? (seed[key] as T) : null);
    },
    async set(key: string): Promise<void> {
      calls.push(`set:${key}`);
      throw new Error('reader must not write');
    },
    async delete(key: string): Promise<void> {
      calls.push(`delete:${key}`);
      throw new Error('reader must not write');
    },
  };
}

describe('no-write payment-request store reader (card/backup read path)', () => {
  // Historical (pre-v2.0 SDK, 3a3f5f9-era) stored shape: random X25519
  // keypair persisted with the record, no noteAddressHashes array,
  // noteSecretsMap as a plain object (JSON persistence).
  const legacyPriv = `0x${Buffer.from(x25519.utils.randomSecretKey()).toString('hex')}`;
  const legacyPub = `0x${Buffer.from(x25519.getPublicKey(Buffer.from(legacyPriv.slice(2), 'hex'))).toString('hex')}`;
  const historicalState = {
    requests: [{
      paymentId: hash(0xa1),
      paymentPrivKey: legacyPriv,
      paymentPubKey: legacyPub,
      noteSecretsMap: { [hash(0xb1)]: hash(0xc1) },
      amount: '0xde0b6b3a7640000',
      tokenId: addr(0xeee),
      tag: hash(0xd1),
      recipientAddress: OWNER,
      status: 'OPEN',
      createdAt: '0x19794ba2c00',
      fulfilledByCommitments: [],
    }],
  };

  test('reads and normalizes legacy state with ZERO storage writes', async () => {
    const storage = recordingStorage({ [paymentRequestStateKey(CHAIN, OWNER)]: historicalState });
    const chains = await readAllPaymentRequestStatesNoWrite(storage, [CHAIN, 1], OWNER);

    expect(Object.keys(chains)).toEqual([String(CHAIN)]);
    const record = chains[String(CHAIN)].requests[0] as unknown as Record<string, unknown>;
    expect(record.noteAddressHashes).toEqual([hash(0xb1)]);
    expect(record.noteSecretsMap instanceof Map).toBe(true);

    // No write of any kind — only reads.
    expect(storage.calls.filter((c) => !c.startsWith('get:'))).toEqual([]);
  });

  test('the historical random keypair survives upgrade + backup round-trip and still pairs', async () => {
    const storage = recordingStorage({ [paymentRequestStateKey(CHAIN, OWNER)]: historicalState });
    const state = await readPaymentRequestStateNoWrite(storage, CHAIN, OWNER);
    expect(state).not.toBeNull();

    // Through the exact serializers the backup paths use.
    const restored = PaymentRequestServiceStateSchema.safeParse(
      parseWithMaps(stringifyWithMaps(state)),
    );
    expect(restored.success).toBe(true);
    if (!restored.success) return;
    const record = restored.data.requests[0] as unknown as { paymentPrivKey?: string; paymentPubKey: string };

    // The stored private half is retained…
    expect(record.paymentPrivKey).toBe(legacyPriv);
    // …and still pairs with the published public key, i.e. a payment
    // encrypted to the old link's paymentPubKey remains decryptable with
    // what the store/backup now carries.
    const derivedPub = `0x${Buffer.from(
      x25519.getPublicKey(Buffer.from(record.paymentPrivKey!.slice(2), 'hex')),
    ).toString('hex')}`;
    expect(derivedPub).toBe(record.paymentPubKey);
  });

  test('missing state and unreadable blobs return null without writes', async () => {
    const storage = recordingStorage({ [paymentRequestStateKey(CHAIN, OWNER)]: { requests: 'garbage' } });
    expect(await readPaymentRequestStateNoWrite(storage, 1, OWNER)).toBeNull();
    expect(await readPaymentRequestStateNoWrite(storage, CHAIN, OWNER)).toBeNull();
    expect(storage.calls.filter((c) => !c.startsWith('get:'))).toEqual([]);
  });
});
