import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ENVIRONMENTS } from '@/config/environments';
import { preferredHubToken, selectHubTokens, type HubHoldings } from '@/services/hub-token-catalog-rule';
import { isSupersededPlainPool } from '@/services/pool-slug';
import { sanitizeAmountInput } from '@/services/token-amount';

// DEV-469: on BNB Chain the hub's pool pill read BNB while the Send flow spent
// ppUSDT. Runs the real hub push, the real provider setter and the real
// provider snap effect with the React boundaries stubbed.
const parse = (path: string) => ts.createSourceFile(path, readFileSync(new URL(`../../components/${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hubSrc = parse('home/action-hub.tsx');
const providerSrc = parse('transfer-modal-provider.tsx');

function findCall(source: ts.SourceFile, callee: string, marker: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (!found && ts.isCallExpression(node) && node.expression.getText(source) === callee
      && node.arguments[0]?.getText(source).includes(marker)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`${callee} containing ${marker} not found`);
  return found;
}
const compile = (source: ts.SourceFile, fn: ts.Expression) => ts.transpileModule(`return (${fn.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
function bind<A extends unknown[]>(code: string, env: Record<string, unknown>): (...args: A) => void {
  return new Function(...Object.keys(env), code)(...Object.values(env));
}

const hubEffect = findCall(hubSrc, 'useEffect', 'syncTransferToken(');
const hubCode = compile(hubSrc, hubEffect.arguments[0]);
const setterCall = findCall(providerSrc, 'useCallback', 'sourceTokens.find((t) => t.symbol === symbol)');
const setterCode = compile(providerSrc, setterCall.arguments[0]);
const snapCode = compile(providerSrc, findCall(providerSrc, 'useEffect', 'selectedToken !== defaultSourceSymbol').arguments[0]);

// The prod BNB Chain registry through the same Send rule the hub and provider use.
const bsc = Object.values(ENVIRONMENTS.prod.tokensByChain[56]);
const ctx = {
  shareSymbols: bsc.filter((t) => t.yieldShare).map((t) => t.symbol.toUpperCase()),
  openPlainSymbols: bsc.filter((t) => !t.yieldShare && !t.withdrawOnly).map((t) => t.symbol.toUpperCase()),
  legacyPlainSymbols: bsc.filter((t) => !t.yieldShare && t.withdrawOnly).map((t) => t.symbol.toUpperCase()),
};
const actionable = bsc.map((t) => ({ ...t, superseded: isSupersededPlainPool(t.symbol, ctx) }));
const sendCatalog = (holdings: HubHoldings) => selectHubTokens('send', { actionable, depositable: actionable, entrypointDepositable: actionable }, holdings);
// The QA account: ppUSDT and BNB shielded on 56.
const holdings: HubHoldings = { symbols: new Set(['BNB', 'PPUSDT']), ready: true };

type HubEnv = { isFocused: boolean; action: string; transferInline: boolean; transferStep: string; isSui: boolean; symbol: string; transferToken: string };
const OPEN: HubEnv = { isFocused: true, action: 'send', transferInline: true, transferStep: 'select-notes', isSui: false, symbol: 'BNB', transferToken: 'ppUSDT' };
function runHub(over: Partial<HubEnv> = {}) {
  const e = { ...OPEN, ...over };
  const pushed: string[] = [];
  bind(hubCode, {
    isFocused: e.isFocused, action: e.action, transferInline: e.transferInline, transferStep: e.transferStep, isSui: e.isSui,
    tokenMeta: { symbol: e.symbol }, transferToken: e.transferToken, syncTransferToken: (s: string) => pushed.push(s),
  })();
  return pushed;
}

describe('hub pushes its pool pill into the open Send form', () => {
  test('a pill that differs from the spent asset is pushed', () => {
    expect(runHub()).toEqual(['BNB']);
  });

  test('nothing is pushed once they agree', () => {
    expect(runHub({ transferToken: 'BNB' })).toEqual([]);
  });

  test('only the form step follows the pill; review and later are frozen', () => {
    for (const step of ['unregistered-confirm', 'review', 'loading', 'success']) {
      expect(runHub({ transferStep: step })).toEqual([]);
    }
  });

  test('an overlay Send, Sui, another tab or a retained hub never push', () => {
    expect(runHub({ transferInline: false })).toEqual([]);
    expect(runHub({ isSui: true })).toEqual([]);
    expect(runHub({ action: 'withdraw' })).toEqual([]);
    expect(runHub({ isFocused: false })).toEqual([]);
  });

  test('re-runs when the provider token moves, so a later snap is pushed over', () => {
    const deps = hubEffect.arguments[1]?.getText(hubSrc) ?? '';
    expect(deps).toContain('transferToken');
    expect(deps).toContain('tokenMeta.symbol');
  });
});

function runSetter(symbol: string, { isSui = false, amount = '0.1234567', tokens = sendCatalog(holdings) } = {}) {
  const state = { token: 'ppUSDT', amount };
  bind<[string]>(setterCode, {
    isSui, sourceTokens: tokens, sanitizeAmountInput,
    setSelectedToken: (s: string) => { state.token = s; },
    setAmount: (f: (a: string) => string) => { state.amount = f(state.amount); },
  })(symbol);
  return state;
}

describe('provider setter', () => {
  test('switches the spent asset and keeps the typed amount', () => {
    // Only the token and the amount's precision are touched: any other setter
    // (recipient, receive-as, toggles) would be a ReferenceError here.
    expect(runSetter('BNB')).toEqual({ token: 'BNB', amount: '0.1234567' });
  });

  test('re-clamps the amount to the new asset precision', () => {
    const usdc = { symbol: 'ppUSDC', decimals: 6 };
    expect(runSetter('ppUSDC', { tokens: [usdc] as never })).toEqual({ token: 'ppUSDC', amount: '0.123456' });
  });

  test('ignores a symbol this chain does not offer for Send, and Sui', () => {
    expect(runSetter('ppUSDC')).toEqual({ token: 'ppUSDT', amount: '0.1234567' });
    expect(runSetter('USDT')).toEqual({ token: 'ppUSDT', amount: '0.1234567' });
    expect(runSetter('BNB', { isSui: true })).toEqual({ token: 'ppUSDT', amount: '0.1234567' });
  });
});

// One commit = the hub's effect (child) then the provider's snap effect
// (parent), both reading that render's values; batched writes, last wins.
function simulate({ hubSymbol, providerToken, hold = holdings, withHubSync = true }: { hubSymbol: string; providerToken: string; hold?: HubHoldings; withHubSync?: boolean }) {
  let selected = providerToken;
  const tokens = sendCatalog(hold);
  const defaultSourceSymbol = preferredHubToken(tokens, hold)?.symbol ?? actionable.find((t) => !t.superseded)?.symbol;
  for (let commit = 0; commit < 10; commit++) {
    const writes: string[] = [];
    const setSelectedToken = (s: string) => writes.push(s);
    if (withHubSync) {
      runHubPush(hubSymbol, selected, (s) => bind<[string]>(setterCode, {
        isSui: false, sourceTokens: tokens, sanitizeAmountInput, setSelectedToken, setAmount: () => {},
      })(s));
    }
    bind(snapCode, { isSui: false, sourceTokens: tokens, selectedToken: selected, sourceHoldings: hold, defaultSourceSymbol, setSelectedToken })();
    const next = writes.at(-1) ?? selected;
    if (next === selected) return { selected, commits: commit };
    selected = next;
  }
  throw new Error('no fixed point: hub and provider hand the token back and forth');
}
function runHubPush(symbol: string, transferToken: string, push: (s: string) => void) {
  bind(hubCode, {
    isFocused: true, action: 'send', transferInline: true, transferStep: 'select-notes', isSui: false,
    tokenMeta: { symbol }, transferToken, syncTransferToken: push,
  })();
}

describe('chain switch with Send already open (the QA repro)', () => {
  // The hub's resting Send token on 56 is the native coin; the provider's own
  // default for this account is the yield share. That disagreement is the bug.
  const hubResting = actionable.find((t) => !t.superseded)!.symbol;
  test('fixture matches the issue: pill BNB, provider default ppUSDT', () => {
    expect(hubResting).toBe('BNB');
    expect(preferredHubToken(sendCatalog(holdings), holdings)?.symbol).toBe('ppUSDT');
  });

  test('before the fix the flow stays on ppUSDT under a BNB pill', () => {
    expect(simulate({ hubSymbol: 'BNB', providerToken: 'ppUSDC', withHubSync: false }).selected).toBe('ppUSDT');
  });

  test('the push survives the snap that lands after it and settles on the pill', () => {
    // Opened on chain 1 with ppUSDC; the snap on 56 writes ppUSDT after the
    // hub's push in the same commit, and the next commit pushes BNB again.
    expect(simulate({ hubSymbol: 'BNB', providerToken: 'ppUSDC' })).toEqual({ selected: 'BNB', commits: 2 });
  });

  test('an explicit ppUSDT pick is followed too', () => {
    expect(simulate({ hubSymbol: 'ppUSDT', providerToken: 'BNB' }).selected).toBe('ppUSDT');
  });

  test('a pill the provider cannot spend reaches a fixed point instead of looping', () => {
    // FDUSD is not held, so it is not a Send option: the setter refuses it.
    expect(simulate({ hubSymbol: 'FDUSD', providerToken: 'ppUSDT' }).selected).toBe('ppUSDT');
    const nothingHeld: HubHoldings = { symbols: new Set(), ready: true };
    expect(simulate({ hubSymbol: 'FDUSD', providerToken: 'BNB', hold: nothingHeld }).selected).toBe('BNB');
  });
});
