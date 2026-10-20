/**
 * Every configured address must be a viem-valid EIP-55 address.
 *
 * A hand-typed router with the WRONG mixed case (0x13a0B86B… instead of
 * 0x13a0b86b…) cost mainnet USDT deposits a second outage on 2026-09-04: cast
 * and every explorer accept it, and so does a plain regex, but viem's
 * `getAddress`/`readContract` reject a mixed-case address whose checksum does
 * not match. The vault probe's three router reads therefore threw, the probe
 * recorded 'unreachable', and yield stayed off for that share - with no error
 * anywhere near the deposit form, which just said the conversion was
 * unavailable.
 *
 * Lowercase (no checksum to check) and all-caps are legal for viem; a mixed
 * case that does not match its own hash is not. This test fails on exactly
 * that, for the shipped deployment tables.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { PROD_CHAINS, PROD_YIELD_DEPLOYMENTS } from '@/config/prod-deployments';

type Named = { label: string; address: string };

function collect(): Named[] {
  const out: Named[] = [];
  for (const chain of PROD_CHAINS) {
    for (const key of ['pool', 'keystore', 'aspRegistry', 'entrypoint', 'accessRouter', 'relay', 'relaySwaps', 'relayerSigner'] as const) {
      const value = (chain as unknown as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.startsWith('0x')) out.push({ label: `chain ${chain.chainId} ${key}`, address: value });
    }
  }
  for (const [chainId, list] of Object.entries(PROD_YIELD_DEPLOYMENTS)) {
    for (const d of list) {
      for (const key of ['ppRouter', 'zap', 'ppUSDC', 'underlying'] as const) {
        const address = d[key];
        if (typeof address === 'string') out.push({ label: `chain ${chainId} ${d.underlyingSymbol} ${key}`, address });
      }
    }
  }
  return out;
}

describe('configured addresses are viem-valid', () => {
  const all = collect();

  test('the tables are actually populated (a silent empty list would pass everything)', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  test('every address passes viem isAddress, i.e. its EIP-55 checksum is right', () => {
    const bad = all.filter((a) => !isAddress(a.address));
    expect(bad.map((a) => `${a.label}: ${a.address}`)).toEqual([]);
  });

  test('every address equals its own checksummed form (catches a lowercase typo drifting from the canonical one)', () => {
    const drifted = all
      .filter((a) => isAddress(a.address))
      .filter((a) => getAddress(a.address) !== a.address && a.address !== a.address.toLowerCase());
    expect(drifted.map((a) => `${a.label}: ${a.address} != ${getAddress(a.address)}`)).toEqual([]);
  });

  /**
   * The deployment tables were only where the bug LANDED. A token address
   * carries the same hazard: hand-case one wrong and every read against it
   * throws inside viem, so that asset simply stops working with no error near
   * the form. This sweeps every address literal in the source tree instead of
   * waiting for the next table to be added without a test.
   *
   * Only MIXED case can be wrong: an all-lowercase or all-uppercase address
   * carries no checksum and viem accepts both.
   */
  test('every mixed-case address literal in the source tree has a valid EIP-55 checksum', () => {
    const ROOTS = ['config', 'services', 'components', 'hooks', 'constants', 'app', 'scripts'];
    const SKIP = new Set(['node_modules', '__tests__', '.expo']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(path)) files.push(path);
      }
    };
    for (const root of ROOTS) {
      try {
        walk(root);
      } catch {
        // A root that does not exist in this checkout is not a failure.
      }
    }
    expect(files.length).toBeGreaterThan(100);

    const bad: string[] = [];
    let mixedCase = 0;
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
          const address = match[0];
          const body = address.slice(2);
          if (body === body.toLowerCase() || body === body.toUpperCase()) continue;
          mixedCase++;
          if (!isAddress(address)) {
            bad.push(`${file}:${index + 1} ${address} -> ${getAddress(address.toLowerCase())}`);
          }
        }
      });
    }
    // A regex that silently stopped matching would make this pass forever.
    expect(mixedCase).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });

  test('the mainnet ppUSDT router is the one deployed on chain, checksummed', () => {
    const usdt = (PROD_YIELD_DEPLOYMENTS[1] ?? []).find((d) => d.underlyingSymbol === 'USDT');
    if (!usdt) throw new Error('mainnet ppUSDT deployment missing');
    expect(isAddress(usdt.ppRouter)).toBe(true);
    expect(usdt.ppRouter.toLowerCase()).toBe('0x13a0b86bac3e0c29bd64fed7bcd2ee84f371f41c');
    expect(String(usdt.zap).toLowerCase()).toBe('0xdc3d922df81fc7b7f58229431ed91acb0482f3a5');
  });
});
