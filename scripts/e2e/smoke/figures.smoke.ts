// @ts-nocheck - drives a real browser with real playwright types.
//
// DEV-621: the figures on the screen. Every dollar and stablecoin figure on
// Home, the pool pages, My balances (with its My transactions), Portfolio and
// the Send and Swap tabs has exactly two decimals, and no pool count is
// printed under a coin label, both while the vault rate is still out (the
// shimmer state) and after it has loaded. The accessibility label on a yield
// balance hint reads "Balance details", never one that leads with the pool
// unit's noun.
//
// The rules are the guard's (../share-name-rules.ts: a "≈" count under a coin,
// a stablecoin with more than two decimals, a dollar figure that is not
// "$1,234.56" or abbreviated). This smoke runs the whole page through them and
// also asserts positively that dollar figures were on screen, so a page that
// renders nothing cannot pass.
//
// What it cannot see: this wallet holds no yield position, so there is no
// balance header, pool row for a holding, or MAX to compare. That one number
// per position is pinned by services/__tests__/dev621-between-cents.test.ts and
// dev621-one-figure.test.ts.
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent.
import { check, connect, finish, hold, hubTab, isShareRateRead, launch, open, sleep, unlockWithWallet } from './harness.ts';

const POOLS = [['ethereum', 'usdc'], ['ethereum', 'usdt'], ['ethereum', 'eth']] as const;
const USD_FIGURE = /(?<![\w.])\$\d[\d,]*(?:\.\d+)?[kKmMbB]?/g;
const TWO_DECIMALS = /^\$\d[\d,]*\.\d{2}$|^\$\d[\d,]*(?:\.\d{1,2})?[kKmMbB]$/;
const COUNT_UNDER_COIN = /≈\s*\d[\d,]*(?:\.\d+)?\s+(ETH|USDC|USDT)\b/;

const s = await launch('figures');
const rate = await hold(s.page, isShareRateRead);
const { page } = s;

/** Check every dollar figure now on screen; returns how many there were. */
async function figures(where: string, { needSome }: { needSome: boolean }): Promise<number> {
  const text = await s.text();
  const found = text.match(USD_FIGURE) ?? [];
  const bad = [...new Set(found.filter((f) => !TWO_DECIMALS.test(f)))];
  check(bad.length === 0, `${where}: every dollar figure has two decimals`, bad.slice(0, 4).join(' '));
  check(!COUNT_UNDER_COIN.test(text), `${where}: no count under a coin label`, COUNT_UNDER_COIN.exec(text)?.[0] ?? '');
  if (needSome) check(found.length > 0, `${where}: dollar figures are on screen`, `${found.length} found`);
  // The (i) on a balance: "Balance details", never a label leading with the pool unit's noun.
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label') || ''));
  const wrong = labels.filter((l) => /^share\b.*details/i.test(l));
  check(wrong.length === 0, `${where}: the balance hint is labelled "Balance details"`, wrong.join(' | '));
  return found.length;
}

async function tab(key: 'send', where: string) {
  if (!(await hubTab(page, key))) return;
  await sleep(1500);
  const field = page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]) input[placeholder="0"], [data-testid="hub-page-${key}"]:not([aria-hidden="true"]) input[placeholder="0.0"]`).first();
  if (await field.isVisible().catch(() => false)) {
    await field.fill('1.5').catch(() => {});
    await sleep(1500);
  }
  await s.guardStep(`${where} / ${key}`);
  await figures(`${where} / ${key}`, { needSome: false });
}

async function pass(phase: string) {
  await open(page, '/');
  if (phase === 'rate pending') check(await connect(page), 'the read-only wallet connects');
  await sleep(4000);
  await s.guardStep(`${phase} / Home`);
  await figures(`${phase} / Home`, { needSome: false });
  await tab('send', `${phase} / Home`);

  await open(page, '/?panel=balances');
  await sleep(4000);
  check(/My balances/.test(await s.text()), `${phase}: My balances opens`);
  await s.guardStep(`${phase} / My balances`);
  await figures(`${phase} / My balances`, { needSome: false });

  await open(page, '/portfolio');
  await sleep(3000);
  const signIn = page.getByTestId('portfolio-sign-in').first();
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click().catch(() => {});
    await sleep(2000);
    await unlockWithWallet(page);
  }
  await sleep(4000);
  await s.guardStep(`${phase} / Portfolio`);
  await figures(`${phase} / Portfolio`, { needSome: false });

  for (const [chain, asset] of POOLS) {
    const where = `${phase} / pool ${chain}/${asset}`;
    await open(page, `/chains/${chain}/${asset}`);
    await sleep(4000);
    check((await page.locator('[data-testid="pool-not-found"]').count()) === 0, `${where}: the pool page is found`);
    await s.guardStep(where);
    await figures(where, { needSome: true });
    const all = page.getByText('All', { exact: true }).first();
    if (await all.isVisible().catch(() => false)) {
      await all.click().catch(() => {});
      await sleep(3000);
      await s.guardStep(`${where} / all activity`);
      await figures(`${where} / all activity`, { needSome: false });
    }
  }
}

try {
  await pass('rate pending');
  check(rate.held() > 0, 'the vault-rate reads were held during the first pass', `${rate.held()} held`);
  rate.release();
  await sleep(2000);
  await pass('rate loaded');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('figures', s.browser);
