import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withSessionInitTimeout } from '../session-init-timeout';

import {
  SIGNATURE_TIMEOUT_MS,
  SignatureTimeoutError,
  isCoinbaseWalletIdentity,
  isSignatureTimeout,
  requestWalletSignature,
  resolveWalletIdentity,
  signatureTimeoutFor,
  signatureTimeoutMessage,
  walletConnectPeerName,
  withSignatureTimeout,
} from '../wallet-signature-timeout';

// Exercise the production callbacks without mounting the SDK's React/native tree.
function providerCallback(name: string, env: Record<string, unknown>) {
  const path = new URL('../../components/sdk-provider.tsx', import.meta.url);
  const ast = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let value: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) value = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!value) throw new Error(`Missing production callback ${name}`);
  const callback = ts.isCallExpression(value) ? value.arguments[0] : value;
  return new Function(...Object.keys(env), ts.transpileModule(`return (${callback.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}

describe('withSignatureTimeout', () => {
  test('is about 45s by default', () => {
    expect(SIGNATURE_TIMEOUT_MS).toBe(45_000);
  });

  test('passes a prompt answer through', async () => {
    expect(await withSignatureTimeout(Promise.resolve('0xsig'), { stage: 'initial', timeoutMs: 50 })).toBe('0xsig');
  });

  test('passes a wallet rejection through', async () => {
    await expect(withSignatureTimeout(Promise.reject(new Error('User rejected')), { stage: 'initial', timeoutMs: 50 }))
      .rejects.toThrow('User rejected');
  });

  test('a wallet that never answers times out with the stage and wallet name', async () => {
    let timedOut = false;
    const err = await withSignatureTimeout(new Promise(() => {}), {
      stage: 'proof', walletName: 'Coinbase Wallet', timeoutMs: 10, onTimeout: () => { timedOut = true; },
    }).catch((e) => e);
    expect(timedOut).toBe(true);
    expect(isSignatureTimeout(err)).toBe(true);
    expect((err as SignatureTimeoutError).stage).toBe('proof');
    expect((err as Error).message).toContain('Coinbase Wallet did not answer');
    expect((err as Error).message).toContain('Sign in');
  });

  test('a late answer after the timeout is ignored', async () => {
    let resolveLate: (v: string) => void = () => {};
    const p = withSignatureTimeout(new Promise<string>((r) => { resolveLate = r; }), { stage: 'initial', timeoutMs: 5 });
    const err = await p.catch((e) => e);
    resolveLate('0xlate');
    expect(isSignatureTimeout(err)).toBe(true);
  });

  test('falls back to a generic wallet name, no em dashes', () => {
    expect(signatureTimeoutMessage(null)).toMatch(/^Your wallet did not answer/);
    expect(signatureTimeoutMessage('X')).not.toContain('—');
  });
});

describe('connected wallet identity', () => {
  test('generic injected Coinbase is recognised even when it also claims isMetaMask', async () => {
    const identity = await resolveWalletIdentity({ id: 'injected', name: 'Injected', getProvider: async () => ({ isCoinbaseWallet: true, isMetaMask: true }) });
    expect(isCoinbaseWalletIdentity(identity)).toBe(true);
    expect(signatureTimeoutFor(identity)).toBe(45_000);
  });

  test('compatibility flags cannot override an explicit EIP-6963 identity', async () => {
    let reads = 0;
    for (const id of ['io.metamask', 'io.rabby', 'com.brave.wallet', 'app.phantom']) {
      const identity = await resolveWalletIdentity({ id, getProvider: async () => { reads++; return { isCoinbaseWallet: true }; } });
      expect(isCoinbaseWalletIdentity(identity)).toBe(false);
      expect(isCoinbaseWalletIdentity({ ...identity, flags: { isCoinbaseWallet: true } })).toBe(false);
    }
    expect(reads).toBe(0);
    expect(isCoinbaseWalletIdentity({ id: 'injected', rdns: 'com.coinbase.wallet', name: 'Injected' })).toBe(true);
    expect(isCoinbaseWalletIdentity({ rdns: ['com.coinbase.wallet'] })).toBe(true);
    expect(isCoinbaseWalletIdentity({ id: 'injected', rdns: 'io.rabby', name: 'Coinbase Wallet' })).toBe(false);
    expect(isCoinbaseWalletIdentity({ id: 'injected', flags: { isCoinbaseWallet: true, isRabby: true } })).toBe(false);
    expect(isCoinbaseWalletIdentity({ id: 'injected', flags: { isCoinbaseWallet: 'true' } })).toBe(false);
  });

  test('a Coinbase substring in another wallet name is not Coinbase Wallet', () => {
    expect(isCoinbaseWalletIdentity({ name: 'Not Coinbase Wallet' })).toBe(false);
    expect(isCoinbaseWalletIdentity({ name: 'My Coinbase-compatible wallet' })).toBe(false);
    expect(isCoinbaseWalletIdentity({ name: ' COINBASE WALLET ' })).toBe(true);
  });

  test('WalletConnect uses the peer name, never injected flags or metadata URLs', async () => {
    for (const name of ['Coinbase Wallet', 'MetaMask', 'Rabby Wallet', 'Not Coinbase Wallet']) {
      const identity = await resolveWalletIdentity({
        id: 'walletConnect', name: 'WalletConnect',
        getProvider: async () => ({ isCoinbaseWallet: true, session: { peer: { metadata: { name, url: 'https://www.coinbase.com' } } } }),
      });
      expect(isCoinbaseWalletIdentity(identity)).toBe(name === 'Coinbase Wallet');
    }
    expect(isCoinbaseWalletIdentity(await resolveWalletIdentity({ id: 'walletConnect', getProvider: async () => ({ session: { peer: { metadata: { name: 42 } } } }) }))).toBe(false);
  });

  test('provider failure is bounded and a late rejection is handled', async () => {
    let rejectProvider!: (err: Error) => void;
    const identity = await resolveWalletIdentity({ id: 'walletConnect', getProvider: () => new Promise((_, reject) => { rejectProvider = reject; }) });
    expect(isCoinbaseWalletIdentity(identity)).toBe(false);
    rejectProvider(new Error('late provider failure'));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});

describe('signature request ordering and retry', () => {
  test('metadata resolves before requesting or logging the pending signature', async () => {
    const events: string[] = [];
    let resolveProvider!: (value: unknown) => void;
    const request = requestWalletSignature(async () => { events.push('sign'); return '0xsig'; }, {
      id: 'walletConnect',
      getProvider: () => new Promise((resolve) => { resolveProvider = resolve; }),
    }, { stage: 'initial', onPending: (identity, timeoutMs) => {
      expect(identity.peerName).toBe('Coinbase Wallet');
      expect(timeoutMs).toBe(45_000);
      events.push('pending');
    } });
    expect(events).toEqual([]);
    resolveProvider({ session: { peer: { metadata: { name: 'Coinbase Wallet' } } } });
    expect(await request).toBe('0xsig');
    expect(events).toEqual(['pending', 'sign']);
  });

  test('an obsolete target can abort after metadata without opening a wallet prompt', async () => {
    let prompts = 0;
    await expect(requestWalletSignature(async () => { prompts++; return '0xsig'; }, { id: 'com.coinbase.wallet' }, {
      stage: 'proof', onPending: () => { throw new Error('target changed'); },
    })).rejects.toThrow('target changed');
    expect(prompts).toBe(0);
  });

  test('immediate wallet rejection is handled without waiting for a provider read', async () => {
    let reads = 0;
    await expect(requestWalletSignature(() => Promise.reject(new Error('User rejected')), {
      id: 'com.coinbase.wallet', getProvider: () => { reads++; return new Promise(() => {}); },
    }, { stage: 'initial' })).rejects.toThrow('User rejected');
    expect(reads).toBe(0);
  });

  test('each stage times out once, retries independently and discards late settlements', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      realSetTimeout(fn, ms === 45_000 ? 50 : ms, ...args)) as typeof setTimeout;
    try {
      for (const stage of ['initial', 'proof', 'legacy'] as const) {
        let resolveLate!: (value: string) => void;
        let rejectLate!: (reason: Error) => void;
        let resolveRetry!: (value: string) => void;
        let prompts = 0;
        let initializing = false;
        const logs: unknown[][] = [];
        const log = (...args: unknown[]) => { logs.push(args); };
        const timedSign = providerCallback('timedSign', {
          activeConnectorRef: { current: { id: 'com.coinbase.wallet' } },
          stillCurrent: () => true, requestWalletSignature, log, KeySourceChangedError: Error,
        });
        const ensureInitPromiseRef = { current: null };
        const ensure = providerCallback('ensureInitialized', {
          effectiveAddress: '0xowner', chainId: 1, isSupportedEvmChainId: () => true,
          sessionKeyRef: { current: '' }, poolSession: null, isInitialized: false,
          ensureInitPromiseRef, deriveEpochRef: { current: 0 }, withSessionInitTimeout,
          setIsInitializing: (value: boolean) => { initializing = value; }, log, KeySourceChangedError: Error,
          deriveKeystoreManager: () => timedSign(() => new Promise<string>((resolve, reject) => {
            prompts++;
            if (prompts === 1) { resolveLate = resolve; rejectLate = reject; }
            else resolveRetry = resolve;
          }), stage),
          createSession: async (_address: string, _chain: number, signature: string) => signature,
        });
        const first = ensure();
        expect(initializing).toBe(true);
        const [err, sharedError] = await Promise.all([first.catch((e: unknown) => e), ensure().catch((e: unknown) => e)]);
        expect(isSignatureTimeout(err)).toBe(true);
        expect(err.stage).toBe(stage);
        expect(sharedError).toBe(err);
        expect(err.message).not.toContain('—');
        expect(prompts).toBe(1);
        expect(initializing).toBe(false);
        expect(ensureInitPromiseRef.current).toBeNull();
        const retry = ensure();
        if (stage === 'legacy') rejectLate(new Error('late rejection'));
        else resolveLate('0xlate');
        await new Promise((resolve) => realSetTimeout(resolve, 0));
        expect(initializing).toBe(true);
        expect(prompts).toBe(2);
        resolveRetry('0xretry');
        expect(await retry).toBe('0xretry');
        expect(initializing).toBe(false);
        const timeouts = logs.filter((entry) => entry[2] === 'Wallet signature timed out');
        expect(timeouts).toHaveLength(1);
        expect(timeouts[0][3]).toMatchObject({ stage, connectorId: 'com.coinbase.wallet' });
        expect(logs.filter((entry) => entry[2] === 'Waiting for wallet signature')).toHaveLength(2);
        expect(JSON.stringify(logs)).not.toMatch(/0xlate|0xretry/);
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('isCoinbaseWalletIdentity', () => {
  test('matches the rdns and the name', () => {
    expect(isCoinbaseWalletIdentity({ id: 'com.coinbase.wallet', name: 'x' })).toBe(true);
    expect(isCoinbaseWalletIdentity({ id: 'injected', name: 'Coinbase Wallet' })).toBe(true);
    expect(isCoinbaseWalletIdentity({ id: 'coinbaseWalletSDK' })).toBe(true);
  });

  test('does not match MetaMask, Rabby or nothing', () => {
    expect(isCoinbaseWalletIdentity({ id: 'io.metamask', name: 'MetaMask' })).toBe(false);
    expect(isCoinbaseWalletIdentity({ id: 'io.rabby', name: 'Rabby Wallet' })).toBe(false);
    expect(isCoinbaseWalletIdentity(null)).toBe(false);
  });
});

describe('scoped to Coinbase (review on #287)', () => {
  test('Coinbase gets 45s, other wallets keep the 120s session cap only', () => {
    expect(signatureTimeoutFor({ id: 'com.coinbase.wallet' })).toBe(45_000);
    expect(signatureTimeoutFor({ name: 'Coinbase Wallet' })).toBe(45_000);
    expect(signatureTimeoutFor({ id: 'io.metamask', name: 'MetaMask' })).toBeNull();
    expect(signatureTimeoutFor({ id: 'walletConnect', name: 'WalletConnect' })).toBeNull();
  });

  test('a null bound passes the wallet promise through untouched', () => {
    const p = new Promise<string>(() => {});
    expect(withSignatureTimeout(p, { stage: 'initial', timeoutMs: null })).toBe(p);
  });

  test('a throwing onTimeout still rejects with the timeout', async () => {
    const err = await withSignatureTimeout(new Promise(() => {}), {
      stage: 'initial', timeoutMs: 5, onTimeout: () => { throw new Error('log down'); },
    }).catch((e) => e);
    expect(isSignatureTimeout(err)).toBe(true);
  });

  test('Coinbase over WalletConnect is named by the session metadata', async () => {
    const wc = { getProvider: async () => ({ session: { peer: { metadata: { name: 'Coinbase Wallet' } } } }) };
    const name = await walletConnectPeerName(wc);
    expect(signatureTimeoutFor({ name })).toBe(45_000);
    expect(await walletConnectPeerName({ getProvider: async () => { throw new Error('x'); } })).toBeNull();
    expect(await walletConnectPeerName(null)).toBeNull();
  });
});

describe('throwing provider getters (cubic on 68c89ba7)', () => {
  test('fall back to an unknown wallet', async () => {
    const { resolveWalletIdentity, isCoinbaseWalletIdentity } = await import('../wallet-signature-timeout');
    const wc = await resolveWalletIdentity({ id: 'walletConnect', getProvider: async () => ({ get session(): never { throw new Error('x'); } }) });
    expect(isCoinbaseWalletIdentity(wc)).toBe(false);
    const inj = await resolveWalletIdentity({ id: 'injected', getProvider: async () => ({ get isCoinbaseWallet(): never { throw new Error('x'); } }) });
    expect(isCoinbaseWalletIdentity(inj)).toBe(false);
  });
});
