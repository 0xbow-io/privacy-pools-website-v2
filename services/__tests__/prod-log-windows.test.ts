import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A fresh account scan walks deploy..head in these windows. On Alchemy the
// address-filtered query takes millions of blocks per call; the old 10k/50k
// windows made BSC 169 calls (~70s) and Ethereum 32 (~51s).
//
// The config is read in a SUBPROCESS so the keyed build is really what is
// tested: an already-loaded ESM module cannot be re-evaluated with another
// env in this process. The key is a placeholder; nothing is called.
type Row = { chainId: number; alchemy: boolean; range: string | null };
const load = (key: string | undefined): { rows: Row[]; wide: string } => {
  const mod = fileURLToPath(new URL('../../config/prod-deployments.ts', import.meta.url));
  const script = `const m = await import(${JSON.stringify(mod)});
console.log(JSON.stringify({ wide: String(m.ALCHEMY_LOGS_MAX_BLOCK_RANGE), rows: m.ALL_PROD_CHAINS.map((d) => ({
  chainId: d.chainId, alchemy: /\\.g\\.alchemy\\.com\\//.test(d.rpcUrl), range: d.logsMaxBlockRange == null ? null : String(d.logsMaxBlockRange) })) }));`;
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (key) env.EXPO_PUBLIC_ALCHEMY_KEY = key; else delete env.EXPO_PUBLIC_ALCHEMY_KEY;
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
};

describe('prod eth_getLogs windows', () => {
  test('keyed build: every Alchemy chain gets the wide window, BSC scans in a handful of calls', () => {
    const { rows, wide } = load('placeholder');
    const bsc = rows.find((r) => r.chainId === 56)!;
    expect(bsc.alchemy).toBe(true);
    for (const r of rows) if (r.alchemy) expect(r.range).toBe(wide);
    const blocks = 8_403_326n; // deploy..head on 2026-10-15
    expect((blocks + BigInt(wide) - 1n) / BigInt(wide)).toBeLessThanOrEqual(5n);
  });

  test('keyless build: public endpoints keep their tested caps', () => {
    const { rows } = load(undefined);
    for (const r of rows) {
      expect(r.alchemy).toBe(false);
      expect(BigInt(r.range ?? '10000')).toBeLessThanOrEqual(50_000n);
    }
  });
});
