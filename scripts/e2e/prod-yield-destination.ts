// @ts-nocheck
// Prod-config Shield surface: an asset with a pp pool must LOOK open and must
// deposit directly.
//
// This is the browser half of the 2026-09-12 pair. Twice that day a prod user
// picked USDC and the app answered with a refusal instead of a deposit:
//
//   "Deposits closed · withdraw or send"                    (the picker)
//   "Converting USDC isn't available on this network."      (the hub)
//
// Both came from a surface asking the vault-VERIFIED yield resolver a question
// it does not answer until an on-chain probe lands. The unit suite now pins the
// rules (services/__tests__/shield-pay-routing.test.ts,
// services/__tests__/yield-resolver-split.test.ts); this proves the rendered
// page, on the prod world, in the state a first page load is actually in - no
// wallet, no session, so no probe has run.
//
// No wallet, no chain, no funds: it is a config-and-copy gate, so it is safe to
// run on every PR next to the funded journey.
//
// What it can and cannot reach without a wallet: the hub, the destination
// picker and every pool page, which is where "Deposits closed" and the share
// name were rendered. The PAY picker needs wallet balances, so the plain-USDC
// pay row is covered by the unit suite instead (shield-pay-routing.test.ts
// asserts getDepositableTokens, defaultPoolFor and the subtitle under prod with
// the probe unanswered). Verified to go red on the real regression: wiring the
// token sheet back to the verified resolver fails this script, and so does
// wiring services/shield-pools.ts back: the ethereum/usdt pool page then
// renders "Converting USDT isn't available", the user's exact sentence. USDC
// alone would NOT have caught that one - the destination fallback happens to
// land on the ppUSDC pool anyway - which is why every pair prod ships is walked
// here rather than only the one that was reported.
//
// PROBE_URL points at a dev server; ?env=prod switches the world at load
// (config/app-environment.ts) and is persisted, so the whole run stays on prod.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const ROOT = new URL('../..', import.meta.url).pathname;
const BASE = process.env.PROBE_URL || 'http://localhost:8081';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The exact sentences that shipped. Matched as text, not as a class of thing:
// a reworded refusal is a different bug and should fail loudly here too.
const CLOSED_LINE = /Deposits closed/i;
const CONVERSION_REFUSAL = /Converting\s+\w+\s+isn't available/i;
// Ameen via Pat, 2026-09-12: the share name is in no user-facing sentence.
const SHARE_NAME = /\bpp(usdc|usdt)\b/i;
const NOT_FOUND_LINE = /There is no .* pool on .*/i;

// Same resolution order as scripts/e2e/lib.ts, plus the shared playwright
// cache: locally the browser is pinned under .pw-browsers or that cache, and in
// CI `playwright install` puts it wherever playwright expects.
const CANDIDATES = [
  `${ROOT}/.pw-browsers/chromium-1228/chrome-linux64/chrome`,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
];
const pinned = CANDIDATES.find((p) => existsSync(p));
const browser = await chromium.launch({
  headless: true,
  ...(pinned ? { executablePath: pinned } : {}),
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
const page = await context.newPage();
// Metro compiles the web bundle on the FIRST request, which on a cold CI runner
// is minutes, not seconds. Playwright's 30s default turned that into a
// "Timeout 30000ms exceeded" that reads like a broken page (CI, 2026-09-12).
page.setDefaultNavigationTimeout(240_000);
page.setDefaultTimeout(60_000);
const appErrors: string[] = [];
page.on('pageerror', (e) => appErrors.push(String(e)));

async function visibleText(): Promise<string> {
  return (await page.evaluate(() => document.body.innerText).catch(() => '')) ?? '';
}

/**
 * Wait until the page SAYS something, instead of sleeping and hoping.
 *
 * Every wait here used to be a fixed sleep sized for a slow runner. On a slower
 * one the assertion read a half-painted page: "the run is on the PROD world,
 * not staging" failed twice and passed once on identical code in a single
 * morning (2026-09-22), always alone, with all 22 product assertions green.
 * That is worse than a slow gate, because a gate that fails half the time is
 * one people learn to scroll past, and this one guards a refusal users saw.
 *
 * The predicate settles on EITHER outcome, never on the one we want: the
 * caller waits for the world to be identifiable, staging or prod, and then
 * asserts which it is. Waiting only for the good answer would turn a genuine
 * misconfiguration into a timeout and hide it behind the budget.
 *
 * Polling `document.body.innerText` issues no requests, so a run stays as quiet
 * on the wire as a sleep did.
 */
async function textUntil(settled: (text: string) => boolean, budgetMs = 45_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const text = await visibleText();
    if (settled(text) || Date.now() >= deadline) return text;
    await sleep(250);
  }
}

/** Either chain set names itself; which one it is, is the caller's assertion. */
const WORLD_NAMED = /Ethereum|BNB|Citrea|Sepolia/i;

try {
  await page.goto(`${BASE}/?env=prod`, { waitUntil: 'domcontentloaded' });
  const home = await textUntil((text) => WORLD_NAMED.test(text));
  check(home.length > 0, 'the prod world renders at all', `${home.length} chars`);
  // Prod's chain set, not staging's: if ?env=prod did not take, everything
  // below would pass vacuously against Sepolia, where USDC is not a legacy
  // asset and the bug cannot exist.
  check(/Ethereum|BNB|Citrea/i.test(home) && !/Sepolia/i.test(home), 'the run is on the PROD world, not staging',
    /Sepolia/i.test(home) ? 'Sepolia named on the page' : '');

  check(!CLOSED_LINE.test(home), 'the hub never says deposits are closed', CLOSED_LINE.exec(home)?.[0] ?? '');
  check(!CONVERSION_REFUSAL.test(home), 'the hub never refuses a conversion on first paint', CONVERSION_REFUSAL.exec(home)?.[0] ?? '');
  // Deliberately NOT a whole-page share-name check. The public activity feed
  // prints a share AMOUNT ("49.87911 ppUSDC") whenever the live exchange rate
  // has not been read yet - the fallback in components/pools/transactions.tsx,
  // which exists so a share count is never labelled as one-for-one underlying.
  // That is a real instance of the same ask and a real bug (the rate should be
  // available there), but it is an AMOUNT, not prose, and relabelling it is a
  // decision about a number rather than about wording. The share-name gate
  // below is scoped to the surfaces that regressed: the destination picker and
  // the pool pages.

  // The destination PILL. On prod the intent surface is locked
  // (config/intent-lockdown.ts), so there is no destination picker to open:
  // the pool follows the pay token through defaultPoolFor. That defaulting is
  // exactly what broke - a USDC pick fell through to another pool while the
  // probe was unanswered - so assert what the pill SAYS.
  const poolPill = page.locator('[data-testid="hub-shield-pool"]').first();
  if (await poolPill.count()) {
    await poolPill.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
    // Wait for the pill to have said anything, rather than for 800ms to pass.
    // An empty pill is still a failure below; this only stops us reading it
    // before it has rendered.
    let pill = '';
    for (const deadline = Date.now() + 15_000; ;) {
      pill = ((await poolPill.innerText().catch(() => '')) ?? '').trim();
      if (pill.length > 0 || Date.now() >= deadline) break;
      await sleep(250);
    }
    check(pill.length > 0, 'the shield destination pill renders', JSON.stringify(pill));
    check(!CLOSED_LINE.test(pill), 'the destination pill never says deposits are closed', pill);
    check(!SHARE_NAME.test(pill), 'the destination pill never names the share', pill);
    // It must name a real pool, not a placeholder.
    check(/USDC|USDT|ETH|BNB|cBTC/i.test(pill), 'the destination pill names a pool', pill);
  } else {
    check(false, 'the shield destination pill is present', 'no hub-shield-pool testID found');
  }

  // Every pool page prod serves for a yield underlying. A deep link is the one
  // way to reach a specific asset with no wallet, and it exercises the same
  // resolvers the hub does.
  //
  // The chain segment is the chain's ROUTE name (config/prod-deployments
  // `name`), not its display name: BNB Chain routes as `bsc`. A wrong segment
  // lands on the not-found card, where three of the four checks below still
  // pass because an empty page says nothing wrong. That is how `bnb` sat red
  // for a week reading like a product bug, so the not-found card is now its
  // own check and no assertion here is allowed to pass on a dead page.
  for (const [chain, asset] of [['ethereum', 'usdc'], ['ethereum', 'usdt'], ['bsc', 'usdt']] as const) {
    await page.goto(`${BASE}/chains/${chain}/${asset}?env=prod`, { waitUntil: 'domcontentloaded' });
    // Settle on the asset being named OR the not-found card, so a dead page
    // fails its own check immediately instead of burning the budget. Never on
    // the asset alone: that is the answer this probe exists to doubt.
    const body = await textUntil((text) => new RegExp(asset, 'i').test(text) || NOT_FOUND_LINE.test(text));
    const label = `${chain}/${asset}`;
    check(body.length > 0, `${label}: the pool page renders`);
    check(
      (await page.locator('[data-testid="pool-not-found"]').count()) === 0,
      `${label}: the deep link reaches the pool, not the not-found card`,
      NOT_FOUND_LINE.exec(body)?.[0] ?? '',
    );
    check(!CLOSED_LINE.test(body), `${label}: the pool page never says deposits are closed`, CLOSED_LINE.exec(body)?.[0] ?? '');
    check(!CONVERSION_REFUSAL.test(body), `${label}: no conversion refusal`, CONVERSION_REFUSAL.exec(body)?.[0] ?? '');
    check(!SHARE_NAME.test(body), `${label}: the share is not named`, SHARE_NAME.exec(body)?.[0] ?? '');
  }

  check(appErrors.length === 0, 'no uncaught page errors', appErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close().catch(() => {});
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\nprod yield destination: all checks passed');
