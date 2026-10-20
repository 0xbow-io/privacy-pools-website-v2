// One-off verification probe for the pool-detail split screen.
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
  // Wait for the pool page's own content, not just any paint — measuring
  // before the widget mounts returns null rects and reads as a layout bug.
  await page.waitForFunction(
    () => /Review deposit|Amount to shield/.test(document.body?.innerText || ''),
    null,
    { timeout: 60_000 },
  ).catch(() => console.log('  [warn] neither action widget appeared'));
  await page.waitForTimeout(3500);
  return { browser, page };
}


/**
 * expo-router keeps the previously-rendered screen mounted at zero size, so
 * document-order find() hits the OLD screen's copy of a label first (its whole
 * ancestor chain measures 0). Every query here must skip those or it reports
 * the last page's state as this page's.
 */
const VISIBLE_FIND = `(pred) => Array.from(document.querySelectorAll('*')).find((el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && pred(el);
})`;

/** Rect of the shield widget (the card holding the amount field). */
function shieldRect(page: Page) {
  return page.evaluate(() => {
    const leaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Amount to shield'
        && el.getBoundingClientRect().width > 0,
    );
    if (!leaf) return null;
    let el = leaf as HTMLElement | null;
    for (let i = 0; i < 8 && el; i++) {
      const r = el.getBoundingClientRect();
      if (r.width > 300) return { x: r.x, w: r.width, right: r.right };
      el = el.parentElement;
    }
    return null;
  });
}

function rectOfText(page: Page, text: string) {
  return page.evaluate((t) => {
    const leaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === t
        && el.getBoundingClientRect().width > 0,
    );
    if (!leaf) return null;
    const r = leaf.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width };
  }, text);
}

async function poolSplit() {
  console.log(`\n=== POOL PAGE ${POOL} (vault, 1440x900) ===`);
  const { browser, page } = await boot(1440, 900, `${BASE}${POOL}?theme=1`);

  const shield = await shieldRect(page);
  check('shield widget present on the pool page', !!shield, shield ? `x=${Math.round(shield.x)} w=${Math.round(shield.w)}` : 'missing');
  check('shield widget is on the LEFT half', !!shield && shield.right < 720,
    shield ? `right=${Math.round(shield.right)}` : '');

  // The pool's own data must sit to the right of the widget.
  const myPools = await rectOfText(page, 'My Privacy Pools');
  check('pool data column is on the RIGHT', !!myPools && !!shield && myPools.x > shield.right,
    myPools && shield ? `widget right=${Math.round(shield.right)}, data x=${Math.round(myPools.x)}` : 'not found');

  // The widget must be preset to this pool's asset, not the ETH default by luck:
  // check a non-ETH pool separately below.
  const cta = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && /Shielding |^Shield [A-Z]+$/.test((e.textContent || '').trim())
        && e.getBoundingClientRect().width > 0,
    );
    return el ? (el.textContent || '').trim() : null;
  });
  check('widget CTA targets the pool asset (ETH)', !!cta && cta.includes('ETH'), cta || 'no CTA');

  // The old per-pool action panel must be gone (it lived beside My Privacy Pools).
  const dupes = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      reviewDeposit: (t.match(/Review deposit/g) || []).length,
      amountToShield: (t.match(/Amount to shield/g) || []).length,
    };
  });
  check('no duplicate action widget on the page', dupes.reviewDeposit === 0 && dupes.amountToShield === 1,
    JSON.stringify(dupes));

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow', noOverflow);
  check('transactions table rendered in the column',
    await page.evaluate(() => document.body.innerText.includes('Transactions') || document.body.innerText.includes('TX HASH')));

  await page.screenshot({ path: 'scripts/visual/reports/probe-pool-split.png', fullPage: false });
  await browser.close();
}

async function poolSplitUsdc() {
  console.log('\n=== POOL PAGE /chains/sepolia/usdc — widget must follow the pool ===');
  const { browser, page } = await boot(1440, 900, `${BASE}/chains/sepolia/usdc?theme=1`);
  const cta = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(
      (e) => e.children.length === 0 && /Shielding |^Shield [A-Z]+$/.test((e.textContent || '').trim())
        && e.getBoundingClientRect().width > 0,
    );
    return el ? (el.textContent || '').trim() : null;
  });
  check('widget is seeded with USDC, not the ETH default', !!cta && cta.includes('USDC'), cta || 'no CTA');
  await page.screenshot({ path: 'scripts/visual/reports/probe-pool-split-usdc.png' });
  await browser.close();
}

async function poolNarrowAndClassic() {
  console.log('\n=== FALLBACKS ===');
  // Narrow vault: stacked page, action panel back.
  const narrow = await boot(900, 900, `${BASE}${POOL}?theme=1`);
  const narrowState = await narrow.page.evaluate(() => ({
    hasReviewDeposit: document.body.innerText.includes('Review deposit'),
    hasShieldWidget: document.body.innerText.includes('Amount to shield'),
  }));
  check('900px vault: falls back to the stacked page with its action panel',
    narrowState.hasReviewDeposit && !narrowState.hasShieldWidget, JSON.stringify(narrowState));
  const nOverflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('900px vault: no horizontal overflow', nOverflow);
  await narrow.browser.close();

  // Mono Studio (default): split at 1440 (shield hub, no stacked action
  // panel), stacked fallback below the split threshold.
  {
    const wide = await boot(1440, 900, `${BASE}${POOL}?theme=4`);
    const st = await wide.page.evaluate(() => ({
      hasReviewDeposit: document.body.innerText.includes('Review deposit'),
      hasShieldWidget: document.body.innerText.includes('Amount to shield'),
      rendersPage: document.body.innerText.includes('My Privacy Pools'),
    }));
    check('1440px mono studio: split layout with the shield hub, no stacked action panel',
      !st.hasReviewDeposit && st.hasShieldWidget && st.rendersPage, JSON.stringify(st));
    const o = await wide.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check('1440px mono studio: no horizontal overflow', o);
    await wide.browser.close();
  }
  {
    const c = await boot(900, 900, `${BASE}${POOL}?theme=4`);
    const st = await c.page.evaluate(() => ({
      hasReviewDeposit: document.body.innerText.includes('Review deposit'),
      hasShieldWidget: document.body.innerText.includes('Amount to shield'),
      rendersPage: document.body.innerText.includes('My Privacy Pools'),
    }));
    check('900px mono studio: stacked page with its action panel',
      st.hasReviewDeposit && !st.hasShieldWidget && st.rendersPage, JSON.stringify(st));
    const o = await c.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check('900px mono studio: no horizontal overflow', o);
    await c.browser.close();
  }
}

await poolSplit();
await poolSplitUsdc();
await poolNarrowAndClassic();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
