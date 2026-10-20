// Unit tests for the fixture-keying determinism helpers: JSON-RPC ids are
// per-run counters and must never defeat fixture matching or leak mismatched
// ids back to viem.
import { describe, expect, test } from 'bun:test';
import { alignJsonRpcIds, decodeBody, encodeBody, fixtureKey, normalizeBody } from './fixtures';

describe('normalizeBody', () => {
  test('zeroes single JSON-RPC ids', () => {
    const a = normalizeBody(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] }));
    const b = normalizeBody(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_chainId', params: [] }));
    expect(a).toBe(b);
  });
  test('zeroes batch ids', () => {
    const mk = (ids: number[]) =>
      normalizeBody(JSON.stringify(ids.map((id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: ['0x1'] }))));
    expect(mk([1, 2])).toBe(mk([41, 42]));
  });
  test('leaves non-JSON-RPC bodies alone', () => {
    expect(normalizeBody('{"email":"a@b.c"}')).toBe('{"email":"a@b.c"}');
    expect(normalizeBody('plain text')).toBe('plain text');
    expect(normalizeBody(null)).toBe('');
  });
});

describe('fixtureKey', () => {
  test('same request different rpc id → same key', () => {
    const k1 = fixtureKey('POST', 'https://rpc.example/x', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }));
    const k2 = fixtureKey('POST', 'https://rpc.example/x', JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'eth_blockNumber' }));
    expect(k1).toBe(k2);
  });
  test('different method/url/body → different keys', () => {
    const base = fixtureKey('GET', 'https://a/x', null);
    expect(fixtureKey('POST', 'https://a/x', null)).not.toBe(base);
    expect(fixtureKey('GET', 'https://a/y', null)).not.toBe(base);
    expect(fixtureKey('GET', 'https://a/x', 'body')).not.toBe(base);
  });
});

describe('encodeBody/decodeBody', () => {
  test('large compressible bodies round-trip via gzip-base64', () => {
    const buf = Buffer.from(JSON.stringify({ rows: Array(500).fill({ a: 1, b: 'x'.repeat(50) }) }));
    const enc = encodeBody(buf);
    expect(enc.bodyEncoding).toBe('gzip-base64');
    expect(decodeBody(enc).equals(buf)).toBe(true);
  });
  test('incompressible bodies stay plain base64', () => {
    const buf = Buffer.from(Array.from({ length: 256 }, () => Math.floor(Math.random() * 256)));
    const enc = encodeBody(buf);
    expect(enc.bodyEncoding).toBeUndefined();
    expect(decodeBody(enc).equals(buf)).toBe(true);
  });
});

describe('alignJsonRpcIds', () => {
  test('rewrites stored single response id to the live request id', () => {
    const stored = JSON.stringify({ jsonrpc: '2.0', id: 3, result: '0x1' });
    const req = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'eth_blockNumber' });
    expect(JSON.parse(alignJsonRpcIds(stored, req))).toEqual({ jsonrpc: '2.0', id: 42, result: '0x1' });
  });
  test('rewrites batch ids positionally', () => {
    const stored = JSON.stringify([
      { jsonrpc: '2.0', id: 1, result: '0x1' },
      { jsonrpc: '2.0', id: 2, result: '0x2' },
    ]);
    const req = JSON.stringify([
      { jsonrpc: '2.0', id: 10, method: 'a' },
      { jsonrpc: '2.0', id: 11, method: 'b' },
    ]);
    expect(JSON.parse(alignJsonRpcIds(stored, req)).map((r: { id: number }) => r.id)).toEqual([10, 11]);
  });
  test('non-JSON-RPC payloads pass through unchanged', () => {
    expect(alignJsonRpcIds('{"prices":[]}', '{"q":1}')).toBe('{"prices":[]}');
    expect(alignJsonRpcIds('not json', null)).toBe('not json');
  });
});
