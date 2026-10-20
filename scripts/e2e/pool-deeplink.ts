// @ts-nocheck
// Pool page routes on Sepolia (items 6/7 of the QA work order):
//   1. /chains/sepolia/usdc?action=deposit opens the deposit modal ON USDC
//      (desktop and mobile). Before the fix the intent was burned while wagmi
//      was still reconnecting, and the modal (when it did open) defaulted to
//      the chain's native token.
//   2. /chains/sepolia/doge renders the not-found state, not a "DOGE Pool".
//   3. Asset statistics come from the feed grid (services/asset-statistics-feed.ts),
//      which asks about every catalogued asset of every chain THIS BUILD
//      serves, whichever page is open, so the request no longer says which
//      pool page was opened. The page must still never ask about a chain the
//      build does not serve (the original bug: /1/public/asset-statistics from
//      a staging page pinned to Sepolia), and Sepolia must be among them.
// Signed in as A. Exits 1 on any failed check.
import { accountFromKey, bodyText, openApp, sleep, unlockIfPrompted } from './lib';
import { envValue } from './funding';
import { ENVIRONMENTS } from '../../config/environments';

// The e2e app runs the staging build. This script's own process resolves
// ACTIVE_ENVIRONMENT to prod (no Sepolia), so name the environment explicitly.
// Sepolia's staging deployment is env-gated and can be absent from this
// process's config even though the app serves it, so it is always allowed.
const SERVED_CHAIN_IDS = new Set(['11155111', ...ENVIRONMENTS.staging.deployments.map((d) => String(d.chainId))]);
const statChain = (u: string) => /\/(\d+)\/public\/asset-statistics/.exec(u)?.[1] ?? null;

const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const A = accountFromKey(aKey.startsWith('0x') ? aKey : `0x${aKey}`);
const BASE = process.env.PROBE_URL || 'http://localhost:8081';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
}

const app = await openApp(A, { tag: 'pool-deeplink' });
const { page } = app;
const statRequests: string[] = [];
page.on('request', (req) => { if (/asset-statistics/.test(req.url())) statRequests.push(req.url()); });

async function selectedDepositToken(timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await unlockIfPrompted(page);
    const el = page.locator('[data-testid="deposit-token-selected"]').first();
    if (await el.count()) {
      const label = await el.getAttribute('aria-label');
      if (label) return label.replace(/^Deposit token: /, '');
    }
    await sleep(1000);
  }
  return null;
}

async function deepLinkOpensUsdcDeposit(label: string, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`${BASE}/chains/sepolia/usdc?action=deposit`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const token = await selectedDepositToken(90_000);
  check(token !== null, `${label}: ?action=deposit opens the deposit modal`, token === null ? 'no deposit token selector rendered' : '');
  if (token !== null) check(token === 'USDC', `${label}: deposit modal opened on the route's token`, `selected ${token}`);
  await app.shot(`pool-deeplink-${label}`);
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await unlockIfPrompted(page);

  await deepLinkOpensUsdcDeposit('desktop', { width: 1440, height: 1200 });
  await deepLinkOpensUsdcDeposit('mobile', { width: 390, height: 844 });

  await page.setViewportSize({ width: 1440, height: 1200 });
  statRequests.length = 0;
  await page.goto(`${BASE}/chains/sepolia/usdc`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  await unlockIfPrompted(page);
  const sepoliaStats = statRequests.filter((u) => statChain(u) === '11155111');
  const foreign = statRequests.filter((u) => !SERVED_CHAIN_IDS.has(statChain(u) ?? ''));
  check(sepoliaStats.length > 0 && foreign.length === 0, 'usdc pool page: statistics requested only for chains this build serves, Sepolia included', foreign.length ? `unserved: ${foreign.join(', ')}` : `${sepoliaStats.length} Sepolia request(s), chains ${[...new Set(statRequests.map(statChain))].join(',')}`);
  const usdcBody = await bodyText(page);
  check(/USDC Pool/.test(usdcBody), 'usdc pool page: titled USDC Pool');

  await page.goto(`${BASE}/chains/sepolia/doge`, { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await unlockIfPrompted(page);
  const notFound = await page.locator('[data-testid="pool-not-found"]').count();
  const bogusBody = await bodyText(page);
  check(notFound > 0 && /Pool not found/.test(bogusBody), 'bogus asset route shows the not-found state', notFound ? '' : `first line "${bogusBody.split('\n').find((l) => l.trim())?.slice(0, 60)}"`);
  check(!/DOGE Pool/.test(bogusBody), 'bogus asset route does not fabricate a DOGE Pool');
  await app.shot('pool-deeplink-bogus');

  await page.goto(`${BASE}/chains/nowhere/eth`, { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const badChain = await page.locator('[data-testid="pool-not-found"]').count();
  check(badChain > 0, 'bogus chain route shows the not-found state');

  await page.goto(`${BASE}/chains/nowhere/sui`, { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  const badSuiChain = await page.locator('[data-testid="pool-not-found"]').count();
  check(badSuiChain > 0, 'bogus chain with /sui asset shows the not-found state');

  // A deep link on a not-found route must stay inert: no modal on the
  // fallback native token.
  await page.goto(`${BASE}/chains/sepolia/doge?action=deposit`, { waitUntil: 'domcontentloaded' });
  await sleep(8000);
  await unlockIfPrompted(page);
  await sleep(4000);
  const inertNotFound = await page.locator('[data-testid="pool-not-found"]').count();
  const inertModal = await page.locator('[data-testid="deposit-token-selected"]').count();
  check(inertNotFound > 0 && inertModal === 0, 'deep link on a not-found route opens no deposit modal', `notFound=${inertNotFound} modal=${inertModal}`);
} finally {
  await app.browser.close();
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
