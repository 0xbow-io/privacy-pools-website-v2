import { serve } from 'bun';
// Local browser regression for the half of the privacy gate that unit tests
// cannot reach: harvesting a journey's secrets OUT of a real page, and the
// gate's verdict over really-captured traffic.
//
// No application, wallet, chain or external API. A throwaway server stands in
// for the ASP, which is enough because the engine classifies by HOST.
//
// This exists because the gate had never executed. `network-capture-smoke.mjs`
// proves the capture; the unit tests prove the engine against synthetic
// requests. Nothing proved that `collectJourneySecrets` reads what this app
// actually stores, or that a real run's timestamps land in the windows the
// journey declares. A gate nobody has run is a gate that might not work.
//
// Run: safewrap bun scripts/e2e/privacy-gate-smoke.mjs
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { toFunctionSelector } from 'viem';
import { chromium } from 'playwright';
import { startNetworkCapture } from './network-capture.ts';
import { collectJourneySecrets, resolveHosts, runNetworkPrivacyGate } from './privacy-gate.ts';
import { recordPublicState } from './public-state-fixture.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shaped like a real stored export: services/sdk-setup.ts writes
// `ppv2_account_export_v2_<addr>_<chain>` into sessionStorage, holding the
// SDK's notes. The field NAMES are what collectJourneySecrets classifies on,
// so they have to be the real ones.
const LABEL = '0x2f1a4c9d1b7e6a5038f2c4d9e8b7a6150c3d2e1f0a9b8c7d6e5f4031223344556';
const COMMITMENT = '19283746501928374650192837465019283746501928374650192837465019';
const NULLIFIER = '0x8ab3c1d2e3f405162738495a6b7c8d9eaf0123456789abcdef0123456789abcd';
const NOTE_VALUE = '200000000000000';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

const EXPORT = {
  notes: [
    { value: '1', status: 'ACTIVE' }, // Retained dust must not disable the gate.
    {
      label: LABEL,
      commitment: COMMITMENT,
      nullifier: NULLIFIER,
      value: NOTE_VALUE,
      status: 'ACTIVE',
      tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      createdAtBlock: '0x' + '1234'.padStart(64, '0'),
      spentAtBlock: '0x' + '0'.repeat(64),
      ownerAddress: ADDRESS,
      noteAddressHash: '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
    },
  ],
  syncCursor: '0xa6d283',
};

const seen = [];
let snapshotVersion = 0;
const server = serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push(url.pathname + url.search);
    if (url.pathname === '/rpc') {
      const call = await request.json();
      return Response.json({ jsonrpc: '2.0', id: call.id, result: ++snapshotVersion });
    }
    if (/\/event-snapshot\/(latest|payload)$/.test(url.pathname) || /\/association-set\/(root|leaves)$/.test(url.pathname)) {
      return new Response(gzipSync(JSON.stringify({ version: ++snapshotVersion })), {
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      });
    }
    if (url.pathname === '/') {
      return new Response('<html><body>privacy gate smoke</body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  },
});

const origin = server.url.origin;
// The throwaway server plays the ASP. Everything else classifies as `other`,
// which is the strictest policy and exactly what we want for a stranger.
const hosts = resolveHosts({ aspUrl: origin, ownOrigin: 'http://127.0.0.1:1' });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  ...(process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {}),
});

try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const capture = startNetworkCapture(context);
  const page = await context.newPage();
  const pinSnapshots = recordPublicState(page, origin);
  await capture.attachPage(page);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });

  await page.evaluate((exported) => {
    sessionStorage.setItem('ppv2_account_export_v2_0xabc_11155111', JSON.stringify(exported));
  }, EXPORT);

  // ---- 1. the harvest ------------------------------------------------
  const secrets = await collectJourneySecrets(page, { addresses: [ADDRESS] });
  assert.ok(secrets.labels.includes(LABEL), 'label not harvested from the stored export');
  assert.ok(secrets.commitments.includes(COMMITMENT), 'commitment not harvested');
  assert.ok(!secrets.commitments.includes(EXPORT.notes[1].createdAtBlock), 'public block metadata is not a private commitment');
  assert.ok(!secrets.commitments.includes(EXPORT.notes[1].tokenId), 'public asset identifier is not a private commitment');
  assert.ok(!secrets.commitments.includes(ADDRESS), 'owner is classified as an address');
  assert.ok(secrets.nullifiers.includes(NULLIFIER), 'nullifier not harvested');
  assert.ok(secrets.amountsWei.includes(NOTE_VALUE), 'note value not harvested');
  assert.ok(secrets.amountsWei.includes('1'), 'retained dust remains covered');
  // Anything long and opaque a note carries is still ours, even unclassified.
  assert.ok(
    secrets.commitments.some((c) => c.startsWith('0xfeedface')),
    'an unclassified note field was dropped instead of being treated as secret',
  );

  // External pool changes must not contaminate the timing experiment. Both
  // snapshot endpoints stay fixed, while unexpected outgoing traffic is seen.
  const snapshot = path => page.evaluate(async url => (await fetch(url)).json(), `${origin}/11155111/public/event-snapshot/${path}`);
  const rootCall = id => page.evaluate(async args => (await fetch(`${args.origin}/rpc`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: args.id, method: 'eth_call', params: [{ data: args.selector }, 'latest'] }),
  })).json(), { origin, id, selector: toFunctionSelector('latestASPRoot()') });
  const root = await rootCall(1);
  const latest = await snapshot('latest');
  const payload = await snapshot('payload');
  const restore = await pinSnapshots();
  try {
    assert.deepEqual(await snapshot('latest'), latest);
    assert.deepEqual(await snapshot('payload'), payload);
    assert.deepEqual(await rootCall(2), { ...root, id: 2 }, 'pin the public root without breaking RPC correlation');
    await page.evaluate(o => fetch(`${o}/unexpected-form-request`), origin);
    await capture.flushCapture();
    const unexpected = capture.captured.filter(r => r.url.endsWith('/unexpected-form-request'));
    assert.ok(unexpected.length > 0, 'snapshot isolation must preserve request observation');
    assert.equal(runNetworkPrivacyGate({
      captured: unexpected, secrets, hosts,
      windows: [{ action: 'form request while snapshots are fixed', baselines: [], start: unexpected[0].t, end: Date.now() + 1 }],
    }).ok, false, 'snapshot isolation must not exempt form-triggered traffic');
  } finally { await restore(); }
  assert.notDeepEqual(await snapshot('latest'), latest, 'live snapshots resume before transactions');
  assert.notDeepEqual(await snapshot('payload'), payload);
  assert.notEqual((await rootCall(3)).result, root.result);
  await capture.flushCapture();
  capture.clearCapture();

  // ---- 2. quiet controls, then the action ----------------------------
  // Two equal-length idle windows with the app in the same state, then the
  // action. A background poll runs throughout so the budgets have something
  // to measure; if the gate could not tell that apart from a triggered
  // request it would cry wolf on every real run.
  const WINDOW = 300;
  const poll = () => page.evaluate((o) => { void fetch(`${o}/global/public/statistics`); }, origin);

  const baselines = [];
  for (let i = 0; i < 2; i += 1) {
    const start = Date.now();
    await poll();
    await sleep(WINDOW - (Date.now() - start));
    baselines.push({ start, end: Date.now() });
  }

  const start = Date.now();
  await poll();
  // The leak, in both of its disclosed shapes: a label set in a HEADER, and a
  // route that is only ever touched when a withdrawal is imminent.
  await page.evaluate(
    async ([o, label, amount]) => {
      await fetch(`${o}/global/public/statistics`, { headers: { 'X-Labels': label } });
      await fetch(`${o}/global/public/deposits-larger-than?amount=${amount}`);
    },
    [origin, LABEL, NOTE_VALUE],
  );
  // The activity feed filtered by the session address: no waiver covers it,
  // so it is a leak like any other.
  await page.evaluate((a) => fetch(`${a[0]}/global/public/events?address=${a[1]}`), [origin, ADDRESS]);
  await sleep(Math.max(0, WINDOW - (Date.now() - start)));
  const window = { action: 'smoke: open the withdraw form', baselines, start, end: Date.now() };

  await capture.flushCapture();

  // ---- 3. the verdict -------------------------------------------------
  const bad = runNetworkPrivacyGate({
    captured: capture.captured,
    secrets,
    hosts,
    windows: [window],
  });
  assert.equal(bad.ok, false, 'the gate passed a run that leaked a label header and an amount');
  assert.match(bad.detail, /leak\(s\)/);
  assert.ok(/labels/.test(bad.text), 'the label header leak was not reported');
  assert.ok(/amountsWei/.test(bad.text), 'the amount leak was not reported');
  assert.ok(/saw a addresses/.test(bad.text), 'the address-filtered activity feed was not reported');
  assert.ok(/TIMING/.test(bad.text), 'the never-before-seen route was not a timing violation');
  // The value itself must never appear in a leak REASON line... it appears in
  // the evidence by design (describeLeaks quotes it so a human can act), so
  // the check here is that the background poll was NOT reported.
  assert.ok(
    !/TIMING.*statistics/s.test(bad.text.split('TIMING')[1] ?? ''),
    'a poll present in both controls was reported as caused by the action',
  );

  // ---- 4. the same run, minus the leaks, must pass --------------------
  const clean = runNetworkPrivacyGate({
    captured: capture.captured.filter(
      (r) => !/deposits-larger-than|events\?address=/.test(r.url) && !('x-labels' in (r.headers ?? {})),
    ),
    secrets,
    hosts,
    windows: [{ ...window, start: window.end, end: window.end + WINDOW }],
  });
  assert.equal(
    clean.ok,
    true,
    `the gate failed a clean run, which is how a gate gets switched off:\n${clean.text}`,
  );

  console.log(
    `PASS privacy gate smoke: ${capture.captured.length} captured; harvest, `
    + 'header leak, amount leak, address leak, timing violation, and a clean pass',
  );
} finally {
  await browser.close();
  server.stop(true);
}
