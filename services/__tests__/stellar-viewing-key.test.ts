// The Stellar viewing key the Privacy & keys modal shows: the derived PUBLIC
// key and the published one, both held by the account store. The published key
// is read on the sync pass only, so opening the modal causes no request.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { stellarAccount } = await import('@/services/stellar/stellar-account');

const A = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const B = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const KEY_A = `0x${'a1'.repeat(32)}`;
const signer = { getAddress: async () => '', getNetworkPassphrase: async () => 'Test SDF Network ; September 2015', signTransaction: async (x: string) => x } as never;

type Internals = {
  buildSession: (address: string, signer: unknown) => Promise<unknown>;
  readPublishedViewingKey: (address: string) => Promise<string | null>;
  set: (patch: Record<string, unknown>) => void;
  snapshot: Record<string, unknown>;
};
const internals = stellarAccount as unknown as Internals;

let published: string | null = null;
let reads: string[] = [];

beforeEach(() => {
  published = `0x${'00'.repeat(32)}`;
  reads = [];
  stellarAccount.bind(null, null);
  internals.buildSession = async (address: string) => {
    // What the real build publishes from the derived keys: the public half only.
    if (address === A) internals.set({ viewingPublicKey: KEY_A });
    return {
      discoverNotes: async () => [],
      exportAccount: async () => ({ notes: [], paymentRequests: [] }),
      isKeystoreRegistered: async () => published !== null && !/^0x0*$/.test(published),
    };
  };
  internals.readPublishedViewingKey = async (address: string) => {
    reads.push(address);
    return published;
  };
});

afterEach(() => {
  stellarAccount.bind(null, null);
});

describe('Stellar viewing key in the account store', () => {
  test('unlocking derives the public key; the published one waits for the sync pass', async () => {
    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().viewingPublicKey).toBeNull();
    await stellarAccount.ensureSession();
    expect(stellarAccount.getSnapshot().viewingPublicKey).toBe(KEY_A);
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBeUndefined();
    expect(reads).toEqual([]);

    await stellarAccount.sync();
    expect(reads).toEqual([A]);
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBe(`0x${'00'.repeat(32)}`);
  });

  test('a registration shows up on the next sync; a failed read keeps the last answer', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    published = KEY_A;
    await stellarAccount.sync();
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBe(KEY_A);
    published = null;
    await stellarAccount.sync();
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBe(KEY_A);
  });

  test('a first read that fails reads as unknown, not as unpublished', async () => {
    published = null;
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    await stellarAccount.sync();
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBeNull();
  });

  test('switching accounts never shows one account the other one\'s keys, and switching back restores them', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    published = KEY_A;
    await stellarAccount.sync();

    stellarAccount.bind(B, signer);
    expect(stellarAccount.getSnapshot().viewingPublicKey).toBeNull();
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBeUndefined();

    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().viewingPublicKey).toBe(KEY_A);
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBe(KEY_A);
  });

  test('signing out forgets both', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    await stellarAccount.sync();
    stellarAccount.bind(null, null);
    expect(stellarAccount.getSnapshot().viewingPublicKey).toBeNull();
    expect(stellarAccount.getSnapshot().onChainViewingKey).toBeUndefined();
  });
});

describe('the published key, from the keystore event history', () => {
  // Events shaped as the keystore contract emits them (soroban #[contractevent]:
  // topics [name, account], data a map of the other fields), encoded as asp-v2 serves them.
  const keystoreEvent = async (id: string, account: string, key: string, type = 'viewing_key_set') => {
    const { Address, nativeToScVal, xdr } = await import('@stellar/stellar-sdk');
    const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
    const data = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('old_viewing_key'), val: bytes('00'.repeat(32)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('viewing_key'), val: bytes(key) }),
    ]);
    return {
      id,
      type,
      topics: [nativeToScVal(type, { type: 'symbol' }).toXDR('base64'), new Address(account).toScVal().toXDR('base64')],
      data: data.toXDR('base64'),
    };
  };

  test("the account's latest ViewingKeySet wins; other accounts and other events are ignored", async () => {
    const { publishedStellarViewingKey } = await import('@/services/stellar/stellar-viewing-key');
    const { decodeScVal } = await import('@privacy-pools-v2/stellar-sdk');
    const KEY_A2 = `0x${'a2'.repeat(32)}`;
    const events = [
      // Out of order on purpose: the event id decides.
      await keystoreEvent('0000000000000000300-0000000000', A, KEY_A2),
      await keystoreEvent('0000000000000000100-0000000000', A, KEY_A),
      await keystoreEvent('0000000000000000200-0000000000', B, `0x${'bb'.repeat(32)}`),
      await keystoreEvent('0000000000000000400-0000000000', A, `0x${'cc'.repeat(32)}`, 'auth_policy_set'),
    ];
    expect(publishedStellarViewingKey(events, A, decodeScVal)).toBe(KEY_A2);
    expect(publishedStellarViewingKey(events, B, decodeScVal)).toBe(`0x${'bb'.repeat(32)}`);
  });

  test('an account that never set a key reads as unpublished, not unknown', async () => {
    const { publishedStellarViewingKey, ZERO_VIEWING_KEY } = await import('@/services/stellar/stellar-viewing-key');
    const { decodeScVal } = await import('@privacy-pools-v2/stellar-sdk');
    expect(publishedStellarViewingKey([await keystoreEvent('1', B, KEY_A)], A, decodeScVal)).toBe(ZERO_VIEWING_KEY);
    expect(publishedStellarViewingKey([{ id: '2', type: 'viewing_key_set', topics: ['garbage'], data: 'garbage' }], A, decodeScVal)).toBe(ZERO_VIEWING_KEY);
  });
});
