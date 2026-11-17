// @ts-nocheck - drives a real browser with real playwright types.
//
// An amount typed on a yield pool's own page is an amount of the COIN, and the
// Withdraw and Transfer actions prepare SHARES (the same rule the payroll Send
// modal follows, payroll-amount.smoke.ts). 5 USDC typed into the USDC pool page
// must hand the action the shares 5 USDC is worth at the share rate, rounded up
// so the payee never gets less, and never 5 shares (worth more than 5 USDC).
//
//  1. A share note in the session's local account cache, so the pool page has a
//     spendable balance to act on. It is never spent: the wallet refuses every
//     transaction and the note is not on chain.
//  2. /chains/ethereum/usdc, the Withdraw tab then the Transfer tab, 5 typed.
//
// The amount each action will prepare (`data-prepared-amount` on its field, the
// value every fee, proof and relayer request is built from) must equal
// sharesForUnderlyingCeil(5, rate) with the rate THIS page received
// (services/underlying-amount-entry.ts, the boundary the field itself uses).
// The screen shows the coin either way, so the figure on screen proves nothing.
//
// Prod world, read-only wallet (./harness.ts): nothing is sent.
import { randomBytes } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';
import { sharesForUnderlyingCeil } from '../../../services/underlying-amount-entry.ts';
import { check, connect, finish, launch, open, sleep, trackShareRates, unlockWithWallet } from './harness.ts';

const SHARE_USDC = '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6';
const SHARE_DECIMALS = 18;
const USDC_DECIMALS = 6;
const TYPED = '5';
const FIELD = '[data-testid="pool-amount-input"]';
const TABS = ['Withdraw', 'Transfer'] as const;
const hex32 = () => `0x${randomBytes(32).toString('hex')}`;

// Narrower than SPLIT_MIN_WIDTH (1024): from there up the pool page drops its own
// action panel (the shield widget in the left column carries the actions), so the
// field this smoke reads never mounts at the harness default of 1440.
const s = await launch('pool-share-amount', {
  guardScope: '[role="dialog"], [role="alert"], [role="status"]',
  viewport: { width: 960, height: 1100 },
});
const { page, address } = s;
const rates = trackShareRates(page);

// 1: seeded before the app loads. Only this fresh browser profile sees it.
const seed = {
  exportKey: `ppv2_account_export_v2_${address}_1_prod`,
  account: {
    owner: address,
    chainId: 1,
    // Far ahead of the chain: the session does not rescan history for this cache.
    syncCursor: '0xffffffff',
    notes: [{
      noteAddressHash: hex32(), commitment: hex32(), label: hex32(), noteSecret: hex32(), txHash: hex32(),
      value: `0x${(100n * 10n ** 18n).toString(16)}`,
      tokenId: SHARE_USDC, status: 'ACTIVE', ownerAddress: address, isOwned: true,
      createdAtBlock: '0x1', spentAtBlock: null,
    }],
    paymentRequests: [],
  },
};
await page.addInitScript((seed) => {
  try {
    if (!sessionStorage.getItem(seed.exportKey)) sessionStorage.setItem(seed.exportKey, JSON.stringify(seed.account));
  } catch { /* a storage error fails the checks below */ }
}, seed);

/** The share rate the page itself received for the USDC share, as the app's ShareRate. */
function rate() {
  const assetsPerShare = rates.rateOf(SHARE_USDC);
  return assetsPerShare ? {
    chainId: 1, share: SHARE_USDC, underlying: 'usdc', shareSymbol: 'ppUSDC', shareDecimals: SHARE_DECIMALS,
    assetsPerShare, underlyingSymbol: 'USDC', underlyingDecimals: USDC_DECIMALS,
  } : undefined;
}

try {
  await open(page, '/chains/ethereum/usdc');
  check(await connect(page), 'the read-only wallet connects');
  await unlockWithWallet(page);
  for (let i = 0; i < 120 && !rate(); i++) await sleep(500);
  check(!!rate(), 'the page received the USDC share rate', `${rate()?.assetsPerShare ?? 'none'}`);
  check((await page.locator('[data-testid="pool-not-found"]').count()) === 0, 'the USDC pool page is found');

  for (const label of TABS) {
    const tab = page.getByRole('tab', { name: label, exact: true }).first();
    const offered = await tab.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false);
    if (!check(offered, `${label}: the pool page offers the ${label} action`)) { await s.shot(`pool-no-${label}`); continue; }
    await tab.click();
    const field = page.locator(FIELD).first();
    const shown = await field.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    if (!check(shown, `${label}: the amount field opens`)) { await s.shot(`pool-no-field-${label}`); continue; }
    await field.fill(TYPED);

    let held: string | null = null;
    let want: string | null | undefined;
    for (let i = 0; i < 120; i++) {
      const r = rate();
      want = r ? sharesForUnderlyingCeil(TYPED, r) : undefined;
      held = await field.getAttribute('data-prepared-amount', { timeout: 2000 }).catch(() => null);
      if (want && held === want) break;
      await sleep(500);
    }
    const r = rate();
    const worth = held && r ? formatUnits(parseUnits(held, SHARE_DECIMALS) * r.assetsPerShare / 10n ** 18n, USDC_DECIMALS) : '?';
    check(!!want && held === want, `${label}: ${TYPED} USDC hands the action the shares it is worth at the page's rate`, `want ${want ?? 'no rate seen'}, prepared ${held} (worth ${worth} USDC)`);
    check(held !== TYPED, `${label}: the ${TYPED} USDC is not prepared as ${TYPED} shares`, `prepared ${held}`);
    await s.guardStep(`pool ${label}, amount converted`);
    await s.shot(`pool-${label.toLowerCase()}`);
  }
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('pool page amounts are prepared as shares', s.browser);
