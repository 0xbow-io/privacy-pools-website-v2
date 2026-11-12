// @ts-nocheck - drives a real browser with real playwright types.
//
// A payroll salary is an amount of the COIN, and the Send modal prepares SHARES
// (DEV-622). A payout of 5 USDC from the USDC share pool must hand the transfer
// the shares 5 USDC is worth at the share rate, rounded up so the payee never
// gets less, and never 5 shares (worth more than 5 USDC).
//
//  1. A pending payroll run with one 5 USDC row on Ethereum, written where the
//     app keeps payroll on this device (the legacy keys, which the first
//     identity to open payroll inherits).
//  2. A ppUSDC note in the session's local account cache, so the Send modal has
//     a USDC share balance to settle on. It is never spent: the wallet refuses
//     every transaction and the note is not on chain.
//  3. /payroll/run, Pay on the row: the Send modal opens with the salary.
//
// The amount the modal will prepare (`data-prepared-amount` on its field, the
// value every fee, proof and relayer request is built from) must equal
// sharesForUnderlyingCeil(5, rate) with the rate THIS page received
// (services/underlying-amount-entry.ts, the boundary the modal itself uses).
// The screen shows the coin either way, so the figure on screen proves nothing.
//
// Prod world, read-only wallet (./harness.ts): nothing is sent.
import { randomBytes } from 'node:crypto';
import { formatUnits, parseUnits } from 'viem';
import { sharesForUnderlyingCeil } from '../../../services/underlying-amount-entry.ts';
import { check, connect, finish, launch, open, sleep, trackShareRates, unlockWithWallet } from './harness.ts';

const PPUSDC = '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6';
const SHARE_DECIMALS = 18;
const USDC_DECIMALS = 6;
const SALARY = '5';
const FIELD = '[data-testid="transfer-amount-input"]';
const hex32 = () => `0x${randomBytes(32).toString('hex')}`;

const s = await launch('payroll-amount', { guardScope: '[role="dialog"], [role="alert"], [role="status"]' });
const { page, address } = s;
const rates = trackShareRates(page);

// 1 + 2: seeded before the app loads. Only this fresh browser profile sees them.
const payee = `0x${randomBytes(20).toString('hex')}`;
const now = Date.now();
const row = { employeeId: 'smoke-1', name: 'Smoke Payee', walletAddress: payee, network: 'Ethereum', chainId: 1, amount: Number(SALARY), amountText: SALARY, currency: 'USDC', status: 'pending' };
const seed = {
  employees: [{ id: 'smoke-1', name: 'Smoke Payee', role: 'QA', walletAddress: payee, network: 'Ethereum', salary: Number(SALARY), salaryText: SALARY, currency: 'USDC', status: 'active', createdAt: now }],
  runs: [{ id: 'smoke-run', date: now, periodLabel: 'Smoke', status: 'pending', chainId: 1, items: [row] }],
  exportKey: `ppv2_account_export_v2_${address}_1_prod`,
  account: {
    owner: address,
    chainId: 1,
    // Far ahead of the chain: the session does not rescan history for this cache.
    syncCursor: '0xffffffff',
    notes: [{
      noteAddressHash: hex32(), commitment: hex32(), label: hex32(), noteSecret: hex32(), txHash: hex32(),
      value: `0x${(100n * 10n ** 18n).toString(16)}`,
      tokenId: PPUSDC, status: 'ACTIVE', ownerAddress: address, isOwned: true,
      createdAtBlock: '0x1', spentAtBlock: null,
    }],
    paymentRequests: [],
  },
};
await page.addInitScript((seed) => {
  try {
    if (!localStorage.getItem('ppv2_payroll_runs_v1')) {
      localStorage.setItem('ppv2_payroll_employees_v1', JSON.stringify(seed.employees));
      localStorage.setItem('ppv2_payroll_runs_v1', JSON.stringify(seed.runs));
    }
    if (!sessionStorage.getItem(seed.exportKey)) sessionStorage.setItem(seed.exportKey, JSON.stringify(seed.account));
  } catch { /* a storage error fails the checks below */ }
}, seed);

/** The share rate the page itself received for the USDC share, as the app's ShareRate. */
function rate() {
  const assetsPerShare = rates.rateOf(PPUSDC);
  return assetsPerShare ? {
    chainId: 1, share: PPUSDC, underlying: 'usdc', shareSymbol: 'ppUSDC', shareDecimals: SHARE_DECIMALS,
    assetsPerShare, underlyingSymbol: 'USDC', underlyingDecimals: USDC_DECIMALS,
  } : undefined;
}

try {
  await open(page, '/payroll/run');
  check(await connect(page), 'the read-only wallet connects');
  await unlockWithWallet(page);
  for (let i = 0; i < 120 && !rate(); i++) await sleep(500);
  check(!!rate(), 'the page received the USDC share rate', `${rate()?.assetsPerShare ?? 'none'}`);

  const pay = page.getByText('Pay', { exact: true }).first();
  check(await pay.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false), 'payroll: the 5 USDC row offers Pay');
  await pay.click();
  await sleep(2000);
  await unlockWithWallet(page);
  const field = page.locator(FIELD).first();
  const opened = await field.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false);
  if (!opened) await s.shot('payroll-no-modal');
  if (!check(opened, 'the Send modal opens')) throw new Error('no Send modal');

  let held: string | null = null;
  let want: string | null | undefined;
  for (let i = 0; i < 120; i++) {
    const r = rate();
    want = r ? sharesForUnderlyingCeil(SALARY, r) : undefined;
    held = await field.getAttribute('data-prepared-amount', { timeout: 2000 }).catch(() => null);
    if (want && held === want) break;
    await sleep(500);
  }
  const r = rate();
  const worth = held && r ? formatUnits(parseUnits(held, SHARE_DECIMALS) * r.assetsPerShare / 10n ** 18n, USDC_DECIMALS) : '?';
  check(!!want && held === want, `payroll: ${SALARY} USDC hands the Send modal the shares it is worth at the page's rate`, `want ${want ?? 'no rate seen'}, prepared ${held} (worth ${worth} USDC)`);
  check(held !== SALARY, `payroll: the ${SALARY} USDC salary is not sent as ${SALARY} shares`, `prepared ${held}`);
  await s.guardStep('payroll send, salary converted');
  await s.shot('payroll-send');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('payroll salary is sent as shares', s.browser);
