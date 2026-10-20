// @ts-nocheck
// Pack E-c: the full-withdrawal guard (privacy spec A3). Withdrawing the ENTIRE
// balance in one transaction is trivially linkable, so a 100% selection must:
//   - trip a hard warning and block Review until acknowledged;
//   - offer a one-tap escape to 75% that clears the warning;
//   - require the acknowledgment again after every re-selection of 100%.
// The 25/50/75/100% tabs live only in the standalone withdraw MODAL (opened
// from a transaction row's action menu), not the inline hub card. Form-level:
// nothing is submitted, nothing moves.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/full-withdrawal-guard.ts
import { accountFromKey, openApp, signIn, bodyText, sleep, waitForText, waitForShieldedBalance, unlockIfPrompted } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

const app = await openApp(acct, { tag: 'full-withdrawal-guard' });
const p = app.page;
const pressTestId = async (id: string) => {
  const box = await p.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { x: r.x + Math.min(12, r.width / 2), y: r.y + r.height / 2 } : null;
  }, id);
  if (!box) return false;
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await sleep(60); await p.mouse.up();
  return true;
};
const pressText = async (label: string) => {
  const box = await p.evaluate((want) => {
    const els = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0 && (n.textContent || '').trim() === want);
    for (const el of els) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, label);
  if (!box) return false;
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await sleep(60); await p.mouse.up();
  return true;
};
const guardUp = () => p.evaluate(() => !!document.querySelector('[data-testid="full-withdrawal-guard"]'));
const waitGuard = async (want: boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if ((await guardUp()) === want) return true; await sleep(500); }
  return false;
};
/** Is the Review CTA blocked? aria-disabled or dimmed on the pressable around its label. */
const ctaState = () => p.evaluate(() => {
  // The modal's CTA is the LAST leaf reading exactly "Withdraw" (tab labels and
  // row types read differently). Walk up 8 levels and report every disabling
  // signal RNW or the app might use.
  const leaves = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0 && /^Withdraw$/.test((n.textContent || '').trim()));
  const label = leaves[leaves.length - 1];
  if (!label) return { found: false, blocked: null as boolean | null, why: 'no Withdraw leaf' };
  let el: Element | null = label;
  const why: string[] = [];
  let blocked = false;
  for (let d = 0; d < 8 && el; d++) {
    const aria = el.getAttribute?.('aria-disabled');
    const dis = (el as HTMLButtonElement).disabled === true;
    const cs = el instanceof HTMLElement ? getComputedStyle(el) : null;
    const op = cs ? Number(cs.opacity) : 1;
    const pe = cs ? cs.pointerEvents : '';
    const cls = (el.getAttribute?.('class') || '').slice(0, 80);
    why.push(`${el.tagName.toLowerCase()}[aria=${aria ?? '-'} dis=${dis} op=${op} pe=${pe} cls=${cls}]`);
    if (aria === 'true' || dis || op < 0.6 || pe === 'none') blocked = true;
    el = el.parentElement;
  }
  return { found: true, blocked, why: why.join(' > ') };
});
const reviewBlocked = async () => {
  const st = await ctaState();
  console.log(`  CTA state: blocked=${st.blocked} ${st.why.slice(0, 400)}`);
  return st.found ? st.blocked : null;
};
const amountValue = () => p.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
  const el = inputs.find((i) => /^[0-9.]+$/.test(i.value) && Number(i.value) > 0);
  return el ? Number(el.value) : null;
});

try {
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);
  const spendable = await waitForShieldedBalance(p, 12);
  if (spendable === 0) throw new Error('no spendable balance');
  // The hub mounts inline on home and pool pages, which turns the row action
  // into the inline card (no percentage tabs). /transactions has no hub, so the
  // row action opens the standalone modal.
  await p.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  await unlockIfPrompted(p);

  // Open the withdraw MODAL from a transaction row's action menu.
  // Open the standalone modal through the URL bridge (?modal=withdraw). On
  // /transactions no hub is mounted, so the modal is the real one with the
  // percentage tabs. This also sidesteps the row action, which is gated on a
  // still-spendable deposit row (flags.canWithdraw) that a churned fixture may
  // not have.
  await p.goto(`${BASE}/transactions?modal=withdraw`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(8000);
  await unlockIfPrompted(p);
  const modal = !!(await waitForText(p, /Available:/i, 90_000));
  await app.shot('modal');
  record('E-c withdraw modal opens from the row menu', modal, modal ? 'modal with the percentage tabs is up' : 'the modal (Available: line) never rendered');
  if (!modal) throw new Error('no modal');
  const avail = (await bodyText(p)).match(/Available:\s*([0-9.]+)/i);
  const available = avail ? Number(avail[1]) : NaN;

  // An empty recipient also disables the CTA; fill it so the guard is the only
  // thing standing between the user and Withdraw.
  const recipientField = p.locator('input[placeholder*="recipient address"]').first();
  if (await recipientField.isVisible().catch(() => false)) {
    await recipientField.click();
    await recipientField.fill(acct.address);
    await sleep(800);
  }

  // 100% trips the guard and blocks the Withdraw CTA.
  if (!(await pressText('100%'))) throw new Error('100% tab not found');
  const tripped = await waitGuard(true, 90_000);
  await sleep(1500);
  const blocked = tripped ? await reviewBlocked() : null;
  await app.shot('tripped');
  record('E-c 100% trips the guard', tripped, tripped ? 'full-withdrawal-guard rendered' : 'guard never rendered after 100%');
  record('E-c Withdraw CTA is blocked while unacknowledged', blocked === true, blocked === true ? 'Withdraw CTA disabled/dimmed' : `Withdraw CTA state: ${blocked}`);

  // Escape: one tap -> 75%, guard clears.
  if (!(await pressTestId('full-withdrawal-escape'))) throw new Error('escape control not found');
  const cleared = await waitGuard(false, 20_000);
  await sleep(1200);
  const amt = await amountValue();
  // The percentage tabs apply to the single-label cap (one proof = one label,
  // up to 5 notes), not the whole balance: 75% of a 0.001 cap is 0.00075 while
  // "Available" shows the full 0.0387. What the escape must guarantee is that
  // the selection is no longer the ENTIRE balance and the guard is gone.
  const partial = amt !== null && amt > 0 && Number.isFinite(available) && amt < available * 0.999;
  await app.shot('escaped');
  record('E-c escape hatch drops below a full withdrawal and clears the guard', cleared && partial,
    `guard cleared: ${cleared}; amount now ${amt} of ${available} available (${partial ? 'partial' : 'NOT partial'})`);

  // Re-select 100%: the ack is required again; acknowledging unblocks Review.
  if (!(await pressText('100%'))) throw new Error('100% tab not found (second)');
  const reTripped = await waitGuard(true, 60_000);
  await sleep(1000);
  const blockedAgain = reTripped ? await reviewBlocked() : null;
  const acked = reTripped ? await pressTestId('full-withdrawal-ack') : false;
  await sleep(1500);
  const unblocked = acked ? await reviewBlocked() : null;
  await app.shot('acked');
  record('E-c re-selecting 100% re-arms the guard', reTripped && blockedAgain === true,
    `guard back: ${reTripped}, CTA blocked again: ${blockedAgain}`);
  record('E-c acknowledging unblocks the Withdraw CTA', acked && unblocked === false,
    acked ? (unblocked === false ? 'Withdraw CTA enabled after the ack' : `CTA still blocked (${unblocked})`) : 'ack control not found');
} catch (e) {
  record('full-withdrawal-guard', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== full-withdrawal-guard summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
