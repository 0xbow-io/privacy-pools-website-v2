// One-off verification probe: pool-page button removals + stats redesign.
// Needs a dev server on :8081.
import { chromium, type Page } from 'playwright';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const POOL = '/chains/sepolia/eth';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function boot(width: number, height: number, url: string) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 90_000 });
  await page.waitForFunction(() => /Statistics/.test(document.body?.innerText || ''), null, { timeout: 60_000 })
    .catch(() => console.log('  [warn] Statistics never appeared'));
  await page.waitForTimeout(3200);
  return { browser, page };
}

/** Visible leaves whose exact text matches, with geometry. */
const leavesWithText = (page: Page, text: string) => page.evaluate((t) => {
  return Array.from(document.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && (el.textContent || '').trim() === t)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })
    .filter((r) => r.w > 0 && r.h > 0);
}, text);

/** Statistics values: any leaf inside the stats card, with line count. */
const statValues = (page: Page) => page.evaluate(() => {
  const head = Array.from(document.querySelectorAll('*')).find(
    (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Statistics'
      && el.getBoundingClientRect().width > 0,
  );
  if (!head) return null;
  let card: HTMLElement | null = head.parentElement;
  for (let i = 0; i < 6 && card; i++) {
    if (/Pool TVL/.test(card.textContent || '') && /Transfers/.test(card.textContent || '')) break;
    card = card.parentElement;
  }
  if (!card) return null;
  const cr = card.getBoundingClientRect();
  const vals = Array.from(card.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && (el.textContent || '').trim()
      && el.getBoundingClientRect().width > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      return {
        t: (el.textContent || '').trim().slice(0, 22),
        lines: Math.round((r.height / lh) * 10) / 10,
        size: parseFloat(cs.fontSize),
      };
    });
  return { cardH: Math.round(cr.height), cardBottom: Math.round(cr.bottom), vals };
});

const ACTIONS = ['Deposit', 'Withdraw', 'Transfer', 'Request'];

/**
 * Which of `words` appear as leaves inside the element carrying `testId`.
 *
 * Scoped by testID, not by walking up from a text node: that walk stopped at
 * whichever inner block first exceeded a size threshold (the amount box, the
 * balance block), so it silently excluded the very button row under test and
 * returned [] for both "removed" and "kept" — passing and failing for the same
 * wrong reason.
 */
const wordsIn = (page: Page, testId: string, words: string[]) => page.evaluate(({ testId, words }) => {
  const card = document.querySelector(`[data-testid="${testId}"]`);
  if (!card) return { found: null as string[] | null, cardFound: false };
  const found = Array.from(card.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && words.includes((el.textContent || '').trim())
      && el.getBoundingClientRect().width > 0)
    .map((el) => (el.textContent || '').trim());
  return { found, cardFound: true };
}, { testId, words });

const hasTestId = (page: Page, testId: string) =>
  page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), testId);

async function desktopSplit() {
  console.log('\n=== POOL PAGE desktop split (vault 1440) ===');
  const { browser, page } = await boot(1440, 1000, `${BASE}${POOL}?theme=1`);

  // 1. Manage must be gone (it pointed at this very page).
  check('no "Manage" button on the pool\'s own page', (await leavesWithText(page, 'Manage')).length === 0,
    `${(await leavesWithText(page, 'Manage')).length} found`);

  // 2+3. The action row is gone from the balance card and from My Privacy
  // Pools; the shield widget in the left column is the only place left.
  check('balance card is present (so the next check is not vacuous)',
    await hasTestId(page, 'pool-balance-card'));
  check('balance-card action row GONE in the split',
    !(await hasTestId(page, 'pool-balance-actions')));
  const bal = await wordsIn(page, 'pool-balance-card', ACTIONS);
  check('no action words anywhere in the balance card', bal.cardFound && bal.found?.length === 0,
    JSON.stringify(bal.found));
  const mine = await wordsIn(page, 'my-privacy-pools-card', ACTIONS);
  check('My Privacy Pools card present and free of action buttons',
    mine.cardFound && mine.found?.length === 0, `cardFound=${mine.cardFound} ${JSON.stringify(mine.found)}`);
  check('the shield widget still offers its actions',
    await page.evaluate(() => /Withdraw/.test(document.body.innerText) && /Request/.test(document.body.innerText)));

  // 4/5. Statistics: compact, nothing wrapped.
  const st = await statValues(page);
  check('statistics card found', !!st, st ? `h=${st.cardH}` : 'none');
  if (st) {
    const wrapped = st.vals.filter((v) => v.lines > 1.5);
    check('no statistic wraps onto a second line', wrapped.length === 0, JSON.stringify(wrapped));
    check('no giant figures left (<=20px)', st.vals.every((v) => v.size <= 20),
      JSON.stringify(st.vals.filter((v) => v.size > 20)));
    check('card is compact (was 360px floor)', st.cardH < 330, `${st.cardH}px`);
  }

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow', noOverflow);
  await page.screenshot({ path: 'scripts/visual/reports/probe-cleanup-desktop.png' });
  await browser.close();
}

async function mobile() {
  console.log('\n=== POOL PAGE mobile (vault 390x844) ===');
  const { browser, page } = await boot(390, 844, `${BASE}${POOL}?theme=1`);

  check('no "Manage" on mobile either', (await leavesWithText(page, 'Manage')).length === 0);

  // Item 3: the balance card's action row is KEPT on mobile.
  check('balance-card action row KEPT on mobile', await hasTestId(page, 'pool-balance-actions'));
  const balM = await wordsIn(page, 'pool-balance-actions', ACTIONS);
  check('all four actions present in it', (balM.found?.length ?? 0) >= 4, JSON.stringify(balM.found));
  const mineM = await wordsIn(page, 'my-privacy-pools-card', ACTIONS);
  check('My Privacy Pools still has none on mobile',
    mineM.cardFound && mineM.found?.length === 0, `cardFound=${mineM.cardFound} ${JSON.stringify(mineM.found)}`);

  const st = await statValues(page);
  check('statistics card found on mobile', !!st, st ? `h=${st.cardH} bottom=${st.cardBottom}` : 'none');
  if (st) {
    const wrapped = st.vals.filter((v) => v.lines > 1.5);
    check('no statistic wraps on mobile', wrapped.length === 0, JSON.stringify(wrapped));
    check('stats card materially shorter than before (<300px)', st.cardH < 300, `${st.cardH}px`);
    // The complaint was the card being cut off. It must fit inside the scrollable
    // content, i.e. its own height must be less than the viewport.
    check('card fits within a phone viewport (not clipped)', st.cardH < 844 - 100, `${st.cardH}px vs 844 viewport`);
  }

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow on mobile', noOverflow);
  await page.screenshot({ path: 'scripts/visual/reports/probe-cleanup-mobile.png', fullPage: true });
  await browser.close();
}

async function myPoolsNumbers() {
  console.log('\n=== My Privacy Pools numbers (home panel, 1440) ===');
  const { browser, page } = await boot(1440, 1000, `${BASE}/?theme=1&panel=balances`);
  const strip = await page.evaluate(() => {
    const head = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && /^My Privacy Pools/.test((el.textContent || '').trim())
        && el.getBoundingClientRect().width > 0,
    );
    if (!head) return null;
    let card: HTMLElement | null = head.parentElement;
    for (let i = 0; i < 7 && card; i++) {
      if (/Total balance/i.test(card.textContent || '')) break;
      card = card.parentElement;
    }
    if (!card) return null;
    const vals = Array.from(card.querySelectorAll('*'))
      .filter((el) => el.children.length === 0 && (el.textContent || '').trim()
        && el.getBoundingClientRect().width > 0)
      .map((el) => ({
        t: (el.textContent || '').trim().slice(0, 20),
        size: parseFloat(getComputedStyle(el).fontSize),
      }));
    return vals;
  });
  check('My Privacy Pools numbers found', !!strip && strip.length > 0);
  if (strip) {
    check('no 24px figures left in the strip', strip.every((v) => v.size <= 20),
      JSON.stringify(strip.filter((v) => v.size > 20)));
    check('labels are present and small', strip.some((v) => /balance/i.test(v.t)));
  }
  const inCard = await wordsIn(page, 'my-privacy-pools-card', ACTIONS);
  check('no action bar inside the My Privacy Pools panel',
    inCard.cardFound && inCard.found?.length === 0, `cardFound=${inCard.cardFound} ${JSON.stringify(inCard.found)}`);
  await page.screenshot({ path: 'scripts/visual/reports/probe-cleanup-mypools.png' });
  await browser.close();
}

await desktopSplit();
await mobile();
await myPoolsNumbers();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
