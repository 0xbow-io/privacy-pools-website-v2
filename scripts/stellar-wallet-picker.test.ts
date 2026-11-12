import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function compile(path: string, name: string) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  return ts.transpileModule(fn.getText(source).replace('export ', ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}
const rowJs = compile('components/stellar-wallet-option.tsx', 'StellarWalletOption');
const actionJs = compile('hooks/use-stellar-connect-action.ts', 'useStellarConnectAction');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function rowFixture({ stellar = true, connected = false, enabled = true } = {}) {
  const effects: (() => (() => void))[] = [];
  let requests = 0, cancellations = 0, completions = 0;
  let resolve!: (v: { address: string | null; error: string | null }) => void;
  const reply = new Promise<{ address: string | null; error: string | null }>((ok) => { resolve = ok; });
  const wallet = { isConnected: connected, isDevBurner: false, availabilityChecked: true, isAvailable: true, status: 'disconnected',
    cancelConnect: () => { cancellations++; },
    connectDetailed: () => { requests++; return reply; },
  };
  const context = {
    React: { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) },
    useState: (value: unknown) => [value, () => {}], useRef: (current: unknown) => ({ current }),
    useEffect: (fn: () => (() => void)) => effects.push(fn),
    useStellarWallet: () => wallet, useDebug: () => ({ isDebugEnabled: false }),
    useChainRouter: () => ({ isStellar: stellar, selectChain: async () => 'committed' }),
    useTheme: () => ({ colorScheme: 'light' }), Colors: { light: {} },
    supportedChainIds: [1], STELLAR_TESTNET_ID: 1, isChainSelectable: () => enabled,
    Platform: { OS: 'web' }, Pressable: 'Pressable', View: 'View', Text: 'Text', Image: 'Image', Ionicons: 'Icon', ChainLogo: 'Logo',
    require: () => 'local-icon',
  };
  // The callback is injected separately so an unmounted row cannot report success.
  const render = new Function(...Object.keys(context), 'done', `${rowJs}; return StellarWalletOption({className:'',onConnected:done});`);
  const output = render(...Object.values(context), () => { completions++; }) as { props: { onPress(): void } } | null;
  const cleanups = effects.map((effect) => effect());
  return { output, press: () => output!.props.onPress(), close: () => cleanups.forEach((cleanup) => cleanup()),
    resolve: (address: string | null) => resolve({ address, error: null }),
    counts: () => ({ requests, cancellations, completions }) };
}

describe('Stellar wallet row', () => {
  test('appears for Stellar selection or a connected Stellar wallet, within the chain gate', () => {
    expect(rowFixture().output).not.toBeNull();
    expect(rowFixture({ stellar: false }).output).toBeNull();
    expect(rowFixture({ stellar: false, connected: true }).output).not.toBeNull();
    expect(rowFixture({ enabled: false, connected: true }).output).toBeNull();
  });
  test('closing an idle row does not cancel a connection', () => {
    const f = rowFixture(); f.close(); expect(f.counts().cancellations).toBe(0);
  });
  test('closing before chain selection finishes never asks for wallet access', async () => {
    const f = rowFixture(); f.press(); f.close(); await flush();
    expect(f.counts()).toEqual({ requests: 0, cancellations: 1, completions: 0 });
  });
  test('closing during access cancels once and ignores a late success', async () => {
    const f = rowFixture(); f.press(); await flush(); f.close(); f.resolve('G-account'); await flush();
    expect(f.counts()).toEqual({ requests: 1, cancellations: 1, completions: 0 });
  });
  test('duplicate clicks prompt once and successful dismissal keeps the connection', async () => {
    const f = rowFixture(); f.press(); f.press(); await flush(); f.resolve('G-account'); await flush(); f.close();
    expect(f.counts()).toEqual({ requests: 1, cancellations: 0, completions: 1 });
  });
});

function actionFixture() {
  const pending = { current: null as string | null };
  let effect = () => {}, connected = false, isOpen = false, resumed = 0;
  const context = {
    useRef: () => pending, useEffect: (fn: () => void) => { effect = fn; }, useEffectEvent: (fn: () => void) => fn,
    useWalletConnectModal: () => ({ isOpen, open: async () => { isOpen = true; } }),
    useStellarWallet: () => ({ isConnected: connected }),
  };
  const run = new Function(...Object.keys(context), 'link', 'action', `${actionJs}; return useStellarConnectAction(link, action);`);
  return {
    render(link: string, connection = connected, open = isOpen) {
      connected = connection; isOpen = open;
      const launch = run(...Object.values(context), link, () => { resumed++; }) as () => Promise<void>;
      effect(); return launch;
    },
    resumed: () => resumed,
  };
}

describe('Stellar link action after connection', () => {
  test('resumes once after the picker closes successfully, not during account adoption', async () => {
    const f = actionFixture(); await f.render('link')(); f.render('link', true, true);
    expect(f.resumed()).toBe(0); f.render('link', true, false); f.render('link', true, false);
    expect(f.resumed()).toBe(1);
  });
  test('a dismissed attempt never resumes on a later connection', async () => {
    const f = actionFixture(); await f.render('link')(); f.render('link', false, true);
    f.render('link', false, false); f.render('link', true, false); expect(f.resumed()).toBe(0);
  });
  test('changing links discards the action even if the original link returns', async () => {
    const f = actionFixture(); await f.render('first')(); f.render('second', false, true);
    f.render('first', true, false); expect(f.resumed()).toBe(0);
  });
  test('a passive reconnect or a fresh mount does not resume an action', () => {
    const f = actionFixture(); f.render('link', true, false); expect(f.resumed()).toBe(0);
  });
});
