import { describe, expect, test } from 'bun:test';

import { installDebugCapture, rpcMethods, truncate } from '../debug-capture';

type Entry = { level: string; tag: string; message: string; data?: unknown };

function fakeGlobal() {
  const printed: unknown[][] = [];
  const listeners = new Map<string, (e: unknown) => void>();
  const g = {
    console: { log: (...a: unknown[]) => printed.push(a), info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    addEventListener: (t: string, h: (e: unknown) => void) => listeners.set(t, h),
    removeEventListener: (t: string) => listeners.delete(t),
    fetch: async (input: string) => (input.includes('fail') ? Promise.reject(new Error('offline')) : new Response(JSON.stringify({ fee: '12' }), { status: input.includes('bad') ? 400 : 201 })),
  };
  return { g: g as unknown as typeof globalThis, printed, listeners };
}

describe('debug capture', () => {
  test('console lines, errors and every request are logged, and uninstall restores', async () => {
    const { g, printed, listeners } = fakeGlobal();
    const entries: Entry[] = [];
    const off = installDebugCapture((level, tag, message, data) => entries.push({ level, tag, message, data }), g);

    g.console.log('[Transfer] RELAY SUBMITTED', '0xabc');
    expect(printed).toEqual([['[Transfer] RELAY SUBMITTED', '0xabc']]);
    expect(entries.at(-1)).toMatchObject({ tag: 'console', message: '[Transfer] RELAY SUBMITTED', data: '["0xabc"]' });

    listeners.get('unhandledrejection')!({ reason: new Error('quote expired') });
    expect(entries.at(-1)).toMatchObject({ level: 'error', tag: 'unhandledrejection', message: 'quote expired' });

    await g.fetch('https://relayer/quote/bad', { method: 'POST', body: '{"amount":"1"}' });
    await new Promise((r) => setTimeout(r, 5));
    const quote = entries.filter((e) => e.tag === 'net');
    expect(quote[0].message).toContain('→ #1 POST https://relayer/quote/bad');
    expect(quote[1]).toMatchObject({ level: 'warn' });
    expect(quote[1].message).toContain('← #1 400');
    expect((quote[1].data as { body: string }).body).toBe('{"fee":"12"}');

    await expect(g.fetch('https://x/fail')).rejects.toThrow('offline');
    expect(entries.at(-1)).toMatchObject({ level: 'error', tag: 'net' });

    off();
    const before = entries.length;
    g.console.log('after');
    expect(entries.length).toBe(before);
    expect(listeners.size).toBe(0);
  });

  test('a log that itself prints does not loop', () => {
    const { g } = fakeGlobal();
    let calls = 0;
    const off = installDebugCapture(() => { calls += 1; g.console.log('echo'); }, g);
    g.console.log('x');
    expect(calls).toBe(1);
    off();
  });

  test('rpc methods and truncation', () => {
    expect(rpcMethods('{"jsonrpc":"2.0","method":"eth_call"}')).toBe('eth_call');
    expect(rpcMethods('[{"method":"eth_getLogs"},{"method":"eth_blockNumber"}]')).toBe('eth_getLogs,eth_blockNumber');
    expect(rpcMethods('not json')).toBeNull();
    expect(truncate('abcdef', 3)).toBe('abc… [+3 chars]');
  });
});

describe('capture hardening', () => {
  test('a non-string first argument is kept, and a later wrapper survives uninstall', async () => {
    const { g } = (() => {
      const g = { console: { log: () => {}, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, fetch: async () => new Response('ok') } as unknown as typeof globalThis;
      return { g };
    })();
    const entries: Array<{ message: string; data?: unknown }> = [];
    const off = installDebugCapture((_l, _t, message, data) => entries.push({ message, data }), g);
    g.console.log({ a: 1 });
    expect(entries.at(-1)).toEqual({ message: '(object)', data: '[{"a":1}]' });
    const later = (async () => new Response('later')) as typeof fetch;
    g.fetch = later;
    off();
    expect(g.fetch).toBe(later);
  });
});
