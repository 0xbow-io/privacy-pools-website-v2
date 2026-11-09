// @ts-nocheck - drives a real browser with real playwright types.
//
// The Swap tab names the coin, never the share: the "You swap" chip reads USDC
// (and the receive chip USDT) while the share rate is still loading and after
// it has loaded, also after the pair is reversed, and with an amount typed. The
// share-name guard reads the Swap page, dialogs and toasts throughout.
//
// It also watches the approval line: a session that has just opened Swap must
// never say its notes are not approved (DEV-590). With the fresh wallet here
// there are no notes, so this is the empty-account half of that rule; the
// verdict over real approved notes and the receive figure after a refused
// minimum need a shielded balance, and are pinned by the unit suite
// (swap-note-approval, swap-note-shortfall, swap-review-share-names).
//
// Prod world, read-only wallet (./harness.ts): nothing is ever sent.
import { check, connect, finish, hold, hubTab, isShareRateRead, launch, open, sleep } from './harness.ts';

const SWAP = '[data-testid="hub-page-swap"]:not([aria-hidden="true"])';
const COIN = /^(USDC|USDT|ETH|BNB)$/;
const NOT_APPROVED = /not approved|aren.t approved|waiting (for|on) (approval|the ASP)|pending approval/i;

const s = await launch('swap-tab', { guardScope: `${SWAP}, [role="dialog"], [role="alert"], [role="status"]` });
const { page } = s;
const rate = await hold(page, isShareRateRead);
const approvalLines: string[] = [];

async function chips(): Promise<{ from: string; to: string }> {
  const read = async (id: string) =>
    (((await page.locator(`${SWAP} [data-testid="${id}"]`).first().innerText().catch(() => '')) ?? '').match(/[A-Za-z0-9.]+/g) ?? []).join(' ');
  return { from: await read('hub-withdraw-pool'), to: await read('hub-swap-out-token') };
}

/**
 * DEV-621 on the Swap tab: every dollar figure on the page has two decimals and
 * no count stands under a coin label ("≈ 4.94 USDT"), while the rate loads and
 * after. The pool header against the home pool row needs a held position, which
 * this wallet does not have: services/__tests__/dev621-no-count.test.ts pins it.
 */
async function figures(where: string) {
  const text = (await page.locator(SWAP).first().innerText().catch(() => '')) ?? '';
  const found = text.match(/(?<![\w.])\$\d[\d,]*(?:\.\d+)?[kKmMbB]?/g) ?? [];
  const bad = [...new Set(found.filter((f) => !/^\$\d[\d,]*\.\d{2}$|^\$\d[\d,]*(?:\.\d{1,2})?[kKmMbB]$/.test(f)))];
  check(bad.length === 0, `${where}: every dollar figure on the Swap tab has two decimals`, bad.slice(0, 4).join(' '));
  const count = /≈\s*\d[\d,]*(?:\.\d+)?\s+(ETH|USDC|USDT)\b/.exec(text);
  check(!count, `${where}: no count under a coin label on the Swap tab`, count?.[0] ?? '');
  const stable = /(?<![\d.])\d[\d,]*\.\d{3,}\s+(USDC|USDT)\b/.exec(text);
  check(!stable, `${where}: stablecoin figures on the Swap tab have two decimals`, stable?.[0] ?? '');
}

async function watchApproval(ms: number) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const text = (await page.locator(SWAP).first().innerText().catch(() => '')) ?? '';
    const m = NOT_APPROVED.exec(text);
    if (m) approvalLines.push(text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' '));
    await sleep(500);
  }
}

try {
  await open(page, '/?action=swap');
  check(await connect(page), 'the read-only wallet connects');
  await sleep(3000);
  check(await hubTab(page, 'swap'), 'the Swap tab opens');
  await watchApproval(4000);

  const pending = await chips();
  check(COIN.test(pending.from), 'rate loading: the "You swap" chip names the coin', JSON.stringify(pending.from));
  check(pending.from === 'USDC', 'rate loading: the default "You swap" chip is USDC', JSON.stringify(pending.from));
  check(COIN.test(pending.to), 'rate loading: the receive chip names the coin', JSON.stringify(pending.to));
  await s.guardStep('swap, rate loading');
  check(rate.held() > 0, 'the share-rate reads were held', `${rate.held()} held`);

  const field = page.locator(`${SWAP} input[placeholder="0"], ${SWAP} input[placeholder="0.0"]`).first();
  await field.fill('0.5').catch(() => {});
  await sleep(2000);
  await s.guardStep('swap, rate loading, amount typed');
  await figures('rate loading');

  rate.release();
  await sleep(6000);
  await watchApproval(6000);
  const loaded = await chips();
  check(loaded.from === 'USDC', 'rate loaded: the "You swap" chip still reads USDC', JSON.stringify(loaded.from));
  check(COIN.test(loaded.to), 'rate loaded: the receive chip names the coin', JSON.stringify(loaded.to));
  await s.guardStep('swap, rate loaded, amount typed');
  await figures('rate loaded');

  const reverse = page.locator(`${SWAP} [data-testid="hub-swap-reverse"]`).first();
  if (await reverse.isVisible().catch(() => false)) {
    await reverse.click().catch(() => {});
    await sleep(3000);
    const reversed = await chips();
    check(COIN.test(reversed.from) && COIN.test(reversed.to), 'reversed: both chips name coins', JSON.stringify(reversed));
    await s.guardStep('swap, reversed');
  }
  await s.shot('swap');
  check(approvalLines.length === 0, 'opening Swap never says the notes are not approved', [...new Set(approvalLines)].slice(0, 2).join(' | '));
  check(s.refusedSends.length === 0, 'nothing asked the wallet to send', s.refusedSends.join(', '));
} catch (e) {
  check(false, 'the smoke ran to the end', String(e).slice(0, 300));
}
await finish('swap tab', s.browser);
