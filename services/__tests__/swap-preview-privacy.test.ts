import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
mock.module('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default } }));
const quotes = await import('../lifi-quote');

// Execute the hook's effect with its real quote helpers and a captured transport.
// A helper-only request count would miss a second quote added in the hook.
const source = readFileSync(new URL('../../hooks/use-swap-preview.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const processor = '0x3333333333333333333333333333333333333333';

for (const fail of [false, true]) test(`cross-chain preview sends one isolated POST and no follow-ups (${fail ? 'failure' : 'success'})`, async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  let finish!: (value: { status: string }) => void;
  const settled = new Promise<{ status: string }>(resolve => { finish = resolve; });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: !fail, json: async () => ({
      action: { fromToken: { priceUSD: '1', decimals: 6 } },
      estimate: { feeCosts: [{ included: false, amountUSD: '1' }] },
      includedSteps: [{ estimate: { toAmount: '49000000', toAmountMin: '48000000' } }, { type: 'custom' }],
    }) } as Response;
  }) as typeof fetch;
  try {
    const env = {
      ...quotes,
      CROSS_CHAIN_DENY_EXCHANGES: ['fly'],
      useEffect: (effect: () => void) => effect(),
      useRef: (current: number) => ({ current }),
      useState: () => [null, (result: { value: { status: string } }) => {
        if (result.value.status !== 'loading') finish(result.value);
      }],
      setTimeout: (callback: () => void) => { queueMicrotask(callback); return 0; },
    };
    const usePreview = new Function(...Object.keys(env), `${code}\nreturn useSwapPreview;`)(...Object.values(env));
    usePreview({ enabled: true, chainId: 1, toChainId: 10, fromToken: '0x1111', toToken: '0x2222', fromAmountWei: 50_000_000n, fromAddress: processor, destinationCall: true, slippage: 0.005 });
    expect((await settled).status).toBe(fail ? 'none' : 'ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://li.quest/v1/quote/contractCalls');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.fromAddress).toBe(processor);
    expect(body.fromAmount).toBe('50000000');
    expect(body.toFallbackAddress).toBeUndefined();
    expect(body.denyExchanges).toEqual(['fly']);
    expect(body.contractCalls).toEqual([{ fromAmount: '1', fromTokenAddress: '0x2222', toContractAddress: processor, toContractCallData: '0x', toContractGasLimit: '2000000' }]);
  } finally { globalThis.fetch = original; }
});


test('Review pauses automatic preview quotes', () => {
  const hub = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');
  const start = hub.indexOf('const swapPreview = useSwapPreview(');
  const provider = readFileSync(new URL('../../components/swap-modal-provider.tsx', import.meta.url), 'utf8');
  expect(provider).toContain('inlineIsQuoting: isQuoting');
  expect(hub.slice(start, hub.indexOf('});', start))).toContain("paused: swapStep !== 'input' || swapIsQuoting");
});

test('public feed updates do not reprice a form; edits and initially arriving data do', async () => {
  const original = globalThis.fetch;
  const calls: { body: Record<string, unknown>; signal: AbortSignal }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal });
    return { ok: true, json: async () => ({
      includedSteps: [{ estimate: { toAmount: '49000000', toAmountMin: '48000000' } }, { type: 'custom' }],
    }) } as Response;
  }) as typeof fetch;
  let state: unknown = null;
  const ref = { current: 0 };
  let deps: unknown[] = [];
  let cleanup: (() => void) | undefined;
  let timer: (() => void) | undefined;
  const env = {
    ...quotes, CROSS_CHAIN_DENY_EXCHANGES: ['fly'],
    useState: () => [state, (next: unknown) => { state = next; }],
    useRef: () => ref,
    useEffect: (effect: () => (() => void) | undefined, next: unknown[]) => {
      if (next.length === deps.length && next.every((value, i) => Object.is(value, deps[i]))) return;
      cleanup?.(); deps = next; cleanup = effect();
    },
    setTimeout: (callback: () => void) => { timer = callback; return 1; },
    clearTimeout: () => { timer = undefined; },
  };
  const render = new Function(...Object.keys(env), `${code}\nreturn useSwapPreview;`)(...Object.values(env));
  const params = { enabled: true, chainId: 1, toChainId: 10, fromToken: '0x1111', toToken: '0x2222', fromAmountWei: 49_000_000n, formKey: '50', fromAddress: processor, destinationCall: true, slippage: 0.005 };
  const flush = async () => { const run = timer; timer = undefined; run?.(); for (let i = 0; i < 10; i++) await Promise.resolve(); };
  try {
    render({ ...params, enabled: false, fromAmountWei: 0n });
    await flush(); expect(calls).toHaveLength(0);
    render(params);
    render({ ...params, fromAmountWei: 48_000_000n }); // feed refresh even during debounce
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.fromAmount).toBe('49000000');
    expect(render({ ...params, fromAmountWei: 47_000_000n }).status).toBe('ok');
    await flush(); expect(calls).toHaveLength(1);
    expect(render({ ...params, paused: true }).status).toBe('ok'); // Review retains the completed estimate
    expect(calls[0].signal.aborted).toBe(true);
    await flush(); expect(calls).toHaveLength(1);
    expect(render({ ...params, paused: true, formKey: 'different' }).status).toBe('idle');
    await flush(); expect(calls).toHaveLength(1); // never reuse another form's estimate or quote while paused
    render({ ...params, fromAmountWei: 46_000_000n }); // Back reuses completed quote
    await flush(); expect(calls).toHaveLength(1);
    render({ ...params, formKey: '51', fromAmountWei: 50_000_000n });
    await flush(); expect(calls).toHaveLength(2);
    expect(calls[1].body.fromAmount).toBe('50000000');
    render({ ...params, formKey: '51', slippage: 0.01 });
    await flush(); expect(calls).toHaveLength(3);
    render({ ...params, formKey: '52' });
    render({ ...params, formKey: '52', enabled: false }); // cancel queued work
    await flush(); expect(calls).toHaveLength(3);
  } finally { cleanup?.(); globalThis.fetch = original; }
});
