// @ts-nocheck - drives a real browser with real playwright types.
//
// Share names never reach the screen, on any surface a user can open without a
// deposit: every hub tab (Shield, Withdraw, Send, Swap, Request), My balances,
// Portfolio and the pool pages of the yield pools (USDC, USDT, ETH on Ethereum),
// with the public activity list open.
//
// Twice: first while every share-rate read (ERC-4626 convertToAssets) is held,
// which is the state a slow RPC leaves the page in and the one where the share
// count used to be printed with the share's own symbol, then with the rate in.
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent.
import { check, connect, finish, hold, hubTab, isShareRateRead, launch, open, sleep, unlockWithWallet } from './harness.ts';

const TABS = ['shield', 'withdraw', 'send', 'swap', 'request'] as const;
const POOLS = [['ethereum', 'usdc'], ['ethereum', 'usdt'], ['ethereum', 'eth']] as const;

const s = await launch('share-names');
const rate = await hold(s.page, isShareRateRead);
const { page } = s;

/** Type an amount where a form takes one, so the conversion and balance lines render. */
async function typeAmount(key: string) {
  const field = page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]) input[placeholder="0"], [data-testid="hub-page-${key}"]:not([aria-hidden="true"]) input[placeholder="0.0"]`).first();
  if (!(await field.isVisible().catch(() => false))) return;
  await field.fill('1').catch(() => {});
  await sleep(1500);
}

async function tabs(where: string) {
  for (const key of TABS) {
    const opened = await hubTab(page, key);
    if (key !== 'swap') check(opened, `${where}: the ${key} tab opens`);
    if (!opened) continue;
    await sleep(1500);
    await s.guardStep(`${where} / ${key}`);
    await typeAmount(key);
    await s.guardStep(`${where} / ${key} with an amount`);
  }
}

async function pass(phase: string) {
  await open(page, '/');
  if (phase === 'rate pending') check(await connect(page), 'the read-only wallet connects');
  await sleep(4000);
  await tabs(`${phase} / home`);

  await open(page, '/?panel=balances');
  await sleep(4000);
  check(/My balances/.test(await s.text()), `${phase}: My balances opens`);
  await s.guardStep(`${phase} / My balances`);

  await open(page, '/portfolio');
  await sleep(3000);
  const signIn = page.getByTestId('portfolio-sign-in').first();
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click().catch(() => {});
    await sleep(2000);
    await unlockWithWallet(page);
  }
  await sleep(4000);
  check(/Net Value|No positions yet|All Positions/i.test(await s.text()), `${phase}: Portfolio renders after sign-in`);
  await s.guardStep(`${phase} / Portfolio`);
  await s.shot(`${phase.replace(/\W+/g, '-')}-portfolio`);

  for (const [chain, asset] of POOLS) {
    const where = `${phase} / pool ${chain}/${asset}`;
    await open(page, `/chains/${chain}/${asset}`);
    await sleep(4000);
    check((await page.locator('[data-testid="pool-not-found"]').count()) === 0, `${where}: the pool page is found`);
    await s.guardStep(where);
    // The public activity list prints other people's amounts: the place a
    // share count used to be labelled with the share's symbol.
    const all = page.getByText('All', { exact: true }).first();
    if (await all.isVisible().catch(() => false)) {
      await all.click().catch(() => {});
      await sleep(4000);
    }
    if (asset === 'usdc') {
      // The events feed is on a two-minute grid: give it one tick to land, so
      // the rows (and their (i) hints) are on screen when the guard looks.
      await page.locator('[data-testid="transaction-row"]').first().waitFor({ timeout: 150_000 }).catch(() => {});
      console.log(`  ${where}: ${await page.locator('[data-testid="transaction-row"]').count()} public activity rows on screen`);
    }
    await s.guardStep(`${where} / all activity`);
    await tabs(where);
  }
}

try {
  await pass('rate pending');
  check(rate.held() > 0, 'the share-rate reads were held during the first pass', `${rate.held()} held`);
  rate.release();
  await sleep(2000);
  await pass('rate loaded');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('share names', s.browser);
