// @ts-nocheck
// Pack L-a / L-b: failure injection by request interception. Nothing moves.
//   L-a  relayer unreachable: Send/Withdraw must NAME the relayer as the
//        problem (never a bare "Transfer failed") and Send must still offer
//        (the "Hide my wallet" escape hatch was removed 2026-08-29: every send is relayed).
//   L-b  ASP unreachable at app load: the app must not be a dead UI - it must
//        render and explain; the leg documents what it shows.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/outage.ts
import { accountFromKey, openApp, signIn, tab, bodyText, sleep, waitForText, fillRecipient, enterAmount, unlockIfPrompted, submitOrPast, clickButton } from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
const other = '0x6A7DafCB5483Da70F5eDee1481A29C2004Cc3c81';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};

const app = await openApp(acct, { tag: 'outage' });
const p = app.page;
const pageErrors: string[] = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
try {
  // ---- L-a: relayer unreachable ----------------------------------------------
  let blockedRelayer = 0;
  await p.context().route((url) => /relayer/i.test(new URL(url.toString()).hostname), (route) => { blockedRelayer += 1; route.abort('connectionrefused'); });
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);

  // Send: the quote fails; the form must name the relayer and keep the escape hatch.
  if (!(await tab(p, 'Send'))) throw new Error('Send tab never became active');
  await fillRecipient(p, other, 'Send');
  await enterAmount(p, '0.0002', 'Send');
  // OUTAGE-shaped copy only. The form's own hint ("The relayer fee is added on
  // top of the amount you entered.") also contains "relayer" and made the
  // first version of this leg pass vacuously - same trap as the withdraw
  // matcher (2026-08-27). Require the sentence to say something went wrong.
  const OUTAGE = /relayer[^\n]{0,80}(unavailable|unreachable|failed|could not|couldn|not available|no relayer|down|offline|try again|error)|(All configured relayers|No relayer)[^\n]*/i;
  // The fee is "Quoted at review", so the outage can only surface after
  // pressing Review. With the relayer blocked nothing can ever be broadcast.
  // The CTA is disabled while the debounced quote is in flight (8s transport
  // timeout), and clickButton refuses a disabled pressable, so wait for it.
  let pressedReview = false;
  for (let i = 0; i < 30 && !pressedReview; i += 1) {
    for (const label of ['Review Transfer', 'Review transfer', 'Send privately']) {
      if (await clickButton(p, label)) { pressedReview = true; console.log(`  pressed ${label} after ${i * 2}s`); break; }
    }
    if (!pressedReview) await sleep(2000);
  }
  await sleep(3000);
  await unlockIfPrompted(p);
  for (const label of ['Confirm transfer', 'Confirm']) { if (await clickButton(p, label)) break; }
  const sendSaid = await waitForText(p, OUTAGE, 150_000);
  const sendBody = sendSaid ?? await bodyText(p);
  const outageLine = sendBody.match(OUTAGE)?.[0] ?? null;
  const bareFailed = /Transfer failed(?![^\n]*relayer)/i.test(sendBody);
  // A dead CTA with no message is the worst outcome of an outage: report it.
  const cta = await p.evaluate(() => {
    const leaves = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0 && /^Review Transfer$/i.test((n.textContent || '').trim()));
    const label = leaves[leaves.length - 1];
    if (!label) return 'no CTA';
    let el: Element | null = label;
    for (let d = 0; d < 8 && el; d++) {
      if (el.getAttribute?.('aria-disabled') === 'true') return 'disabled';
      el = el.parentElement;
    }
    return 'enabled';
  });
  console.log(`  send CTA state after the review press: ${cta}`);
  await app.shot('send-relayer-down');
  console.log(`  send lines mentioning relayer/quote: ${(sendBody.match(/[^\n]*(relayer|quote)[^\n]*/gi) ?? []).join(' | ').slice(0, 400)}`);
  record('L-a Send names the relayer outage, not "Transfer failed"', !!outageLine && !bareFailed && blockedRelayer > 0,
    `relayer requests blocked: ${blockedRelayer}; outage copy: ${outageLine ? `"${outageLine.slice(0, 120)}"` : 'NONE'}; bare "Transfer failed": ${bareFailed}; CTA ${cta}`);

  // Withdraw: same expectation on the quote.
  if (!(await tab(p, 'Withdraw'))) throw new Error('Withdraw tab never became active');
  await fillRecipient(p, acct.address, 'Withdraw');
  await enterAmount(p, '0.0002', 'Withdraw');
  await submitOrPast(p, ['Review withdrawal', 'Withdraw', 'Review']).catch(() => 'stuck');
  await sleep(3000);
  await unlockIfPrompted(p);
  for (const label of ['Confirm withdrawal', 'Confirm']) { if (await clickButton(p, label)) break; }
  const wdSaid = await waitForText(p, OUTAGE, 150_000);
  const wdBody = wdSaid ?? await bodyText(p);
  const wdOutage = wdBody.match(OUTAGE)?.[0] ?? null;
  await app.shot('withdraw-relayer-down');
  console.log(`  withdraw lines mentioning relayer/quote: ${(wdBody.match(/[^\n]*(relayer|quote)[^\n]*/gi) ?? []).join(' | ').slice(0, 400)}`);
  // The card's "Withdrawal Failed" heading is fine WHEN the body names the
  // outage; only a heading with no outage copy is the bare failure.
  const wdBare = !wdOutage && /Withdrawal failed/i.test(wdBody);
  record('L-a Withdraw names the relayer outage', !!wdOutage && !wdBare,
    `outage copy: ${wdOutage ? `"${wdOutage.slice(0, 120)}"` : 'NONE'}; bare "Withdrawal failed": ${wdBare}`);
  await p.context().unroute(() => true).catch(() => {});

  // ---- L-b: ASP unreachable at load ---------------------------------------------
  const ctx = await app.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let blockedAsp = 0;
  await ctx.route((url) => /0xbow\.io/i.test(new URL(url.toString()).hostname), (route) => { blockedAsp += 1; route.abort('connectionrefused'); });
  const anon = await ctx.newPage();
  const anonErrors: string[] = [];
  anon.on('pageerror', (e) => anonErrors.push(e.message));
  await anon.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(15_000);
  const aspBody = await bodyText(anon);
  await anon.screenshot({ path: '.e2e-shots/outage-asp-down.png' }).catch(() => {});
  const rendered = aspBody.trim().length > 200;
  const explained = /unavailable|unreachable|could not|couldn|try again|offline|failed to load|error/i.test(aspBody);
  record('L-b ASP unreachable at load: app still renders, no uncaught errors', rendered && anonErrors.length === 0 && blockedAsp > 0,
    `ASP requests blocked: ${blockedAsp}; body chars: ${aspBody.length}; page errors: ${anonErrors.length}`);
  record('L-b ASP outage is explained on screen (documented)', explained,
    explained ? `copy: "${(aspBody.match(/[^\n]*(unavailable|unreachable|could not|couldn|try again|offline|failed to load|error)[^\n]*/i)?.[0] ?? '').slice(0, 160)}"` : 'no explanatory copy found (documenting: the app rendered silently)');
  await ctx.close();
} catch (e) {
  record('outage', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== outage summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
