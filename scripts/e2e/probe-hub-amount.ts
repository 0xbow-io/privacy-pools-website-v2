// @ts-nocheck
// TEMP probe: reproduce "after making a transfer the receive card keeps the amount".
// Reads the hub's amount input and the "Recipient receives" figure at every stage.
import { openApp, signIn, unlockIfPrompted, tab, enterAmount, fillRecipient, submitOrPast,
  clickButton, waitForText, waitForShieldedBalance, bodyText, account, sleep, BASE } from './lib';

const acct = account('DEV_PK');
const other = account('DEV_PK2').address;
const AMT = process.env.PROBE_AMOUNT || '0.001';

async function state(p, label) {
  const s = await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map((i) => i.value);
    const t = document.body.innerText;
    const i = t.indexOf('Recipient receives');
    return { inputs, around: i < 0 ? '(no receive card)' : t.slice(Math.max(0, i - 120), i + 120).replace(/\n/g, ' / ') };
  });
  console.log(`\n### ${label}\n  inputs: ${JSON.stringify(s.inputs)}\n  receive-card: ${s.around}`);
}

const { browser, page, shot } = await openApp(acct, { tag: 'hubamount' });
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(page);
  await unlockIfPrompted(page);
  if (!(await tab(page, 'Send'))) throw new Error('Send tab never active');
  const bal = await waitForShieldedBalance(page, 6);
  console.log(`shielded balance: ${bal}`);
  if (bal < Number(AMT)) throw new Error(`not enough shielded balance (${bal})`);
  await state(page, 'send tab, empty form');
  if (!(await fillRecipient(page, other, 'Send'))) throw new Error('recipient not filled');
  if (!(await enterAmount(page, AMT, 'Send'))) throw new Error('amount did not stick');
  await state(page, `after typing ${AMT}`);
  await shot('filled');
  const got = await submitOrPast(page, ['Review transfer', 'Send privately', 'Send']);
  console.log(`submit: ${got}`);
  await sleep(3000);
  await unlockIfPrompted(page);
  for (const label of ['Confirm transfer', 'Confirm', 'Send privately', 'Send']) {
    if (await clickButton(page, label)) { console.log(`clicked ${label}`); break; }
  }
  const settled = await waitForText(page, /Transfer Successful|Transfer outcome unknown|Transfer failed|reverted/i, 900_000);
  console.log(`settled: ${settled ? settled.slice(0, 80) : 'TIMEOUT'}`);
  await shot('success');
  await state(page, 'success panel');
  if (await clickButton(page, 'Done')) console.log('clicked Done');
  await sleep(4000);
  await state(page, 'after Done +4s');
  await sleep(8000);
  await state(page, 'after Done +12s');
  await shot('after-done');
  console.log('\n--- body tail ---\n' + (await bodyText(page)).slice(0, 600));
} finally {
  await browser.close();
}
