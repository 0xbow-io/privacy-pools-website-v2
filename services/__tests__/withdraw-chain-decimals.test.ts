/**
 * Withdraw reads a pool asset's decimals per CHAIN, never by symbol alone.
 *
 * One symbol is not one scale: USDT is 6 decimals on mainnet and 18 on BNB
 * Chain, where the legacy USDT pool stays open for withdrawals. Withdraw took
 * decimals from a symbol-keyed map that said USDT is 6, so on BNB Chain the
 * balance read in the trillions and a typed "5" was parsed as about 5e-12 USDT.
 * Found while fixing the same lookup in the error units (review on #122).
 *
 * Source-level because the resolver lives in the component, which bun cannot
 * import; the environment half below is real data.
 */
import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ENVIRONMENTS } from '@/config/environments';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const source = readFileSync(join(ROOT, 'components/withdraw-modal-provider.tsx'), 'utf8');

describe('withdraw decimals are chain-aware', () => {
  test('the symbol-keyed map is only read inside the chain-aware resolver', () => {
    const reads = [...source.matchAll(/TOKEN_DECIMALS\[[^\]]+\]/g)].map((m) => m.index!);
    const resolver = source.indexOf('function withdrawTokenDecimals(');
    const resolverEnd = source.indexOf('\n}', resolver);
    expect(resolver).toBeGreaterThan(-1);
    // Every bracket read of the map sits inside the resolver (the one-line
    // comment in a docstring is excluded by requiring a real read).
    const outside = reads.filter((i) => i < resolver || i > resolverEnd)
      .filter((i) => !source.slice(Math.max(0, source.lastIndexOf('\n', i)), i).includes('*'));
    expect(outside).toEqual([]);
  });

  test('the typed amount is parsed through the resolver on both withdraw paths', () => {
    const parses = [...source.matchAll(/const tokenDecimals = (.+);\n\s+(?:const|let) amountWei = parseTokenAmount\(amount, tokenDecimals\)/g)];
    expect(parses.length).toBe(2);
    for (const p of parses) expect(p[1]).toBe('withdrawTokenDecimals(selectedToken, chainId, isSui)');
  });

  test('the resolver asks the per-chain registry before the map', () => {
    const body = source.slice(source.indexOf('function withdrawTokenDecimals('), source.indexOf('\n}', source.indexOf('function withdrawTokenDecimals(')));
    expect(body).toContain('getTokenMetadataBySymbol(symbol, chainId)?.decimals');
    expect(body.indexOf('getTokenMetadataBySymbol')).toBeLessThan(body.indexOf('TOKEN_DECIMALS[symbol]'));
  });

  test('the premise holds in the real prod config: one symbol, two scales', () => {
    const prod = ENVIRONMENTS.prod.tokensByChain;
    const usdt = (chain: number) => Object.values(prod[chain] ?? {}).find((t) => t.symbol === 'USDT')?.decimals;
    expect(usdt(1)).toBe(6);
    expect(usdt(56)).toBe(18);
  });
});
