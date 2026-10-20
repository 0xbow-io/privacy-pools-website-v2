// @ts-nocheck
// Measures a cold balance load with services/perf-trace.ts installed, and
// prints the tracer's own report plus a request census computed independently
// from the browser (so the numbers are not just the tracer's word).
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/perf-balance.ts
import { accountFromKey, openApp, signIn, sleep, waitForShieldedBalance } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const app = await openApp(acct, { tag: 'perf-balance' });
const p = app.page;
const perfLines: string[] = [];
p.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[perf]')) perfLines.push(t);
});

// Independent census: count requests by host + JSON-RPC method at the CDP level.
const census = new Map<string, { n: number; bytes: number }>();
p.on('request', (req) => {
  try {
    const u = new URL(req.url());
    // Keep the chain scope in the key: /association-set/leaves?chainId=1 and
    // ?chainId=11155111 are different resources, and collapsing them hid
    // whether the root-gated cache was working per chain.
    const chain = u.searchParams.get('chainId');
    let key = `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{6,}/g, '0x…')}${chain ? `?chainId=${chain}` : ''}`;
    const body = req.postData();
    if (body && body[0] === '{') {
      try { const j = JSON.parse(body); if (j.method) key = `${u.host} ${j.method}`; } catch {}
    } else if (body && body[0] === '[') {
      try { const j = JSON.parse(body); key = `${u.host} batch[${j.length}]:${Array.from(new Set(j.map((x) => x.method))).join(',')}`; } catch {}
    }
    const e = census.get(key) ?? { n: 0, bytes: 0 };
    e.n += 1;
    census.set(key, e);
  } catch {}
});

const t0 = Date.now();
await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await sleep(4000);
const tSignIn = Date.now();
await signIn(p);
const balance = await waitForShieldedBalance(p, 12);
const tBalance = Date.now();
console.log(`\n===== cold balance load =====`);
console.log(`sign-in -> balance visible: ${((tBalance - tSignIn) / 1000).toFixed(1)}s   (page open -> balance: ${((tBalance - t0) / 1000).toFixed(1)}s)`);
console.log(`shielded balance: ${balance} ETH`);

// Let the network settle so the tracer's auto-report fires, then ask for it.
await sleep(6000);
await p.evaluate(() => (window as any).__ppv2Perf?.report?.());
await sleep(1500);

// ---- the case Pat actually reported: RELOAD with a warm export ------------
// A cold browser must wait for discovery; a reload already has the account
// export in sessionStorage, so if it ALSO waits ~45s the blocking full-range
// re-scan is the lever. If it paints fast, the cold path is the only problem.
console.log(`\n===== warm reload =====`);
const warmCensus = new Map<string, number>();
const onReq = (req) => {
  try {
    const u = new URL(req.url());
    const chain = u.searchParams.get('chainId');
    let k = `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{6,}/g, '0x…')}${chain ? `?chainId=${chain}` : ''}`;
    const b = req.postData();
    if (b && b[0] === '{') { try { const j = JSON.parse(b); if (j.method) k = `${u.host} ${j.method}`; } catch {} }
    warmCensus.set(k, (warmCensus.get(k) ?? 0) + 1);
  } catch {}
};
p.on('request', onReq);
const tReload = Date.now();
await p.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
const warmBalance = await waitForShieldedBalance(p, 12);
const tWarm = Date.now();
console.log(`reload -> balance visible: ${((tWarm - tReload) / 1000).toFixed(1)}s  (balance ${warmBalance} ETH)`);
await sleep(8000);
await p.evaluate(() => (window as any).__ppv2Perf?.report?.());
await sleep(1500);
const warmRows = Array.from(warmCensus.entries()).sort((a, b) => b[1] - a[1]);
console.log(`warm reload requests: ${warmRows.reduce((n, [, v]) => n + v, 0)}`);
for (const [k, v] of warmRows.slice(0, 12)) console.log(`  ${String(v).padStart(4)}x  ${k}`);

console.log(`\n===== independent request census, COLD (top 25 by count) =====`);
const rows = Array.from(census.entries()).sort((a, b) => b[1].n - a[1].n);
const total = rows.reduce((n, [, v]) => n + v.n, 0);
console.log(`total requests: ${total}`);
for (const [k, v] of rows.slice(0, 25)) console.log(`  ${String(v.n).padStart(4)}x  ${k}`);
if (rows.length > 25) console.log(`  … ${rows.length - 25} more kinds`);

// Who issues the repeated 525KB association-set fetch? Dump the captured
// stacks for that key specifically, since the auto-report only attributes the
// top few kinds.
const leafStacks = await p.evaluate(() => {
  const raw = (window as any).__ppv2Perf?.raw?.();
  if (!raw) return [];
  return raw.samples
    .filter((s: any) => /association-set\/leaves/.test(s.key))
    .map((s: any) => s.stack || '(no stack captured)');
});
// ---- the case the persisted caches actually target: a NEW TAB -------------
// A new tab loses sessionStorage (the note export, the deep-scan marker) but
// KEEPS localStorage (the association set, the block-timestamp map). That is
// what a user gets when they open the app again later, and it is the only run
// where persistence can show up - a fresh browser context has nothing stored.
console.log(`\n===== new tab (sessionStorage cleared, localStorage kept) =====`);
const tabCensus = new Map<string, number>();
p.on('request', (req) => {
  try {
    const u = new URL(req.url());
    let k = `${u.host}${u.pathname.replace(/0x[0-9a-fA-F]{6,}/g, '0x…')}`;
    const b = req.postData();
    if (b && b[0] === '{') { try { const j = JSON.parse(b); if (j.method) k = `${u.host} ${j.method}`; } catch {} }
    tabCensus.set(k, (tabCensus.get(k) ?? 0) + 1);
  } catch {}
});
const storedBefore = await p.evaluate(() => {
  const out: Record<string, number> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i)!;
    if (/ppv2_(assoc_leaves|block_ts)/.test(k)) out[k] = (localStorage.getItem(k) || '').length;
  }
  sessionStorage.clear();
  return out;
});
console.log(`persisted before the new tab: ${JSON.stringify(storedBefore)}`);
const tTab = Date.now();
await p.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
await signIn(p).catch(() => {});
const tabBalance = await waitForShieldedBalance(p, 12);
console.log(`new tab -> balance visible: ${((Date.now() - tTab) / 1000).toFixed(1)}s  (balance ${tabBalance} ETH)`);
await sleep(8000);
const tabRows = Array.from(tabCensus.entries()).sort((a, b) => b[1] - a[1]);
console.log(`new-tab requests: ${tabRows.reduce((n, [, v]) => n + v, 0)}`);
for (const [k, v] of tabRows.slice(0, 10)) console.log(`  ${String(v).padStart(4)}x  ${k}`);

console.log(`\n===== association-set/leaves callers (${leafStacks.length} samples) =====`);
leafStacks.forEach((st: string, i: number) => {
  const frames = st.split(' <- ').map((f) => f.replace(/\(https?:\/\/[^)]*\)/g, '').trim()).filter(Boolean);
  console.log(`  [${i + 1}] ${frames.slice(0, 5).join(' <- ')}`);
});

console.log(`\n===== tracer output (${perfLines.length} lines) =====`);
for (const l of perfLines) console.log(l);
await app.browser.close().catch(() => {});
