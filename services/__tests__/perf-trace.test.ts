import { describe, expect, test } from 'bun:test';
import { __testables } from '../perf-trace';

const { aggregate, rpcMethodOf, normalizePath } = __testables;

describe('rpcMethodOf', () => {
  test('names a single JSON-RPC call by its method', () => {
    expect(rpcMethodOf('{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[]}')).toBe('eth_getLogs');
  });

  test('names a BATCH by size and members, so 50 calls are not read as one', () => {
    const body = JSON.stringify([
      { method: 'eth_call' }, { method: 'eth_call' }, { method: 'eth_getBlockByNumber' },
    ]);
    expect(rpcMethodOf(body)).toBe('batch[3]:eth_call,eth_getBlockByNumber');
  });

  test('returns null for non-JSON-RPC bodies', () => {
    expect(rpcMethodOf(undefined)).toBeNull();
    expect(rpcMethodOf('')).toBeNull();
    expect(rpcMethodOf('not json')).toBeNull();
    expect(rpcMethodOf('{"no":"method"}')).toBeNull();
  });
});

describe('normalizePath', () => {
  test('collapses hashes so per-item requests aggregate into one row', () => {
    expect(normalizePath('/labels/0xabc123def456789/status')).toBe('/labels/0x…/status');
  });

  test('collapses long numeric ids', () => {
    expect(normalizePath('/association-set/123456/leaves')).toBe('/association-set/…/leaves');
  });

  test('leaves ordinary paths alone', () => {
    expect(normalizePath('/global/public/events')).toBe('/global/public/events');
  });
});

describe('aggregate', () => {
  test('groups repeats so an N+1 reads as a single high count', () => {
    const s = (key: string, ms: number, ok = true) => ({ key, host: 'h', method: key, ms, bytes: 100, ok });
    const out = aggregate([s('rpc eth_call', 10), s('rpc eth_call', 30), s('asp /events', 500)]);
    expect(out[0].key).toBe('rpc eth_call');
    expect(out[0].count).toBe(2);
    expect(out[0].totalMs).toBe(40);
    expect(out[0].maxMs).toBe(30);
    expect(out[1].count).toBe(1);
  });

  test('counts failures separately', () => {
    const out = aggregate([
      { key: 'k', host: 'h', method: 'k', ms: 1, bytes: 0, ok: false },
      { key: 'k', host: 'h', method: 'k', ms: 1, bytes: 0, ok: true },
    ]);
    expect(out[0].failures).toBe(1);
    expect(out[0].count).toBe(2);
  });
});
