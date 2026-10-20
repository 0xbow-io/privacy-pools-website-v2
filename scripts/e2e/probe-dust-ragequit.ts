// @ts-nocheck
// ONE-OFF cleanup: ragequit account C's 0.0001 ETH dust deposits.
//
// Each deposit is its own lineage = its own proof group in a full-balance
// batch, and a 0.0001 group's relayer fee exceeds its value, which fails the
// whole batch. These two came from the first bring-up (forceUnlock deposits
// 0.0001 as its unlock vehicle - since replaced with a deposit-free unlock).
// Ragequit exits a deposit to its own depositor with no ASP involvement.
import { keccak256, stringToBytes, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { clickButton, openApp, publicClient, signIn, sleep, tab, unlockIfPrompted, waitForText, fillRecipient, enterAmount } from './lib';
import { envValue } from './funding';

const rawKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const funderKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
const C = privateKeyToAccount(keccak256(stringToBytes(`${funderKey}:ppv2-batch-e2e-v1`)));
const client = publicClient();
console.log(`cleaning dust from C: ${C.address}`);

const { browser, page, shot, appLogs } = await openApp(C, { tag: 'dustclean' });
let exited = 0;
try {
  await page.goto(process.env.PROBE_URL || 'http://localhost:8081', { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(page);
  // Deposit-free unlock (same as batch-withdraw.ts): prime Send, sign, abandon.
  await tab(page, 'Send');
  await fillRecipient(page, C.address, 'Send');
  await enterAmount(page, '0.0001', 'Send');
  await clickButton(page, 'Review transfer');
  await sleep(2500);
  if (await unlockIfPrompted(page)) {
    const d = Date.now() + 240_000;
    while (Date.now() < d && !/session built/.test(appLogs.join('\n'))) await sleep(3000);
  }

  for (let round = 1; round <= 2; round += 1) {
    if (!(await clickButton(page, 'My activity'))) throw new Error('My activity not pressable');
    await sleep(8000);
    // Wait for note sync (same signal doRagequit uses).
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !/(totalNoteCount|activeNoteCount): [1-9]/.test(appLogs.join('\n'))) await sleep(5000);

    // Find the kebab that belongs to a 0.0001 row. Rows mount well after the
    // drawer opens (round 2 once saw 0 rows moments after a reload) - poll.
    const kebabs = page.locator('[aria-label="Transaction actions"]');
    let n = 0;
    const rowsDeadline = Date.now() + 120_000;
    while (Date.now() < rowsDeadline) {
      n = await kebabs.count();
      if (n > 0) break;
      await clickButton(page, 'My activity');
      await sleep(5000);
    }
    console.log(`round ${round}: ${n} activity rows`);
    // ALL dust candidates: an already-exited 0.0001 keeps its row (menu with
    // no Exit entry), so the first match is not necessarily the live one.
    const candidates: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const rowText = await kebabs.nth(i).evaluate((el) => {
        let node = el;
        for (let d = 0; d < 8; d += 1) {
          node = node.parentElement;
          if (!node) return '';
          const t = node.innerText || '';
          if (/ETH/.test(t) && t.length < 500) return t;
        }
        return '';
      }).catch(() => '');
      if (/0\.0001\b/.test(rowText) && !/0\.001\b/.test(rowText.replace(/0\.0001/g, ''))) {
        console.log(`  row ${i} looks like dust: ${rowText.replace(/\n/g, ' / ').slice(0, 120)}`);
        candidates.push(i);
      }
    }
    if (candidates.length === 0) { console.log('  no 0.0001 row found - done or already exited'); break; }

    const menuItems = page.locator('[role="menuitem"]');
    const exit = menuItems.filter({ hasText: /^Exit$/ });
    let menuUp = false;
    for (const target of candidates) {
      const kebab = kebabs.nth(target);
      for (let attempt = 1; attempt <= 6 && !menuUp; attempt += 1) {
        if (!(await menuItems.first().isVisible().catch(() => false))) {
          await kebab.click().catch(() => {});
          await sleep(1500);
        }
        for (let i = 0; i < 8 && !menuUp; i += 1) {
          menuUp = await exit.first().isVisible().catch(() => false);
          if (!menuUp) await sleep(400);
        }
        if (!menuUp) { await page.keyboard.press('Escape').catch(() => {}); await sleep(4000); }
      }
      if (menuUp) break;
      console.log(`  row ${target}: menu has no Exit (already exited?), trying the next candidate`);
    }
    if (!menuUp) throw new Error('Exit never offered on any dust row');
    await exit.first().click();
    await sleep(4000);
    await shot(`dust-exit-${round}`);
    if (!(await clickButton(page, 'Accept and exit')) && !(await clickButton(page, 'Exit pool'))) {
      throw new Error('no Accept and exit button');
    }
    const settled = await waitForText(page, /Exit Successful|Ragequit failed|reverted/i, 900_000);
    console.log(`  round ${round}: ${settled ?? 'no terminal state'}`);
    if (!/Exit Successful/i.test((await page.evaluate(() => document.body.innerText)))) {
      throw new Error(`dust exit ${round} did not succeed`);
    }
    exited += 1;
    // Back to a clean page for the next round.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(8000);
    await unlockIfPrompted(page);
  }
} finally {
  await browser.close();
}
console.log(`dust deposits exited: ${exited}`);
console.log(`C wallet now: ${formatEther(await client.getBalance({ address: C.address }))} ETH`);
process.exit(exited > 0 ? 0 : 1);
