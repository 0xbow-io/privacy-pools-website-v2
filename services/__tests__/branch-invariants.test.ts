import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { conversionTargetRefusal, targetAcceptsConversion as conversionRule } from '../entrypoint-only-route';
import { privateErrorReportEvent } from '../error-reports-event';
import { applyCustomRpcMany, CUSTOM_RPC_STORAGE_KEY } from '../../config/custom-rpc';

// Registry-free stand-ins for config/intent-targets, same signatures.
const targetAcceptsConversion = (token: Parameters<typeof conversionRule>[0], chainId: number, superseded = false, bridgedEntrypointDeposit = false) =>
  conversionRule(token, { chainId, superseded, bridgedEntrypointDeposit });


function declaration(path: string, name: string) {
  const ast = ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found?.initializer) throw new Error(`Missing production declaration ${name}`);
  return { ast, value: found.initializer };
}
function evaluate(source: string, env: Record<string, unknown>) {
  return new Function(...Object.keys(env), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}

const exportKey = declaration('components/sdk-provider.tsx', 'exportAccountKey');
const exportCallback = (exportKey.value as ts.CallExpression).arguments[0].getText(exportKey.ast);
for (const change of ['none', 'passkey', 'epoch', 'wallet']) test(`account-key export cannot outlive its signature identity: ${change}`, async () => {
  const refs = { deriveEpochRef: { current: 1 }, passkeyModeRef: { current: false },
    keystoreSourceRef: { current: 'signature' }, liveIdentityRef: { current: { address: '0x123' } } };
  const run = evaluate(`return (${exportCallback});`, {
    ...refs, identityMode: 'wallet', keyIdentity: null, walletActive: true, address: '0x123',
    capturedSigsRef: { current: { address: '0x123', signature: 'signature-from-wallet' } },
    encodeAccountKey: (key: unknown) => key,
    deriveKeystoreManager: async () => {
      if (change === 'passkey') { refs.passkeyModeRef.current = true; refs.keystoreSourceRef.current = 'passkey'; }
      if (change === 'epoch') refs.deriveEpochRef.current++;
      if (change === 'wallet') refs.liveIdentityRef.current.address = '0x456';
    },
  });
  if (change === 'none') expect(await run()).toEqual({ address: '0x123', signature: 'signature-from-wallet' });
  else await expect(run()).rejects.toThrow('account changed or uses a passkey');
});

test('conversion eligibility looks up the destination token on the destination chain', () => {
  const gate = declaration('components/deposit-modal-provider.tsx', 'targetTakesConversion');
  const allowed = evaluate(`return ${gate.value.getText(gate.ast)};`, {
    isSui: false, chainId: 11155111, crossChainPoolId: 1, selectedToken: { address: 'destination-usdc' },
    targetAcceptsConversion,
    // Identity here: this test is about WHICH CHAIN the lookup uses, and the
    // wrapped-pool substitution has its own tests.
    conversionDepositTarget: (address: string) => address,
    getKnownTokenMetadata: (_address: string, chain: number) => chain === 1 ? { withdrawOnly: true } : undefined,
  });
  expect(allowed).toBe(false);
});

test('deposit token reconciliation preserves the destination asset across inline-confirm renders', () => {
  const path = 'components/deposit-modal-provider.tsx';
  const ast = ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let reconcile: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('setSelectedToken(configured)')) {
      reconcile = node.arguments[0] as ts.ArrowFunction;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!reconcile) throw new Error('Missing deposit token reconciliation effect');
  const native = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const sourceTokens = [
    { symbol: 'BNB', address: native, decimals: 18, isNative: true },
    { symbol: 'USDT', address: 'bsc-usdt', decimals: 18, isNative: false },
  ];
  const destinationTokens = [
    { symbol: 'ETH', address: native, decimals: 18, isNative: true },
    { symbol: 'USDC', address: 'mainnet-usdc', decimals: 6, isNative: false },
    { symbol: 'USDT', address: 'mainnet-usdt', decimals: 6, isNative: false },
  ];
  const run = (token: typeof sourceTokens[number], crossChainPoolId: number | null) => {
    let selected = token;
    // Inline confirm may wait for prices for several renders. Reconciliation
    // must not replace its destination address or change its amount's units.
    for (let render = 0; render < 3; render++) {
      evaluate(`return (${reconcile!.getText(ast)})();`, {
        availableTokens: sourceTokens, selectedToken: selected, crossChainPoolId,
        isSui: false, activeEvmChainId: 56, console: { log() {} },
        getDepositableTokens: (chain: number) => chain === 1 ? destinationTokens : sourceTokens,
        setSelectedToken: (next: typeof selected) => { selected = next; },
      });
    }
    return selected;
  };
  for (const token of destinationTokens) expect(run(token, 1)).toEqual(token);
  // Clearing the destination restores ordinary wallet-chain reconciliation.
  expect(run(destinationTokens[2], null)).toEqual(sourceTokens[1]);
});

test('shield quote freshness includes the pay side even when the destination pool is unchanged', () => {
  const path = 'components/home/action-hub.tsx';
  const quote = declaration(path, 'shieldQuote');
  const callback = (quote.value as ts.CallExpression).arguments[0].getText(quote.ast);
  const key = declaration(path, 'shieldQuoteKey');
  const shieldPool = { chainId: 1, address: 'mainnet-share' };
  const paySide = {
    chainId: 56, connectedAddress: 'wallet-a', payTokenAddr: 'bsc-usdt',
    amount: '10', payMeta: { decimals: 18 }, shieldPool,
  };
  const requestKey = (env: typeof paySide) => evaluate(`return ${key.value.getText(key.ast)};`, env);
  const rawShieldQuote = {
    status: 'ok', toAmount: 10_000_000n, toAmountMin: 9_700_000n,
    poolAddress: shieldPool.address, poolChainId: shieldPool.chainId,
    requestKey: requestKey(paySide),
  };
  const result = (env: typeof paySide) => evaluate(`return (${callback})();`, {
    rawShieldQuote, shieldPool, shieldQuoteKey: requestKey(env),
  });
  expect(result(paySide)).toEqual(rawShieldQuote);
  for (const changed of [
    { chainId: 1 }, { connectedAddress: 'wallet-b' }, { payTokenAddr: 'bsc-bnb' },
    { amount: '1' }, { payMeta: { decimals: 6 } },
    { shieldPool: { ...shieldPool, address: 'another-share' } },
  ]) expect(result({ ...paySide, ...changed }).status).toBe('loading');
});

test('inline shielding refuses unavailable cross-chain routes and closed conversion targets before priming', () => {
  const launch = declaration('components/deposit-modal-provider.tsx', 'startInlineDeposit');
  const callback = (launch.value as ts.CallExpression).arguments[0] as ts.ArrowFunction;
  const statements = (callback.body as ts.Block).statements;
  const end = statements.findIndex(s => ts.isVariableStatement(s)
    && s.declarationList.declarations.some(d => d.name.getText(launch.ast) === 'primedAmount'));
  const code = statements.slice(0, end).map(s => s.getText(launch.ast)).join('\n');
  for (const { routable, payEnabled, poolChainId } of [
    { routable: true, payEnabled: true, poolChainId: 1 },
    { routable: false, payEnabled: true, poolChainId: 1 },
    // Same-chain conversion under a disabled flow must not become a direct deposit.
    { routable: false, payEnabled: false, poolChainId: 11155111 },
  ]) {
    const errors: string[] = [];
    const run = evaluate(`return (options) => { ${code}; return 'primed'; };`, {
      blockMockFlow: () => false, isSui: false, isStellar: false, ensureConnected: () => true, keysReadyRef: { current: true }, chainId: 11155111,
      cancelPendingRelaunch: () => {},
      keyOwnedDeposit: false, crossChainSwapDepositSupported: () => routable,
      swapDepositEnabledForChain: () => payEnabled, availableTokens: [{ address: 'source-usdc' }],
      resolveSupportedToken: () => ({ address: 'destination-usdc', decimals: 6 }),
      targetAcceptsConversion, getKnownTokenMetadata: () => ({ withdrawOnly: true }),
      intentTargetRefusal: (_address: string, chainId: number, superseded = false, bridgedEntrypointDeposit = false) =>
        conversionTargetRefusal({ withdrawOnly: true }, { chainId, superseded, bridgedEntrypointDeposit }),
      conversionDepositTarget: (address: string) => address,
      reportDepositError: (error: string) => errors.push(error),
    });
    expect(run({ poolChainId, payTokenAddress: 'source-usdc', tokenAddress: 'destination-usdc' })).toBeUndefined();
    expect(errors).toHaveLength(1);
  }
});

test('RPC persistence changes fail visibly when the old persistent copy cannot be removed', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let reloads = 0;
  const saved = JSON.stringify({ 1: 'https://old.example/' });
  const session = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => saved, removeItem: () => { throw new Error('blocked'); } },
    sessionStorage: { getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value), removeItem: (key: string) => session.delete(key) },
    location: { reload: () => { reloads++; } },
  } });
  try {
    expect(applyCustomRpcMany({ 1: 'https://new.example/' }, 'session')).toBe(false);
    expect(session.has(CUSTOM_RPC_STORAGE_KEY)).toBe(true);
    expect(reloads).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('error report message names cannot resolve inherited object properties', () => {
  for (const message of ['constructor', 'toString', '__proto__']) {
    expect(privateErrorReportEvent({ contexts: { errorReport: { message } } })?.message).toBe('Client operation failed');
  }
});

test('an open export modal cannot display or copy the previous identity while its replacement waits or fails', async () => {
  const path = 'components/account-key-export-modal.tsx';
  const source = ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s)
    && s.name?.text === 'AccountKeyExportModal')!;
  // Execute the component's hooks and callbacks; native layout is irrelevant to key ownership.
  const code = component.body!.statements.filter(s => !ts.isReturnStatement(s)).map(s => s.getText(source)).join('\n');
  const state: unknown[] = [];
  let cursor = 0, clipboard = '', cleanup: (() => void) | undefined, effect: (() => (() => void) | undefined) | undefined;
  let deps: unknown[] = [];
  let exportAccountKey = async () => 'account-a-key';
  const render = () => {
    cursor = 0;
    return evaluate(`${code}; return { accountKey, copy, revealed, copied, error, setRevealed };`, {
      visible: true, useTheme: () => ({ colorScheme: 'light' }), Colors: { light: {} },
      usePoolSession: () => ({ exportAccountKey }), useCallback: (fn: unknown) => fn,
      useState: (initial: unknown) => {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (next: unknown) => { state[slot] = next; }];
      },
      useEffect: (run: typeof effect, next: unknown[]) => {
        if (next.some((value, i) => value !== deps[i])) { effect = run; deps = next; }
      },
      Platform: { OS: 'web' }, navigator: { clipboard: { writeText: async (key: string) => { clipboard = key; } } },
      setTimeout() {},
    });
  };
  const flushEffect = () => { if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; } };
  render(); flushEffect(); await Promise.resolve();
  let view = render();
  view.setRevealed(true); await view.copy();
  expect(clipboard).toBe('account-a-key');
  let reject!: (error: Error) => void;
  exportAccountKey = () => new Promise<string>((_resolve, fail) => { reject = fail; });
  view = render(); // Identity isolation must hold even before the effect resets state.
  expect(view.accountKey).toBeNull();
  clipboard = ''; await view.copy(); expect(clipboard).toBe('');
  flushEffect();
  view = render();
  expect(view.revealed).toBe(false); expect(view.copied).toBe(false);
  reject(new Error('replacement export failed')); await Promise.resolve(); await Promise.resolve();
  view = render();
  expect(view.error).toBe('replacement export failed');
  expect(view.accountKey).toBeNull(); await view.copy(); expect(clipboard).toBe('');
  exportAccountKey = async () => 'account-b-key';
  render(); flushEffect(); await Promise.resolve();
  view = render();
  expect(view.error).toBeNull(); expect(view.revealed).toBe(false);
  await view.copy(); expect(clipboard).toBe('account-b-key');
  cleanup?.();
});
