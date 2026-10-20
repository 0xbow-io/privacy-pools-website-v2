// @ts-nocheck
// Verifies the asp-v2#117 integration end to end: the ASP serves blockTimestamp
// on /note-events, the app harvests it, and the per-block eth_getBlockByNumber
// burst stops as a result.
//
// Reports honestly if the ASP has not rolled the field out yet, rather than
// passing vacuously: the whole point is whether the field is THERE and USED.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/asp-timestamps.ts
import { accountFromKey, openApp, signIn, sleep, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const ASP = 'https://api-dev.0xbow.io';
const CHAIN = 11155111;
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

// ---- 1. the ASP side: does /note-events carry blockTimestamp? --------------
let aspServesField = false;
try {
  const r = await fetch(`${ASP}/${CHAIN}/public/note-events?since=10994884&until=10996884`);
  const body: any = r.ok ? await r.json() : null;
  const rows: any[] = body?.events ?? [];
  const withTs = rows.filter((e) => e.blockTimestamp != null);
  aspServesField = withTs.length > 0;
  record(
    'ASP /note-events serves blockTimestamp (asp-v2#117)',
    aspServesField,
    aspServesField
      ? `${withTs.length}/${rows.length} rows carry it, e.g. ${withTs[0].blockTimestamp}`
      : `HTTP ${r.status}, ${rows.length} rows, none carry blockTimestamp - deploy has not rolled out yet`,
  );
  if (aspServesField) {
    // The value must be a real date, not a placeholder: it lands inside a
    // commitment leaf, where a wrong value fails only inside the circuit.
    const ms = Date.parse(String(withTs[0].blockTimestamp));
    const sane = Number.isFinite(ms) && ms > Date.parse('2024-01-01') && ms < Date.now() + 86_400_000;
    record('ASP blockTimestamp is a plausible date', sane, `parsed ${new Date(ms).toISOString()}`);
  }
} catch (e) {
  record('ASP /note-events serves blockTimestamp (asp-v2#117)', false, `threw: ${(e as Error).message}`);
}

// ---- 2. the app side: harvested, and block reads avoided -------------------
const app = await openApp(acct, { tag: 'asp-timestamps' });
const p = app.page;
// Forward the app's own [perf] diagnostics: without this the browser console is
// discarded and the hint path looks silent even when it is running.
p.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[perf]') || t.includes('tail-hints') || t.includes('block-ts asked')) {
    console.log(`  ${t}`.slice(0, 220));
  }
});
let noteEventsCalls = 0;
let blockReads = 0;
let latestReads = 0;
let specificBlockReads = 0;
p.on('request', (req) => {
  try {
    const u = new URL(req.url());
    if (u.pathname.includes('/public/note-events')) noteEventsCalls += 1;
    const b = req.postData();
    if (b && b.includes('"eth_getBlockByNumber"')) {
      blockReads += 1;
      // Break down by param: "latest" is viem/wagmi polling and fee estimation,
      // a concrete block number is a per-block read of the kind the ASP
      // timestamps are meant to replace. Conflating them would misattribute the
      // burst entirely.
      try {
        const parsed = JSON.parse(b);
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of calls) {
          if (c?.method !== 'eth_getBlockByNumber') continue;
          const arg = String(c?.params?.[0] ?? '');
          if (arg === 'latest' || arg === 'pending' || arg === 'safe' || arg === 'finalized') latestReads += 1;
          else specificBlockReads += 1;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
});
try {
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(5000);
  await signIn(p);
  const balance = await waitForShieldedBalance(p, 12);
  await sleep(10_000);

  record('app fetched the note-events feed', noteEventsCalls > 0, `${noteEventsCalls} call(s), balance ${balance} ETH`);

  const harvested = await p.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    // The store is module-scoped; expose its count through the debug hook if
    // present, else fall back to counting what the page reports.
    return (g.__ppv2AspTsCount as number | undefined) ?? null;
  });

  console.log(
    `  eth_getBlockByNumber total ${blockReads}: ${latestReads} for "latest" (polling / fee estimation)`
    + `, ${specificBlockReads} for a SPECIFIC block (what ASP timestamps replace)`
    + `; note-events calls: ${noteEventsCalls}; harvested hints: ${harvested ?? 'n/a'}`,
  );

  if (aspServesField) {
    // Measured floor, not an aspiration. Before the integration a cold load
    // issued ~450 per-block reads, and ~203 after the first (mis-windowed)
    // attempt. With the delta window aligned to the blocks actually needed, the
    // main tail resolves 174 of 210 from ASP hints and fetches ONE.
    //
    // What remains is the heal path, which reaches back to much older blocks
    // (spans from ~11.24M) for rows whose ASP timestamp was dropped - exactly
    // the rows the snapshot cannot supply, so those reads are inherent. It is
    // capped per build and runs a few times per load, landing around 45.
    record(
      'the per-block burst is gone once the ASP serves timestamps',
      specificBlockReads <= 70,
      `${specificBlockReads} per-block reads, was ~450 before the integration`
      + ` (total ${blockReads}, of which ${latestReads} are "latest" polling)`,
    );
  } else {
    record(
      'block reads fall back to the chain while the ASP lacks the field',
      true,
      `${specificBlockReads} per-block reads, ${latestReads} "latest" polling - fallback path`,
    );
  }
} catch (e) {
  record('asp-timestamps app run', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}

console.log('\n===== asp-timestamps summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
