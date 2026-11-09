// Switching the Freighter account keeps each unlocked account's session in
// memory under its own address (DEV-644). The key derivation is stubbed (one
// call = one wallet signature); everything else is the real StellarAccount.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { stellarAccount } = await import('@/services/stellar/stellar-account');

const A = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const B = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const signer = {} as never;

type Internals = {
  buildSession: (address: string) => Promise<unknown>;
  sessionPromise: Promise<unknown> | null;
  unlockedSessions: Map<string, unknown>;
  snapshot: Record<string, unknown>;
};
const internals = stellarAccount as unknown as Internals;

let signatures: string[] = [];
let gate: Promise<void> | null = null;

beforeEach(() => {
  signatures = [];
  gate = null;
  stellarAccount.bind(null, null);
  internals.buildSession = async (address: string) => {
    signatures.push(address);
    if (gate) await gate;
    return { owner: address, n: signatures.length };
  };
});

afterEach(() => {
  stellarAccount.bind(null, null);
});

describe('Stellar account sessions across a wallet account switch', () => {
  test('A to B to A keeps A unlocked and asks for no second signature', async () => {
    stellarAccount.bind(A, signer);
    const sessionA = await stellarAccount.ensureSession();
    expect(stellarAccount.getSnapshot().unlocked).toBe(true);

    stellarAccount.bind(B, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    expect(stellarAccount.getSnapshot().address).toBe(B);

    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(true);
    expect(stellarAccount.getSnapshot().status).toBe('ready');
    expect(await stellarAccount.ensureSession()).toBe(sessionA);
    expect(signatures).toEqual([A]);
  });

  test("B's session is its own, and A's is untouched", async () => {
    stellarAccount.bind(A, signer);
    const sessionA = (await stellarAccount.ensureSession()) as unknown as { owner: string };
    stellarAccount.bind(B, signer);
    const sessionB = (await stellarAccount.ensureSession()) as unknown as { owner: string };
    expect(sessionB).not.toBe(sessionA);
    expect(sessionB.owner).toBe(B);
    expect(signatures).toEqual([A, B]);

    stellarAccount.bind(A, signer);
    expect(((await stellarAccount.ensureSession()) as unknown as { owner: string }).owner).toBe(A);
    stellarAccount.bind(B, signer);
    expect(((await stellarAccount.ensureSession()) as unknown as { owner: string }).owner).toBe(B);
    expect(signatures).toEqual([A, B]);
  });

  test('signing out clears every kept session', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    stellarAccount.bind(B, signer);
    await stellarAccount.ensureSession();
    stellarAccount.bind(A, signer);
    expect(internals.unlockedSessions.size).toBe(1);

    stellarAccount.bind(null, null);
    expect(internals.unlockedSessions.size).toBe(0);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);

    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    await stellarAccount.ensureSession();
    expect(signatures).toEqual([A, B, A]);
  });

  test('switching back keeps the account note origins, B never sees them', async () => {
    const origins = { complete: true, byCommitment: { c1: {} } };
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    internals.snapshot = { ...internals.snapshot, noteOrigins: origins };

    stellarAccount.bind(B, signer);
    expect(stellarAccount.getSnapshot().noteOrigins).toBeNull();

    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().noteOrigins as unknown).toBe(origins);
    expect(signatures).toEqual([A]);
  });

  test('an address change during an unlock never attaches that session to the new account', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    stellarAccount.bind(A, signer);
    const pendingA = stellarAccount.ensureSession();

    stellarAccount.bind(B, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    release();
    gate = null;
    await pendingA;

    // A's late result changed nothing for B.
    expect(stellarAccount.getSnapshot().address).toBe(B);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    expect(internals.sessionPromise).toBeNull();
    const sessionB = (await stellarAccount.ensureSession()) as unknown as { owner: string };
    expect(sessionB.owner).toBe(B);

    // A was never unlocked while bound, so switching back asks again.
    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    expect(internals.unlockedSessions.has(A)).toBe(false);
  });
});
