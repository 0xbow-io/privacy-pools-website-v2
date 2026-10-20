import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { topUpCovers, viewingKeyCostWei, viewingKeyShortfallWei } from '../receive-setup';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// Same filter as swap-mode-default.test.ts: a comment or JSDoc line mentioning
// a guarded call must not trip a "code no longer does this" canary — only the
// executable line should.
const stripComments = (src: string) => src.split('\n').filter((l) => {
  const t = l.trim();
  return !t.startsWith('*') && !t.startsWith('//');
}).join('\n');

describe('the gas top-up must cover what finishing setup costs (review of #130)', () => {
  const gasPriceWei = 10_000_000_000n; // 10 gwei
  const cost = viewingKeyCostWei({ gasPriceWei });

  test('shortfall is the cost less what the wallet already holds, never negative', () => {
    expect(viewingKeyShortfallWei({ gasPriceWei, balanceWei: 0n })).toBe(cost);
    expect(viewingKeyShortfallWei({ gasPriceWei, balanceWei: cost / 2n })).toBe(cost - cost / 2n);
    expect(viewingKeyShortfallWei({ gasPriceWei, balanceWei: cost * 2n })).toBe(0n);
  });

  test('a missing, zero or short top-up does not cover it', () => {
    expect(topUpCovers(null, cost)).toBe(false);
    expect(topUpCovers(0n, cost)).toBe(false);
    expect(topUpCovers(cost - 1n, cost)).toBe(false);
    expect(topUpCovers(cost, cost)).toBe(true);
  });

  test('pricing refuses a short top-up for finish setup and falls back without it for a registration', () => {
    const src = read('hooks/use-gasless-registration.ts');
    expect(src).toContain('!topUpCovers(priced.gasTopUpWei, topUpShortfallWei)');
    expect(src).toContain("priced = await priceCandidate(candidate, owner, false);");
    expect(src).toContain('extraGas: planExtraGas,');
  });
});

describe('no per-recipient viewing-key read on the pool RPC when the ASP registry answered (review of #130)', () => {
  // The full re-pull moved onto the fixed background feed grid
  // (services/public-feeds.ts) so a recipient's cache-miss timing no longer
  // announces itself — lookupViewingKey only ever reads what is already
  // local, and a failed pull is propagated rather than treated as a miss.
  test('the full registry re-pull is scheduled, throttled, and its failure is not silently treated as a cache miss', () => {
    const src = read('services/viewing-key-cache.ts');
    expect(src).toContain('const sinceId = fromStart ? \'0\' : registry.lastSyncedId;');
    expect(src).toContain('export async function refreshViewingKeyRegistry(chainId: number, keystoreAddress?: string)');
    expect(src).toContain('FULL_RESYNC_INTERVAL_MS = 5 * 60_000');
    expect(src).toContain('fullResyncFailed.set(scope, true);');
    expect(src).not.toContain('shouldFullResync(chainId, keystoreAddress)');

    const feeds = read('services/public-feeds.ts');
    expect(feeds).toContain('refreshViewingKeyRegistry(chainId, chainKeystoreAddress)');
  });

  test('Send and the deposit recipient check trust the registry and do not confirm a miss on the RPC', () => {
    const transfer = stripComments(read('components/transfer-modal-provider.tsx'));
    expect(transfer).not.toContain('await ks.getViewingKey(checkedRecipient');
    const deposit = read('components/deposit-modal-provider.tsx');
    const fnStart = deposit.indexOf('export async function checkRecipientRegistration');
    const fn = stripComments(deposit.slice(fnStart, fnStart + 2500));
    expect(fn).toContain("if (result.source === 'cache' && result.aspAvailable) return 'unregistered';");
    expect(fn).not.toContain('await ks.getViewingKey(recipient)');
  });
});

describe('a landed registration with the viewing-key step deferred resumes the caller (review of #130)', () => {
  test('closing during the publish step delivers success, not cancel', () => {
    const src = stripComments(read('components/keystore-registration-modal-provider.tsx'));
    expect(src).toContain('registeredAwaitingPublishRef.current = true;');
    // A single canonical line rather than the exact multi-line block: the
    // block's indentation/formatting can change on any reformat, but this
    // one line is the load-bearing part — resuming on 'registered' rather
    // than falling through to the cancel callback.
    expect(src).toContain('if (registered) {');
    expect(src).toContain('success?.();');
  });
});
