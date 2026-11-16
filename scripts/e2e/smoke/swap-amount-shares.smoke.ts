// @ts-nocheck - drives a real browser with real playwright types.
//
// The Swap amount is the COIN it names, and the swap prepares SHARES. Opened
// from the pool page (not the home card), the Swap modal stored the typed
// figure as is and `amountWei` read it as shares: "5 USDC" prepared 5 ppUSDC
// shares, worth more than 5 USDC.
//
//  1. Pool page (/chains/ethereum/usdc, the ppUSDC share pool): the action
//     panel's Swap tab, 5 USDC typed, Review swap. The modal opens with the
//     amount the panel handed it.
//  2. The modal's own field: 7 USDC typed.
//
// Each time the amount the modal will prepare (`data-prepared-amount` on its
// field, the value `amountWei` parses and the SDK quote is built from) must be
// the shares the typed coin buys at the share rate THIS page received, computed
// with the app's own conversion boundary (services/share-amount-entry.ts), and
// never the typed figure itself. The screen shows the coin either way, so the
// figure on screen proves nothing here.
//
// The fresh wallet holds nothing, so Review stays refused for an amount above
// the balance and nothing reaches the relayer; the prepared amount is the last
// value before it. Prod world, read-only wallet (./harness.ts): nothing is sent.
import { formatUnits, parseUnits } from 'viem';
import { shareAmountFromUnderlying } from '../../../services/share-amount-entry.ts';
import { shareFieldFigure } from '../../../services/share-balance-display.ts';
import { check, connect, finish, launch, open, sleep, trackShareRates, unlockWithWallet } from './harness.ts';

const PPUSDC = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';
const SHARE_DECIMALS = 18;
const USDC_DECIMALS = 6;
const MODAL_FIELD = '[data-testid="swap-amount-input"]';

// Below the split width (1024) the pool page draws its own action panel instead
// of the home card, and that panel opens the Swap MODAL: the path with the bug.
const s = await launch('swap-amount', { viewport: { width: 1000, height: 1300 }, guardScope: '[role="dialog"], [role="alert"], [role="status"]' });
const { page } = s;
const rates = trackShareRates(page);

/** The share rate the page itself received for ppUSDC, as the app's ShareRate. */
function rate() {
  const assetsPerShare = rates.rateOf(PPUSDC);
  return assetsPerShare ? {
    chainId: 1, share: PPUSDC, underlying: 'usdc', shareSymbol: 'ppUSDC', shareDecimals: SHARE_DECIMALS,
    assetsPerShare, underlyingSymbol: 'USDC', underlyingDecimals: USDC_DECIMALS,
  } : undefined;
}

/** The shares `typed` USDC must prepare on Swap: the boundary, unclamped, over a zero balance. */
function expectedShares(typed: string): string | undefined {
  const r = rate();
  return r ? shareAmountFromUnderlying({ text: typed, rate: r, maxSharesExact: '0', displayedMax: shareFieldFigure('0', r), clamp: false, rounding: 'down' }) : undefined;
}

async function prepared(): Promise<string | null> {
  return page.locator(MODAL_FIELD).first().getAttribute('data-prepared-amount').catch(() => null);
}

/** Poll until the modal prepares `want` (re-read each poll), or report what it held. */
async function expectPrepared(typed: string, label: string) {
  let held: string | null = null;
  let want: string | undefined;
  for (let i = 0; i < 40; i++) {
    want = expectedShares(typed);
    held = await prepared();
    if (want && held === want) break;
    await sleep(500);
  }
  const worth = held && rate() ? formatUnits(parseUnits(held, SHARE_DECIMALS) * rate()!.assetsPerShare / 10n ** 18n, USDC_DECIMALS) : '?';
  check(!!want && held === want, `${label}: ${typed} USDC prepares the shares it buys at the page's rate`, `want ${want ?? 'no rate seen'}, prepared ${held} (worth ${worth} USDC)`);
  check(held !== typed, `${label}: the typed ${typed} is not prepared as ${typed} shares`, `prepared ${held}`);
}

try {
  await open(page, `/chains/ethereum/usdc?swap=true`);
  for (let i = 0; i < 120 && !rate(); i++) await sleep(500);
  check(!!rate(), 'the page received the ppUSDC share rate', `${rate()?.assetsPerShare ?? 'none'}`);

  // 1. The pool page's action panel, Swap tab: typed while signed out (a
  // connected empty account disables the spend actions), handed to the modal.
  const tab = page.getByRole('tab', { name: 'Swap' }).first();
  check(await tab.isVisible({ timeout: 30_000 }).catch(() => false), 'the pool page offers a Swap tab');
  await tab.click();
  const panelField = page.getByLabel('Amount to swap').first();
  await panelField.waitFor({ state: 'visible', timeout: 30_000 });
  await panelField.fill('5');
  await sleep(1000);
  check((await panelField.inputValue()) === '5', 'pool page: the Swap field reads the 5 USDC typed', await panelField.inputValue());
  await page.getByText('Review swap', { exact: true }).first().click();
  await sleep(2000);
  check(await connect(page), 'the read-only wallet connects');
  await unlockWithWallet(page);
  const modalField = page.locator(MODAL_FIELD).first();
  check(await modalField.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false), 'the Swap modal opens');
  await expectPrepared('5', 'pool page hand-off');
  await s.guardStep('swap modal, amount handed over');

  // 2. The modal's own field.
  await modalField.fill('7');
  await expectPrepared('7', 'swap modal field');
  check(Number((await modalField.inputValue()).replace(/,/g, '')) === 7, 'swap modal: the field shows the 7 USDC typed, not a share count', await modalField.inputValue());
  await s.guardStep('swap modal, amount typed');
  await s.shot('swap-amount');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('swap amount is shares', s.browser);
