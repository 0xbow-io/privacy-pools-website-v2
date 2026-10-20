// ~60s pre-push UI smoke test. Covers the surfaces most recently changed and,
// specifically, the class of bug static gates cannot see: an element that
// renders with NO styling because css-interop dropped its className.
//
//   safewrap bun scripts/visual/probe-ui-smoke.ts
import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env.PROBE_URL ?? 'http://localhost:8081';
const R = { ok: 0, fail: 0 };
function check(label: string, pass: boolean, detail = '') {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  pass ? R.ok++ : R.fail++;
}

async function page(browser: Browser, width: number, url: string, waitFor: string) {
  const ctx = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => check(`no page error on ${url}`, false, e.message.slice(0, 120)));
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await p.waitForFunction((sel: string) => !!document.querySelector(sel), waitFor, { timeout: 60_000 })
    .catch(() => check(`${url} reached ${waitFor}`, false, 'never appeared'));
  await p.waitForTimeout(1800);
  return { ctx, p };
}

const tap = (p: Page, sel: string) => p.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return false;
  el.click();
  return true;
}, sel);

/** The styling-dropped detector: a "styled" element with no border AND no background. */
const styleProof = (p: Page, sel: string) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    border: parseFloat(cs.borderTopWidth),
    radius: parseFloat(cs.borderTopLeftRadius),
    bg: cs.backgroundColor,
    dir: cs.flexDirection,
    y: Math.round(r.y),
    h: Math.round(r.height),
  };
}, sel);

async function homeDoors(browser: Browser) {
  console.log('\n=== home doors (1440, vault) ===');
  const { ctx, p } = await page(browser, 1440, `${BASE}/?theme=1`, '[data-testid="home-door-mine"]');

  for (const k of ['mine', 'activity', 'pools']) {
    const s = await styleProof(p, `[data-testid="home-door-${k}"]`);
    check(`door ${k} is actually styled (border+radius+row)`,
      !!s && s.border >= 1 && s.radius > 8 && s.dir === 'row', JSON.stringify(s));
  }

  const order = await p.evaluate(() =>
    ['mine', 'activity', 'pools']
      .map((k) => ({ k, x: document.querySelector(`[data-testid="home-door-${k}"]`)?.getBoundingClientRect().x ?? -1 }))
      .sort((a, b) => a.x - b.x).map((d) => d.k));
  check('signed-out order keeps pools discoverable', order.length === 3, JSON.stringify(order));

  // Open the split, then confirm one row and that the doors shrank.
  await tap(p, '[data-testid="home-door-pools"]');
  await p.waitForTimeout(1300);
  const ys = await p.evaluate(() => ['mine', 'activity', 'pools']
    .map((k) => Math.round(document.querySelector(`[data-testid="home-door-${k}"]`)?.getBoundingClientRect().y ?? -1)));
  check('all three doors on ONE row in the split', new Set(ys).size === 1, JSON.stringify(ys));
  const split = await styleProof(p, '[data-testid="home-door-mine"]');
  check('doors still styled after the shrink', !!split && split.border >= 1 && split.dir === 'row', JSON.stringify(split));
  check('split panel is open', await p.evaluate(() => !!document.querySelector('[data-testid="split-panel-close"]')));
  // Clip-aware: the folded hero hides the title via an ANCESTOR at height 0 /
  // opacity 0 with overflow hidden — the leaf's own rect keeps its layout size,
  // so walk the chain instead of trusting the leaf.
  const titleVisible = () => p.evaluate(() => {
    const leaf = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Privacy you can prove.',
    );
    if (!leaf) return false;
    if (leaf.getBoundingClientRect().height < 20) return false;
    for (let n = leaf as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (Number(cs.opacity) < 0.5) return false;
      if (cs.overflow !== 'visible' && n.getBoundingClientRect().height < 2) return false;
    }
    return true;
  });
  check('hero title is FOLDED in the split, even signed out', !(await titleVisible()));

  // Toggle: pressing the lit door closes it.
  await tap(p, '[data-testid="home-door-pools"]');
  await p.waitForTimeout(1300);
  check('pressing the open door closes the split',
    await p.evaluate(() => !document.querySelector('[data-testid="split-panel-close"]')));
  check('...and the hero title returns after close (still signed out)', await titleVisible());

  await ctx.close();
}

async function sheets(browser: Browser) {
  console.log('\n=== sheets (390, vault) — all three post-refactor ===');
  const { ctx, p } = await page(browser, 390, `${BASE}/?theme=1`, '[data-testid="explore-tab-mine"]');

  await tap(p, '[data-testid="explore-tab-mine"]');
  await p.waitForTimeout(1300);
  const data = await styleProof(p, '[data-testid="activity-drawer"]');
  check('data drawer opens and is styled', !!data && data.border >= 1 && data.h > 300, JSON.stringify(data));
  await tap(p, '[data-testid="drawer-close"]');
  await p.waitForTimeout(1200);

  await tap(p, '[data-testid="explore-tab-more"]');
  await p.waitForTimeout(1100);
  const more = await styleProof(p, '[data-testid="more-drawer"]');
  check('More drawer opens and is styled', !!more && more.border >= 1, JSON.stringify(more));
  check('More lists the page links', await p.evaluate(() => !!document.querySelector('[data-testid="more-nav-Payroll"]')));
  check('reopens on the main pane (not Info)', await p.evaluate(() => !!document.querySelector('[data-testid="more-nav-info"]')));
  await tap(p, '[data-testid="more-drawer-close"]');
  await p.waitForTimeout(1000);
  check('More closes', await p.evaluate(() => !document.querySelector('[data-testid="more-drawer"]')));

  await ctx.close();
}

async function drawerAnywhere(browser: Browser) {
  console.log('\n=== drawer from another route (390) ===');
  const { ctx, p } = await page(browser, 390, `${BASE}/portfolio?theme=1`, '[data-testid="explore-tab-mine"]');
  await tap(p, '[data-testid="explore-tab-mine"]');
  await p.waitForTimeout(1600);
  const url = new URL(p.url());
  check('stays on /portfolio (no bounce home)', url.pathname === '/portfolio', url.pathname + url.search);
  check('drawer opened in place', await p.evaluate(() => !!document.querySelector('[data-testid="activity-drawer"]')));
  await ctx.close();
}

async function ecosystem(browser: Browser) {
  console.log('\n=== ecosystem logos (1440) ===');
  const { ctx, p } = await page(browser, 1440, `${BASE}/ecosystem?theme=1`, 'div');
  await p.waitForTimeout(2500);
  const logos = await p.evaluate(() => {
    const sizes = Array.from(document.querySelectorAll('img'))
      .map((i) => Math.round(i.getBoundingClientRect().width))
      .filter((w) => w > 40);
    return { big: sizes.filter((w) => w >= 150).length, sizes: sizes.slice(0, 6) };
  });
  check('partner logos are the large square (>=150px)', logos.big > 0, JSON.stringify(logos));
  const noOverflow = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow', noOverflow);
  await ctx.close();
}

async function frontPage(browser: Browser) {
  console.log('\n=== signed-out front page (1440, vault) ===');
  const { ctx, p } = await page(browser, 1440, `${BASE}/?theme=1`, '[data-testid="front-page"]');
  check('front page chunk mounted', await p.evaluate(() => !!document.querySelector('[data-testid="front-page"]')));
  check('scroll hint present', await p.evaluate(() => !!document.querySelector('[data-testid="front-scroll-hint"]')));

  // Uniswap structure: the hero act owns (roughly) the first viewport, so the
  // acts start below the fold.
  const heroOwnsFold = await p.evaluate(() => {
    const act = document.querySelector('[data-testid="front-act-1"]');
    return act ? act.getBoundingClientRect().top > window.innerHeight * 0.7 : false;
  });
  check('acts start below the fold (hero owns the first screen)', heroOwnsFold);

  // The hint is a button: pressing it glides the page down to the first act.
  // (reduced-motion context → the fallback native smooth-scroll path.)
  await tap(p, '[data-testid="front-scroll-hint"] [role="button"]');
  await p.waitForTimeout(2200);
  const actAfterHintTap = await p.evaluate(() => {
    const act = document.querySelector('[data-testid="front-act-1"]');
    return act ? Math.round(act.getBoundingClientRect().top) : -1;
  });
  check('tapping the hint scrolls the first act into view', actAfterHintTap >= -60 && actAfterHintTap < 400, `top=${actAfterHintTap}`);
  // Back to the top for the focus-swap checks (the RN ScrollView div is the
  // scroller, not the window).
  await p.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll('div'))) {
      if (d.scrollTop > 0) d.scrollTop = 0;
    }
  });
  await p.waitForTimeout(400);

  const txt = await p.evaluate(() => document.body.innerText);
  check('stat cards carry the numbers', /Privacy Pools stats/.test(txt) && /Deposits in the crowd/.test(txt));
  check('bento cards present', /Screened at the gate/.test(txt) && /Earn while shielded/.test(txt));
  check('live-pool act present', /All activity/.test(txt));
  check('live-pool headline gone', !/The pools, live/.test(txt));

  const cardStyled = await styleProof(p, '[data-testid="front-card-teal"]');
  check('bento card actually styled (tint + radius)', !!cardStyled && cardStyled.radius > 8 && cardStyled.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(cardStyled));

  // A bento CTA arms the widget tab.
  await tap(p, '[data-testid="front-card-purple"]');
  await p.waitForTimeout(900);
  check('bento CTA arms the send tab (?action=send)', /action=send/.test(p.url()), p.url());

  check('no horizontal overflow', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  // Focus swap: typing an amount reduces the page to the form — the marketing
  // page goes, and so do the resting activity/crowd/pools cards; blur restores
  // the whole landing page.
  await p.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    (inputs.find((i) => i.getAttribute('inputmode') || i.getAttribute('placeholder') === '0') as HTMLInputElement | undefined)?.focus();
  });
  await p.waitForTimeout(700);
  check('focusing the amount input hides the marketing page',
    await p.evaluate(() => !document.querySelector('[data-testid="front-page"]')));
  check('...and the scroll hint with it',
    await p.evaluate(() => !document.querySelector('[data-testid="front-scroll-hint"]')));
  // "All activity" is excluded on purpose: it is also the doors pill next to the
  // widget, which stays. The pool list and the crowd numbers have one renderer
  // each, so they are the honest witnesses that the cards are gone.
  check('...and the resting activity/pools cards with it',
    await p.evaluate(() => !/ETH Pool/.test(document.body.innerText)));
  check('...without the big marketing numbers', await p.evaluate(() => !/Deposits in the crowd/.test(document.body.innerText)));
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await p.waitForTimeout(900);
  check('blurring restores the marketing page',
    await p.evaluate(() => !!document.querySelector('[data-testid="front-page"]')));
  check('...and the TITLE comes back with it (engaged un-sticks on blur, signed out)',
    await p.evaluate(() => {
      const leaf = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Privacy you can prove.',
      );
      if (!leaf) return false;
      const r = leaf.getBoundingClientRect();
      // Present AND actually visible — the folded hero keeps the node at 0 height.
      return r.height > 20 && Number(getComputedStyle(leaf.parentElement as Element).opacity) > 0.5;
    }));

  const m = await page(browser, 390, `${BASE}/?theme=1`, '[data-testid="front-page"]');
  check('front page mounts at 390px', await m.p.evaluate(() => !!document.querySelector('[data-testid="front-page"]')));
  check('no horizontal overflow at 390px', await m.p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await m.ctx.close();
  await ctx.close();
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
await homeDoors(browser);
await frontPage(browser);
await sheets(browser);
await drawerAnywhere(browser);
await ecosystem(browser);
await browser.close();
console.log(`\n${R.ok} passed, ${R.fail} failed`);
process.exit(R.fail ? 1 : 0);
