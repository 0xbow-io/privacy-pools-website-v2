import { describe, expect, test } from 'bun:test';
import { artifactsVercelConfig, blobShas, KEEP_VERSIONS, mergeManifests, rewritesFor } from '../../scripts/artifacts-manifest.mjs';

const v1 = { 'deposit/groth16_pkey.zkey': 'aaa', 'ragequit/groth16_pkey.zkey': 'bbb' };
// A circuit change: one file changed, the other is the same content.
const v2 = { 'deposit/groth16_pkey.zkey': 'ccc', 'ragequit/groth16_pkey.zkey': 'bbb' };

describe('artifact manifests', () => {
  test('a new version is added and the older ones stay served', () => {
    const merged = mergeManifests({ one: v1 }, 'two', v2);
    expect(Object.keys(merged)).toEqual(['one', 'two']);
    expect(merged.one).toEqual(v1);
  });

  test('republishing the same version moves it last without duplicating it', () => {
    const merged = mergeManifests({ one: v1, two: v2 }, 'one', v1);
    expect(Object.keys(merged)).toEqual(['two', 'one']);
  });

  test('only the newest versions are kept, the oldest fall off', () => {
    let manifests: Record<string, Record<string, string>> = {};
    for (let i = 0; i < KEEP_VERSIONS + 3; i += 1) manifests = mergeManifests(manifests, `v${i}`, { f: `sha${i}` });
    expect(Object.keys(manifests)).toHaveLength(KEEP_VERSIONS);
    expect(Object.keys(manifests)[0]).toBe('v3');
    expect(Object.keys(manifests).at(-1)).toBe(`v${KEEP_VERSIONS + 2}`);
  });

  test('a file shared by two versions is stored once', () => {
    const shas = blobShas({ one: v1, two: v2 });
    expect([...shas].sort()).toEqual(['aaa', 'bbb', 'ccc']);
  });

  test('every versioned path is a rewrite onto its blob', () => {
    const rules = rewritesFor({ one: v1, two: v2 });
    expect(rules).toHaveLength(4);
    expect(rules).toContainEqual({ source: '/artifacts/one/deposit/groth16_pkey.zkey', destination: '/blobs/aaa' });
    expect(rules).toContainEqual({ source: '/artifacts/two/deposit/groth16_pkey.zkey', destination: '/blobs/ccc' });
    // The unchanged circuit points both versions at the same blob.
    expect(rules.filter((rule) => rule.destination === '/blobs/bbb')).toHaveLength(2);
  });

  test('versioned files are immutable and the list of versions is never cached', () => {
    const config = artifactsVercelConfig({ one: v1 });
    const cache = (source: string) => config.headers.find((rule: { source: string }) => rule.source === source)!.headers
      .find((header: { key: string }) => header.key === 'Cache-Control')!.value;
    expect(cache('/artifacts/:version([0-9a-f]{12})/:path*')).toContain('immutable');
    expect(cache('/blobs/:sha')).toContain('immutable');
    expect(cache('/artifacts/manifests.json')).toContain('max-age=0');
  });
});
