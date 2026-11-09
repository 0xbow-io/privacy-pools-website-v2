import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// useTorOperation with its effects run as React runs them: each again, after
// its previous cleanup, whenever one of its dependencies changes.
function mount() {
  const identity = {
    session: '0xAAaa000000000000000000000000000000000001' as string | null,
    wallet: '0x1111111111111111111111111111111111111111',
    sui: '0x' + 'a1'.repeat(32),
    stellar: 'G' + 'A'.repeat(55),
  };
  const scopes: { ended: boolean }[] = [];
  const effects: { deps?: unknown[]; cleanup?: () => void }[] = [];
  const refs: { current: unknown }[] = [];
  let slot = 0;
  let refSlot = 0;
  const modules: Record<string, unknown> = {
    react: {
      useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
        const state = effects[slot] ??= {};
        slot++;
        if (state.deps && deps.every((value, i) => Object.is(value, state.deps![i]))) return;
        state.cleanup?.();
        state.cleanup = effect() ?? undefined;
        state.deps = deps;
      },
      useRef<T>(initial: T) {
        return (refs[refSlot++] ??= { current: initial }) as { current: T };
      },
    },
    wagmi: { useAccount: () => ({ address: identity.wallet }) },
    '@mysten/dapp-kit': { useCurrentAccount: () => ({ address: identity.sui }) },
    '@/components/sdk-provider': { useSdkContext: () => ({ sessionAddress: identity.session }) },
    '@/components/stellar-wallet-provider': { useStellarWallet: () => ({ address: identity.stellar }) },
    '@/services/tor-fetch': { beginTorOperationScope: () => {
      const scope = { ended: false };
      scopes.push(scope);
      return () => { scope.ended = true; };
    } },
  };
  const code = ts.transpileModule(readFileSync(new URL('../../hooks/use-tor-operation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { useTorOperation?: (active: boolean) => void } = {};
  new Function('exports', 'require', code)(exports, (name: string) => modules[name]);
  const render = (active: boolean) => {
    slot = 0;
    refSlot = 0;
    exports.useTorOperation!(active);
  };
  return { identity, scopes, render };
}

describe('useTorOperation', () => {
  test('an open flow starts a new operation when the session or the wallet changes, and the earlier ones end with the flow', () => {
    const { identity, scopes, render } = mount();
    render(true);
    render(true);
    expect(scopes.map((s) => s.ended)).toEqual([false]);
    identity.session = '0xbbBB000000000000000000000000000000000002';
    render(true);
    // The earlier operation keeps a relay it already sent (a submitted swap
    // survives the switch) until the flow closes.
    expect(scopes.map((s) => s.ended)).toEqual([false, false]);
    identity.wallet = '0x2222222222222222222222222222222222222222';
    render(true);
    expect(scopes).toHaveLength(3);
    identity.session = identity.session.toUpperCase().replace('0X', '0x');
    render(true);
    expect(scopes).toHaveLength(3);
    identity.sui = '0x' + 'b2'.repeat(32);
    render(true);
    expect(scopes).toHaveLength(4);
    identity.stellar = 'G' + 'B'.repeat(55);
    render(true);
    expect(scopes).toHaveLength(5);
    render(false);
    expect(scopes.map((s) => s.ended)).toEqual([true, true, true, true, true]);
    render(true);
    expect(scopes.map((s) => s.ended)).toEqual([true, true, true, true, true, false]);
  });
});
