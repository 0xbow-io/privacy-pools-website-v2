// @ts-nocheck - drives a real browser with real playwright types.
//
// Self withdrawal, without a deposit:
//  - off by default: the withdraw form has no own-wallet checkbox;
//  - turned on through the menu (Privacy & keys, then the warning modal);
//  - the checkbox starts unchecked; checking it makes the recipient a read-only
//    field holding the connected wallet and drops the relayer-only controls
//    (gas top-up, receive-exact) and every relayer-fee line; unchecking it
//    gives back the address that was typed;
//  - with an amount typed and the box checked, Review (when the form lets it
//    through) says there is no relayer fee.
// The share-name guard reads these controls and every dialog.
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent.
import { randomBytes } from 'node:crypto';
import { check, connect, finish, hubTab, launch, open, sleep } from './harness.ts';

const W = '[data-testid="hub-page-withdraw"]:not([aria-hidden="true"])';
const s = await launch('self-withdrawal', {
  guardScope: [
    '[data-testid="withdraw-self-withdrawal"]', '[data-testid="withdraw-recipient-own-wallet"]',
    '[data-testid="withdraw-self-withdrawal-wallet"]', '[data-testid="withdraw-self-withdrawal-review-note"]',
    '[role="dialog"]', '[role="alert"]', '[role="status"]',
  ].join(', '),
});
const { page } = s;
const typed = `0x${randomBytes(20).toString('hex')}`;

const box = () => page.locator(`${W} [data-testid="withdraw-self-withdrawal"]`).first();
const recipient = () => page.locator(`${W} input[placeholder="Enter recipient 0x address"]`).first();
const ownWallet = () => page.locator(`${W} [data-testid="withdraw-recipient-own-wallet-input"]`).first();
const withdrawText = async () => ((await page.locator(W).first().innerText().catch(() => '')) ?? '');
// Checked shows the own-wallet recipient (aria-checked is not on the web node).
const isChecked = async () => (await box().getAttribute('aria-checked').catch(() => null)) === 'true'
  || (await ownWallet().isVisible().catch(() => false));

try {
  await open(page, '/?action=withdraw');
  check(await connect(page), 'the read-only wallet connects');
  await sleep(3000);
  check(await hubTab(page, 'withdraw'), 'the Withdraw tab opens');
  await sleep(2000);
  check((await box().count()) === 0, 'off by default: no own-wallet checkbox on the withdraw form');

  // Turn it on the way a user does: the account menu, Privacy & keys, the warning.
  await page.getByText(/^0x[0-9a-fA-F]{2,6}(…|\.\.\.)[0-9a-fA-F]{2,6}$/).first().click();
  await sleep(800);
  await page.getByText('Privacy & keys', { exact: true }).first().click();
  await sleep(800);
  const row = page.getByTestId('menu-self-withdrawal').first();
  check(/Self withdrawal: Off/.test((await row.innerText().catch(() => '')) ?? ''), 'the menu row reads "Self withdrawal: Off"');
  await row.click();
  await page.getByTestId('self-withdrawal-enable').first().waitFor({ timeout: 15_000 });
  check(/Enable self withdrawal/.test(await s.text()), 'turning it on shows the warning first');
  await s.guardStep('self withdrawal warning');
  await page.getByTestId('self-withdrawal-enable').first().click();
  await sleep(1500);

  await hubTab(page, 'withdraw');
  await box().waitFor({ timeout: 15_000 }).catch(() => {});
  check((await box().count()) === 1, 'on: the withdraw form offers the own-wallet checkbox');
  check(!(await isChecked()), 'the checkbox starts unchecked');

  await recipient().fill(typed);
  await sleep(800);
  await box().click();
  await sleep(1500);
  check(await isChecked(), 'the checkbox checks');
  const own = ((await ownWallet().inputValue().catch(() => '')) ?? '').toLowerCase();
  check(own === s.address, 'checked: the recipient shows the connected wallet', `${own} vs ${s.address}`);
  const editable = await ownWallet().isEditable().catch(() => true);
  check(!editable, 'checked: the recipient is read-only');
  check(!(await recipient().isVisible().catch(() => false)), 'checked: the typed recipient field is gone');
  const checkedText = await withdrawText();
  check(!/relayer fee/i.test(checkedText), 'checked: no relayer-fee line on the form', /.{0,40}relayer fee.{0,40}/i.exec(checkedText)?.[0] ?? '');
  check((await page.locator(`${W} [data-testid="withdraw-gas-token"]`).count()) === 0, 'checked: no gas top-up (it is the relayer\'s)');
  check((await page.locator(`${W} [data-testid="withdraw-receive-exact"]`).count()) === 0, 'checked: no receive-exact toggle (it is the relayer\'s)');
  await s.guardStep('self withdrawal checked');

  // Review. A fresh wallet holds nothing, so the form may refuse before Review;
  // when it lets it through, the review must say there is no relayer fee.
  const amount = page.locator(`${W} [data-testid="hub-amount-input"]`).first();
  await amount.fill('1').catch(() => {});
  await sleep(1500);
  const cta = page.locator(W).getByRole('button', { name: /^Withdraw$/ }).last();
  if (await cta.isEnabled().catch(() => false)) {
    await cta.click().catch(() => {});
    await sleep(5000);
    const review = await s.text();
    if (/No relayer/.test(review) || /Confirm/.test(review)) {
      check(/No relayer fee/.test(review), 'review: says there is no relayer fee');
      check(!/Relayer fee\s*[$\d]/i.test(review), 'review: shows no relayer fee figure');
    } else {
      console.log('  review not reached with an empty account: the review needs a shielded balance (funded journey)');
    }
    await s.guardStep('self withdrawal review');
  } else {
    console.log('  Withdraw is disabled with an empty account: the review needs a shielded balance (funded journey)');
  }

  await box().click();
  await sleep(1500);
  check(!(await isChecked()), 'the checkbox unchecks');
  const restored = ((await recipient().inputValue().catch(() => '')) ?? '').toLowerCase();
  check(restored === typed, 'unchecked: the typed recipient comes back', `${restored} vs ${typed}`);
  check(await recipient().isEditable().catch(() => false), 'unchecked: the recipient is editable again');
  await s.guardStep('self withdrawal unchecked');
  await s.shot('withdraw');
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('self withdrawal', s.browser);
