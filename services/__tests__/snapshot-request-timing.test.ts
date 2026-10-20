import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// When this client asks the ASP for pool data is visible to the ASP whatever
// the request carries. These pin the pool data a spend or a discovery pass
// reads (the event snapshot, the state and keystore leaves, the association
// set, the Note events, the ASP key) to requests no user action can time: the
// feed grid refreshes them and everything else reads the copy. And they pin
// the user's own operations to local bookkeeping: nothing a deposit, transfer,
// withdrawal or claim does at confirmation, or before its proof, starts a
// discovery pass. See services/snapshot-source.ts,
// services/public-feed-scheduler.ts and docs/privacy-request-discipline.md.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SCANNED = ['components', 'app', 'hooks', 'services'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Calls, not mentions: the comments explaining these rules name the functions. */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const sources = SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
  .map((file) => ({ file: file.slice(ROOT.length + 1), code: withoutComments(readFileSync(file, 'utf8')) }));
const read = (file: string) => withoutComments(readFileSync(join(ROOT, file), 'utf8'));
const callers = (pattern: RegExp) => sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file).sort();
/** A function's body: from the brace that ends its signature line to the matching one. */
function body(code: string, start: number): string {
  expect(start).toBeGreaterThan(-1);
  const open = code.indexOf('{\n', start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error('unbalanced source');
}

describe('the event snapshot is refreshed by the feed grid and nothing else', () => {
  test('only the grid calls refreshPoolEventSnapshot', () => {
    const calls = (code: string) => code.match(/\brefreshPoolEventSnapshot\s*\(/g)?.length ?? 0;
    const offenders = sources
      .filter(({ file, code }) => calls(code) > 0
        && file !== 'services/snapshot-source.ts' && file !== 'services/public-feeds.ts')
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // The declaration, and nothing in its own module calls it.
    const source = read('services/snapshot-source.ts');
    expect(calls(source)).toBe(1);
    expect(source).toMatch(/export async function refreshPoolEventSnapshot\s*\(/);
    // One call in the feed list, and it is the snapshot feed's scheduled fetch.
    const feeds = read('services/public-feeds.ts');
    expect(calls(feeds)).toBe(1);
    expect(feeds).toMatch(/key:\s*feedEventSnapshot\(chainId\),\s*intervalMs:\s*EVENT_SNAPSHOT_INTERVAL_MS,\s*fetch:\s*async\s*\(\)\s*=>\s*\(await refreshPoolEventSnapshot\(chainId\)\)/);
  });

  test('the grid registers the snapshot for every supported EVM chain, whatever the user opens', () => {
    const feeds = read('services/public-feeds.ts');
    const loop = feeds.indexOf('for (const chainId of supportedEvmChainIds)');
    const registration = feeds.indexOf('key: feedEventSnapshot(chainId)');
    expect(loop).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(loop);
  });

  test('no reader can demand a fresher copy, and nothing expires the held one', () => {
    const offenders = sources
      .filter(({ code }) => /loadPoolEventSnapshot\([^)]*maxAgeMs/.test(code) || /\bexpirePoolEventSnapshot\b/.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("a confirmed transaction re-reads the held snapshot and never fetches one", () => {
    const cache = read('services/cache.ts');
    expect(cache).not.toContain('snapshot-source');
  });

  test('the payload endpoint is reached only through the shared source', () => {
    expect(callers(/\.getEventSnapshotPayload\s*\(/)).toEqual(['services/snapshot-source.ts']);
  });
});

describe('the leaves a spend proof is built against are a grid feed', () => {
  test('only the grid calls refreshPoolLeaves', () => {
    const calls = (code: string) => code.match(/\brefreshPoolLeaves\s*\(/g)?.length ?? 0;
    expect(callers(/\brefreshPoolLeaves\s*\(/)).toEqual(['services/public-feeds.ts', 'services/snapshot-source.ts']);
    // The declaration, and nothing in its own module calls it.
    const source = read('services/snapshot-source.ts');
    expect(calls(source)).toBe(1);
    expect(source).toMatch(/export async function refreshPoolLeaves\s*\(/);
    // One call in the feed list, and it is the leaves feed's scheduled fetch.
    const feeds = read('services/public-feeds.ts');
    expect(calls(feeds)).toBe(1);
    expect(feeds).toMatch(/key:\s*feedPoolLeaves\(chainId\),\s*intervalMs:\s*POOL_LEAVES_INTERVAL_MS,\s*fetch:\s*async\s*\(\)\s*=>\s*\(await refreshPoolLeaves\(chainId\)\)/);
  });

  test('the grid registers the leaves for every supported EVM chain', () => {
    const feeds = read('services/public-feeds.ts');
    const loop = feeds.indexOf('for (const chainId of supportedEvmChainIds)');
    expect(loop).toBeGreaterThan(-1);
    expect(feeds.indexOf('key: feedPoolLeaves(chainId)')).toBeGreaterThan(loop);
  });

  test("the SDK's leaf fast path reads the held copy and never fetches", () => {
    const setup = read('services/sdk-setup.ts');
    const fastPath = body(setup, setup.indexOf('private async fetchFromASP('));
    expect(fastPath).toContain('await loadPoolLeaves(this.chainId, { entrypoint })');
    expect(fastPath).not.toMatch(/apiClient|getEventSnapshotPayload|fetch\(/);
  });
});

describe('the association set a spend proof is checked against is a grid feed', () => {
  test('only the grid refreshes it, and nothing else asks the ASP for its root', () => {
    expect(callers(/\brefreshPoolAssociationSet\s*\(/)).toEqual(['services/public-asp-cache.ts', 'services/public-feeds.ts']);
    expect(callers(/approvedLabelCache\.refresh\s*\(/)).toEqual(['services/public-asp-cache.ts']);
    expect(callers(/\.getAssociationSetRoot\s*\(/)).toEqual(['services/public-asp-cache.ts']);
  });

  test('the SDK root getter also reads the grid-owned cache', () => {
    const setup = read('services/sdk-setup.ts');
    const getter = body(setup, setup.indexOf('async getRoot()'));
    expect(getter).toContain('await approvedLabelCache.root(baseProvider, chainId, poolKey)');
  });

  test('only the static grid can initiate a backoff probe', () => {
    expect(callers(/\bprobeAsp\s*\(/)).toEqual(['services/egress-fetch.ts', 'services/public-feeds.ts']);
    const feeds = read('services/public-feeds.ts');
    expect(feeds).toContain('intervalMs: ASP_BACKOFF_PROBE_MS');
    expect(feeds).toContain('fetch: () => probeAsp(ASP_URL)');
  });

  test('every read of a chain the grid refreshes is answered from the copy', () => {
    const cache = read('services/public-asp-cache.ts');
    expect(cache).toMatch(/owns: \(chainId: number\) => publicFeeds\.registered\(\)\.includes\(feedAssociationSet\(chainId\)\)/);
    const feeds = read('services/public-feeds.ts');
    expect(feeds.indexOf('key: feedAssociationSet(chainId)')).toBeGreaterThan(feeds.indexOf('for (const chainId of supportedEvmChainIds)'));
  });
});

describe("discovery's ASP reads are all of data the grid holds", () => {
  test('its Note events come from the held snapshot, never /note-events', () => {
    const setup = read('services/sdk-setup.ts');
    const wrapper = body(setup, setup.indexOf('getNoteEvents: async (fromBlock?: Hex, toBlock?: Hex)'));
    expect(wrapper).toContain('await loadPoolEventSnapshot(chainId, { entrypoint: entrypointAddress })');
    expect(wrapper).not.toContain('baseProvider');
    // Nothing else asks for Note events either. The Sui reader is the Sui
    // chain's own RPC, not the ASP.
    expect(callers(/\.getNoteEvents\??\.?\s*\(/)).toEqual(['hooks/use-sui-notes.ts']);
  });

  test("the deposit ciphertext's key is read from the grid", () => {
    const setup = read('services/sdk-setup.ts');
    const getter = body(setup, setup.indexOf('async getASPPublicKey() {'));
    expect(getter).toContain('await heldAspPublicKey()');
    expect(getter).not.toContain('baseProvider');
    expect(read('services/public-feeds.ts')).toContain('key: FEED_ASP_PUBLIC_KEY');
  });
});

describe("our own operations never start a discovery pass", () => {
  // Where discovery may run, and why. Everything else applies what it already
  // knows locally (a deposit's note, a spend's inputs and change) and leaves
  // the rest to the pass the grid starts (components/sdk-provider.tsx).
  const ALLOWED: Record<string, string> = {
    'components/sdk-provider.tsx': 'owns the session: the sign-in pass, the grid pass, and import reconciliation',
    'hooks/use-sync-everything.ts': 'the sync button, pressed by the user, never run after a transaction',
    'app/pay/[encoded].tsx': "the pay page's recover button, pressed by the user",
    'services/stellar/stellar-account.ts': "the Stellar session's own discovery, not the EVM ASP",
  };
  // A pasted claim, receipt or backup is imported into the live session.
  const IMPORTS: Record<string, string> = {
    'components/account-recovery-modal-provider.tsx': 'restoring a backup the user pasted',
    'components/payment-request-modal-provider.tsx': 'importing a payment receipt the user pasted',
    'hooks/use-note-import.ts': 'importing a note link the user opened',
  };

  test('discovery runs only where the user asked for it or the grid scheduled it', () => {
    const found = callers(/\b(?:syncFromSnapshot|syncAllChains)\s*\(|\.discoverNotes\s*\(/);
    expect(found).toEqual(Object.keys(ALLOWED).sort());
  });

  test('a re-import (which runs a full discovery pass) happens only for something the user pasted', () => {
    expect(callers(/(?<![.\w])importAccount\s*\(/)).toEqual(Object.keys(IMPORTS).sort());
    const payment = read('components/payment-request-modal-provider.tsx');
    expect(payment.match(/(?<![.\w])importAccount\s*\(/g)).toHaveLength(1);
  });

  test("the grid schedules discovery off each chain's snapshot refresh", () => {
    const provider = read('components/sdk-provider.tsx');
    const start = provider.lastIndexOf('const chains = supportedChainIds', provider.indexOf('const onFeed = (cid: number) =>'));
    const effect = provider.slice(start, provider.indexOf('}, [poolSession', start));
    // Every chain the sweep covers, each on its own grid feed, quiet.
    expect(effect).toContain('publicFeeds.subscribe(feedEventSnapshot(cid), () => onFeed(cid))');
    expect(effect).toContain('syncFromSnapshot({ ...opts, quiet: true })');
    expect(effect).toContain('if (!current() || !feedHasData(state)) return;');
    // ...over every supported, queryable EVM chain, not just the active one.
    expect(effect).toMatch(/const chains = supportedChainIds\.filter\(\s*\(cid\) => isSupportedEvmChainId\(cid\) && queryableEvmChainIds\(\)\.includes\(cid\),?\s*\);/);
    expect(effect).toContain('const unsubscribes = chains.map((cid) => publicFeeds.subscribe(feedEventSnapshot(cid), () => onFeed(cid)));');
    expect(effect).not.toMatch(/chains\s*=\s*\[chainId\]/);
  });

  test("a sweep records what it scanned, so the grid pass after it skips unchanged chains", () => {
    const provider = read('components/sdk-provider.tsx');
    const sibling = provider.slice(provider.indexOf('const discoverSiblingChain = useCallback'), provider.indexOf('const syncAllChains'));
    expect(sibling).toContain('const scan = await heldScanFingerprint(cid);');
    expect(sibling).toMatch(/markSnapshotScanned\(started\.managers, cid, scan,/);
    const sweep = provider.slice(provider.indexOf('const syncAllChains'), provider.indexOf('const onFeed = (cid: number) =>'));
    expect(sweep).toMatch(/markSnapshotScanned\(owner, chainId, primaryScan,/);
  });

  test('no flow repeats its cache refresh on a timer', () => {
    expect(callers(/setTimeout\(\s*\(\)\s*=>\s*\{?\s*(?:void\s+)?invalidateTransactionCaches/)).toEqual([]);
  });
});

describe('claim-link recovery reads what is held', () => {
  test('it never asks anyone for Note events', () => {
    const recovery = read('services/blind-deposit-recovery.ts');
    expect(recovery).not.toMatch(/getNoteEvents|createASPDataProvider|apiClient|fetch\(/);
    expect(recovery).toContain('await loadPoolEventSnapshot(input.chainId)');
    expect(recovery).toContain('noteCiphertextsFor(');
  });
});

describe('screens read per-asset statistics, they do not fetch them', () => {
  test('only the grid feed asks for them', () => {
    expect(callers(/\.getAssetStatistics\s*\(/)).toEqual(['services/asset-statistics-feed.ts']);
    const hook = read('hooks/use-asset-statistics.ts');
    expect(hook).toContain('usePublicFeed');
    expect(hook).not.toContain('useQuery');
  });
});

// e2e withdraw-preparation-privacy on PR #254 (runs 38257568642, 38272204833):
// "open the Withdraw tab and type an amount" caught a GET /global/public/entrypoints
// and the RPC tail sweep of a discovery pass. The pass was the grid's own (it
// started on the 2-minute event-snapshot instant, 30s into the window), so the
// e2e now keeps that instant out of the action window the way it keeps the
// price tick out. The entrypoints GET was a real timing channel: the grid tick
// could find the copy a few ms short of its TTL, skip the fetch, and leave it to
// whichever caller came next. These pin both halves.
describe('opening Withdraw and typing an amount puts nothing on the wire', () => {
  test('the withdraw form starts no discovery pass and fetches no entrypoints', () => {
    const withdraw = read('components/withdraw-modal-provider.tsx');
    expect(withdraw).not.toMatch(/\b(?:syncFromSnapshot|syncAllChains)\s*\(|\.discoverNotes\s*\(/);
    expect(withdraw).not.toMatch(/\bgetEntrypoints\s*\(/);
    // Nothing the form uses for its context pulls a discovery trigger either.
    expect(withdraw).not.toMatch(/\bsyncFromSnapshot\b/);
  });

  test('the background discovery pass follows the grid, not the form', () => {
    const provider = read('components/sdk-provider.tsx');
    const start = provider.indexOf('const onFeed = (cid: number) =>');
    const effect = provider.slice(start, provider.indexOf('}, [poolSession', start) + 160);
    // Its dependencies are the session and the chain: no modal, tab, amount or
    // selection can re-run it.
    expect(effect).toMatch(/\}, \[poolSession, noteManager, effectiveAddress, chainId, syncFromSnapshot, discoverSiblingChain, refreshNotes\]\);/);
  });

  test("the e2e's discovery keep-out uses the snapshot feed's real period", async () => {
    const { DISCOVERY_GRID } = await import('../../scripts/e2e/window-phase');
    const snapshot = read('services/snapshot-source.ts');
    const m = /export const EVENT_SNAPSHOT_INTERVAL_MS = (\d+) \* 60_000;/.exec(snapshot);
    expect(m).not.toBeNull();
    expect(DISCOVERY_GRID.periodMs).toBe(Number(m![1]) * 60_000);
  });

  test('only the grid refreshes entrypoints, and its copy outlives the period', () => {
    const feeds = read('services/public-feeds.ts');
    expect(feeds).toContain('fetch: () => apiClient.getEntrypoints({ refresh: true })');
    expect(feeds).toMatch(/key: FEED_ENTRYPOINTS,\s*intervalMs: 5 \* MINUTE,/);
    expect(read('services/api-client.ts')).toContain('export const ENTRYPOINTS_GRID_MS = 5 * 60_000;');
    expect(callers(/getEntrypoints\(\s*\{\s*refresh:\s*true/)).toEqual(['services/public-feeds.ts']);
  });
});
