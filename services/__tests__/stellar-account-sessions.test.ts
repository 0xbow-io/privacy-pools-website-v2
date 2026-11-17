// Switching the Varial account keeps each unlocked account's session in
// memory under its own address (DEV-644). The key derivation is stubbed (one
// call = one wallet signature); everything else is the real StellarAccount.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { stellarAccount } = await import('@/services/stellar/stellar-account');
const { watchVarial } = await import('@/services/stellar/varial-watch');
const { bindStellarWallet, showStellarSignOut } = await import('@/services/stellar/stellar-wallet-binding');

const A = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const B = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const C = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const TESTNET = 'Test SDF Network ; September 2015';

// The wallet: every transaction it is asked to sign, and a gate that holds the
// approval open (the Varial popup) while a test switches accounts.
let walletSigned: string[] = [];
let walletGate: Promise<void> | null = null;
let onWalletAsked: (() => void) | null = null;
const signer = {
  getAddress: async () => '',
  getNetworkPassphrase: async () => TESTNET,
  signTransaction: async (xdr: string) => {
    onWalletAsked?.();
    if (walletGate) await walletGate;
    walletSigned.push(xdr);
    return `signed:${xdr}`;
  },
} as never;

type Wallet = { signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<string> };
type Internals = {
  buildSession: (address: string, signer: unknown) => Promise<unknown>;
  sessionWallet: (owner: string, signer: unknown) => Wallet;
  sessionPromise: Promise<unknown> | null;
  unlockedSessions: Map<string, unknown>;
  snapshot: Record<string, unknown>;
};
const internals = stellarAccount as unknown as Internals;

let signatures: string[] = [];
let gate: Promise<void> | null = null;

// Only the SDK session is faked: it signs through the store's real session
// wallet, the way the SDK's wallet interactor does on submission.
function fakeSession(owner: string, n: number, wallet: Wallet) {
  return {
    owner,
    n,
    prepareRegisterKeystore: async () => ({ alreadyRegistered: true }),
    rageQuit: async ({ commitment }: { commitment: string }) => ({
      status: true,
      txHash: await wallet.signTransaction(`exit-${owner.slice(0, 2)}-${commitment}`, { networkPassphrase: TESTNET }),
    }),
    exportAccount: async () => ({ notes: [], paymentRequests: [] }),
  };
}

beforeEach(() => {
  signatures = [];
  gate = null;
  walletSigned = [];
  walletGate = null;
  onWalletAsked = null;
  stellarAccount.bind(null, null);
  internals.buildSession = async (address: string, boundSigner: unknown) => {
    signatures.push(address);
    if (gate) await gate;
    return fakeSession(address, signatures.length, internals.sessionWallet(address, boundSigner));
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

const exit = () => stellarAccount.ragequit({ commitment: '0x1' as `0x${string}` });

describe('Signing with a kept session after switching back', () => {
  test('A to B to A: the restored session signs a new transaction', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    stellarAccount.bind(B, signer);
    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(true);

    expect(await exit()).toEqual({ txHash: 'signed:exit-GA-0x1' });
    expect(walletSigned).toEqual(['exit-GA-0x1']);
    expect(signatures).toEqual([A]);
  });

  test('switching away and back while the wallet is asked keeps that operation cancelled, the next one signs', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();

    let approve!: () => void;
    walletGate = new Promise<void>((resolve) => (approve = resolve));
    const asked = new Promise<void>((resolve) => (onWalletAsked = resolve));
    const stale = exit();
    await asked;

    // The popup is open: the user switches to B and back to A, then approves.
    stellarAccount.bind(B, signer);
    stellarAccount.bind(A, signer);
    approve();
    walletGate = null;
    onWalletAsked = null;
    await expect(stale).rejects.toThrow('The connected Stellar account changed. Start again.');

    // A fresh operation on the restored session goes through.
    expect(stellarAccount.getSnapshot().unlocked).toBe(true);
    expect(await exit()).toEqual({ txHash: 'signed:exit-GA-0x1' });
    expect(signatures).toEqual([A]);
  });

  test('an operation started on A never signs while B is bound', async () => {
    stellarAccount.bind(A, signer);
    await stellarAccount.ensureSession();
    let approve!: () => void;
    walletGate = new Promise<void>((resolve) => (approve = resolve));
    const asked = new Promise<void>((resolve) => (onWalletAsked = resolve));
    const stale = exit();
    await asked;

    stellarAccount.bind(B, signer);
    approve();
    await expect(stale).rejects.toThrow('The connected Stellar account changed. Start again.');
    expect(stellarAccount.getSnapshot().address).toBe(B);
  });
});

describe('Varial selecting an account this site is not allowed for yet', () => {
  // Varial scopes site access per account: an account the site was never
  // allowed for reads as "" with isAllowed false, the same as a revoked site.
  function fakeVarial() {
    const state = { selected: A, allowed: new Set([A, B]) };
    const api = {
      getAddress: async () => ({ address: state.allowed.has(state.selected) ? state.selected : '' }),
      getNetworkDetails: async () => ({ network: '', networkUrl: '', networkPassphrase: TESTNET }),
      isAllowed: async () => ({ isAllowed: state.allowed.has(state.selected) }),
    };
    return { state, api: api as never };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  // The wallet provider's wiring (components/stellar-wallet-provider.tsx and
  // hooks/use-stellar-session.ts): a change adopts the account, losing it keeps
  // the account signed in, and only Disconnect signs out.
  function follow(api: never, start: string) {
    stellarAccount.bind(start, signer);
    return watchVarial(api, { address: start, passphrase: TESTNET }, {
      change: ({ address }) => stellarAccount.bind(address, signer),
      revoked: () => stellarAccount.bind(null, null, { keepSessions: true }),
    }, 2, 20);
  }

  test('A to B to unregistered C, then C registers: A and B stay unlocked, C signs once', async () => {
    const varial =fakeVarial();
    const watcher = follow(varial.api, A);
    try {
      await stellarAccount.ensureSession();
      varial.state.selected = B;
      await settle();
      expect(stellarAccount.getSnapshot().address).toBe(B);
      await stellarAccount.ensureSession();

      varial.state.selected = C;
      await settle();
      expect(stellarAccount.getSnapshot().address).toBeNull();
      expect(stellarAccount.getSnapshot().unlocked).toBe(false);

      // The user allows the site for C in Varial.
      varial.state.allowed.add(C);
      await settle();
      expect(stellarAccount.getSnapshot().address).toBe(C);
      expect(stellarAccount.getSnapshot().unlocked).toBe(false);
      await stellarAccount.ensureSession();
      expect(signatures).toEqual([A, B, C]);

      varial.state.selected = A;
      await settle();
      expect(stellarAccount.getSnapshot().address).toBe(A);
      expect(stellarAccount.getSnapshot().unlocked).toBe(true);
      expect(await exit()).toEqual({ txHash: 'signed:exit-GA-0x1' });

      varial.state.selected = B;
      await settle();
      expect(stellarAccount.getSnapshot().address).toBe(B);
      expect(stellarAccount.getSnapshot().unlocked).toBe(true);
      expect(await exit()).toEqual({ txHash: 'signed:exit-GC-0x1' });
      expect(signatures).toEqual([A, B, C]);
    } finally {
      watcher.stop();
    }
  });

  test('signing out after the active account was lost forgets every kept session', async () => {
    const varial =fakeVarial();
    const watcher = follow(varial.api, A);
    try {
      await stellarAccount.ensureSession();
      varial.state.selected = C;
      await settle();
      expect(stellarAccount.getSnapshot().address).toBeNull();
      expect(internals.unlockedSessions.has(A)).toBe(true);
    } finally {
      watcher.stop();
    }
    stellarAccount.bind(null, null);
    expect(internals.unlockedSessions.size).toBe(0);
    stellarAccount.bind(A, signer);
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
  });
});

describe('Sign Out stays reachable while sessions are kept', () => {
  // The wallet states the provider produces (scripts/stellar-wallet-provider.test.ts): connected,
  // after the watcher's revoked path (drop, signedOut stays false), and after Disconnect.
  const connected = (address: string) => ({ address, signer, isConnected: true, signedOut: false });
  const lost = { address: null, signer: null, isConnected: false, signedOut: false };
  const disconnected = { address: null, signer: null, isConnected: false, signedOut: true };
  const header = (wallet: { isConnected: boolean; signedOut: boolean }) => showStellarSignOut({
    activeIsStellar: true,
    walletConnected: wallet.isConnected,
    signedOut: wallet.signedOut,
    keptSessions: stellarAccount.getSnapshot().keptSessions,
  });

  test('a revoke with kept sessions shows Sign Out, and using it makes A sign again', async () => {
    bindStellarWallet(stellarAccount, connected(A));
    await stellarAccount.ensureSession();
    bindStellarWallet(stellarAccount, connected(B));
    await stellarAccount.ensureSession();
    expect(header(connected(B))).toBe(false);

    // Revoked in Varial, or an account the site is not allowed for: no account is connected.
    bindStellarWallet(stellarAccount, lost);
    expect(stellarAccount.getSnapshot().address).toBeNull();
    expect(stellarAccount.getSnapshot().keptSessions).toBe(true);
    expect(header(lost)).toBe(true);

    // Sign Out (the provider's disconnect) forgets every kept session.
    bindStellarWallet(stellarAccount, disconnected);
    expect(internals.unlockedSessions.size).toBe(0);
    expect(stellarAccount.getSnapshot().keptSessions).toBe(false);
    expect(header(disconnected)).toBe(false);

    bindStellarWallet(stellarAccount, connected(A));
    expect(stellarAccount.getSnapshot().unlocked).toBe(false);
    await stellarAccount.ensureSession();
    expect(signatures).toEqual([A, B, A]);
  });

  test('a lost account with nothing unlocked offers no Sign Out', () => {
    bindStellarWallet(stellarAccount, connected(A));
    bindStellarWallet(stellarAccount, lost);
    expect(stellarAccount.getSnapshot().keptSessions).toBe(false);
    expect(header(lost)).toBe(false);
  });

  test('the rule: Stellar selected, no connected account, not signed out, sessions kept', () => {
    const base = { activeIsStellar: true, walletConnected: false, signedOut: false, keptSessions: true };
    expect(showStellarSignOut(base)).toBe(true);
    expect(showStellarSignOut({ ...base, activeIsStellar: false })).toBe(false);
    expect(showStellarSignOut({ ...base, walletConnected: true })).toBe(false);
    expect(showStellarSignOut({ ...base, signedOut: true })).toBe(false);
    expect(showStellarSignOut({ ...base, keptSessions: false })).toBe(false);
  });

  test('the header renders the button from the rule and it calls Disconnect', () => {
    const src = readFileSync('components/ui/header.tsx', 'utf8');
    expect(src).toMatch(/showStellarSignOut\(\{\s*activeIsStellar,\s*walletConnected: stellarWallet\.isConnected,\s*signedOut: stellarWallet\.signedOut,\s*keptSessions: stellarKeptSessions,\s*\}\)/);
    const button = src.slice(src.indexOf('{showStandaloneStellarSignOut && ('), src.indexOf('testID="header-stellar-sign-out"'));
    expect(button).toContain('stellarWallet.disconnect()');
    const hook = readFileSync('hooks/use-stellar-session.ts', 'utf8');
    expect(hook).toContain('bindStellarWallet(stellarAccount, { address, signer, isConnected, signedOut })');
  });
});
