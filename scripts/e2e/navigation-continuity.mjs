// Run against build:web served as an SPA, not Metro development mode:
// PROBE_URL=http://localhost:8087 node scripts/e2e/navigation-continuity.mjs
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { installLandingWallet } from './fixtures/landing-wallet.mjs';

const base = process.env.PROBE_URL ?? 'http://localhost:8087';
const header = page => page.locator('[data-testid="site-header"]:visible:not([aria-hidden="true"] *)');
const tab = (page, path) => header(page).getByTestId(`navbar-item-${path}`);

async function capture(page) {
  await page.evaluate(() => {
    window.navigationFrames = [];
    window.captureNavigation = true;
    const visible = node => node.getBoundingClientRect().width > 0 && !node.closest('[aria-hidden="true"]');
    const sample = () => {
      if (!window.captureNavigation) return;
      const headers = [...document.querySelectorAll('[data-testid="site-header"]')].filter(visible);
      const widgets = [...document.querySelectorAll('.landing-entrance-widget')].filter(visible);
      window.navigationFrames.push({
        headers: headers.map(node => {
          const row = node.querySelector('[data-testid="navbar-tabs"]');
          const pill = node.querySelector('[data-testid="navbar-highlight"]');
          return { x: row.getBoundingClientRect().x, y: row.getBoundingClientRect().y,
            pillWidth: pill.getBoundingClientRect().width, opacity: Number(getComputedStyle(pill).opacity) };
        }),
        widgets: widgets.map(node => Number(getComputedStyle(node).opacity)),
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
}

async function assertContinuity(page, label, { firstHomeVisit = false } = {}) {
  const frames = await page.evaluate(() => {
    window.captureNavigation = false;
    return window.navigationFrames;
  });
  assert.ok(frames.length > 2, `${label}: captured rendered frames`);
  // Do not drop empty frames: those are the production route-loading bug.
  assert.ok(frames.every(frame => frame.headers.length === 1),
    `${label}: blank/duplicate header frames ${JSON.stringify(frames.filter(frame => frame.headers.length !== 1))}`);
  const origin = frames[0].headers[0];
  assert.ok(frames.every(frame => frame.headers.every(h =>
    Math.abs(h.x - origin.x) <= 1 && Math.abs(h.y - origin.y) <= 1 && h.pillWidth > 0 && h.opacity === 1)),
  `${label}: navbar stays visible and stationary`);
  assert.ok(firstHomeVisit || frames.every(frame => frame.widgets.every(opacity => opacity === 1)),
    `${label}: returning to Home must not replay its entrance (${Math.min(...frames.flatMap(frame => frame.widgets))})`);
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch();
  try {
    // UI history must preserve drafts, while real route history still works.
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await installLandingWallet(page);
      await page.route('**/global/public/events?**', route => route.fulfill({
        json: { page: 1, perPage: 100, total: 0, events: [] },
      }));
      await page.goto(base);
      await header(page).getByText('Connect Wallet', { exact: true }).click();
      const walletChoice = page.getByRole('button', { name: 'Landing Test Wallet Browser' });
      await walletChoice.waitFor();
      await page.goBack();
      await walletChoice.waitFor({ state: 'hidden' });
      await page.goForward();
      await walletChoice.waitFor();
      await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
      await header(page).getByTestId('notification-bell').waitFor();
      const visible = id => page.getByTestId(id).filter({ visible: true });
      const amount = () => visible('home-action-column').locator('input:visible').first();
      await amount().fill('123');
      await amount().blur();
      await visible('home-action-column').evaluate(node => { window.originalDraftForm = node; });
      await visible('home-door-mine').click();
      for (const [direction, panel] of [['goBack', null], ['goForward', 'balances']]) {
        await page[direction]();
        await page.waitForFunction(expected => new URLSearchParams(location.search).get('panel') === expected, panel);
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => window.originalDraftForm.isConnected), true, `${name}: ${direction} retains Home`);
        assert.equal(await amount().inputValue(), '123', `${name}: ${direction} preserves the draft amount`);
        assert.equal(await visible('split-panel-close').count(), panel ? 1 : 0);
      }
      await visible('split-panel-close').click();
      await page.waitForFunction(() => !new URLSearchParams(location.search).has('panel'));
      await tab(page, '/explore').click();
      await page.waitForURL(url => url.pathname === '/explore');
      await page.goBack();
      await page.waitForURL(url => url.pathname === '/');
      assert.equal(await amount().inputValue(), '123', 'Real route Back preserves the draft too');
      await page.close();
      console.log(`PASS ${name}: panel Back/Forward preserves form identity and entered amount`);
    }

    // A pool chooses its chain while active, then releases global selection
    // on departure even though the navigator retains its mounted screen.
    {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(new URL('/chains/ethereum/eth', base).href);
      const hub = () => page.getByTestId('hub-card').filter({ visible: true });
      // The destination card names the pool and the chain (services/hub-fiat-entry.ts).
      await hub().getByText('Into the $ETH pool on Mainnet', { exact: true }).waitFor();
      await hub().evaluate(node => { window.originalPoolForm = node; });
      await tab(page, '/').click();
      await page.waitForURL(url => url.pathname === '/');
      await hub().getByTestId('hub-shield-pay-token').click();
      await page.getByTestId('token-select-sheet').getByText('BNB Chain', { exact: true }).click();
      await hub().getByText(/^Into the \$\S+ pool on BNB Chain$/).waitFor();
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => window.originalPoolForm.isConnected), true, 'The inactive pool is still mounted');
      assert.ok((await hub().innerText()).includes('pool on BNB Chain'), 'Hidden Ethereum pool cannot override Home network');
      await page.getByRole('button', { name: 'Close token selector', exact: true }).click();
      await page.close();
      console.log(`PASS ${name}: only the focused pool controls the selected network`);
    }

    for (const options of [
      { width: 1440, colorScheme: 'light', reducedMotion: 'no-preference', connected: false },
      { width: 980, colorScheme: 'dark', reducedMotion: 'reduce', connected: true },
    ]) {
      const page = await browser.newPage({ viewport: { width: options.width, height: 1000 },
        colorScheme: options.colorScheme, reducedMotion: options.reducedMotion });
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (options.connected) await installLandingWallet(page);
      await page.goto(base);
      assert.ok(await page.locator('script[src*="/_expo/static/"]').count(), 'Run against build:web, not the development server');
      await tab(page, '/explore').waitFor();
      if (options.connected) {
        await header(page).getByText('Connect Wallet', { exact: true }).click();
        await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
        await header(page).getByTestId('notification-bell').waitFor();
      }
      await page.waitForTimeout(800); // initial entrance is intentional
      await page.route('**/_expo/static/js/web/*.js', async route => {
        await new Promise(resolve => setTimeout(resolve, 250));
        await route.continue();
      });
      // Cold routes, retained tab siblings, returning stack routes, and history.
      for (const path of ['/explore', '/ecosystem', '/', '/ecosystem', '/explore', '/']) {
        await capture(page);
        await tab(page, path).click();
        await page.waitForURL(url => url.pathname === path);
        await page.waitForTimeout(750);
        await assertContinuity(page, `${name} ${options.width} → ${path}`);
      }
      // Start a fresh Home → Explore entry: singular navigation above can
      // replace older entries rather than preserving the entire click trail.
      await tab(page, '/explore').click();
      await page.waitForURL(url => url.pathname === '/explore');
      for (const [direction, path] of [['goBack', '/'], ['goForward', '/explore']]) {
        await capture(page);
        await page[direction]();
        await page.waitForURL(url => url.pathname === path);
        await page.waitForTimeout(750);
        await assertContinuity(page, `${name} ${direction}`);
      }
      const historyLength = await page.evaluate(() => history.length);
      await tab(page, '/explore').click();
      assert.equal(await page.evaluate(() => history.length), historyLength, 'active tab does not push history');
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${name} ${options.width} ${options.colorScheme}: cold/warm routes, Home opacity, Back/Forward`);
    }

    // Rapid choices and an interrupted entrance on a fresh Home mount.
    // Deep-link starts also cover a first visit to Home from another route.
    for (const entry of ['/', '/explore', '/ecosystem']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(new URL(entry, base).href);
      await tab(page, '/explore').waitFor();
      // Leaving immediately must retire even an unfinished entrance.
      await tab(page, entry === '/explore' ? '/ecosystem' : '/explore').click();
      await page.waitForTimeout(400);
      await capture(page);
      for (const path of ['/ecosystem', '/explore', '/ecosystem', '/']) {
        await tab(page, path).click();
        await page.waitForURL(url => url.pathname === path);
      }
      await page.waitForTimeout(750);
      // Home entered for the first time from a deep link may animate once.
      await assertContinuity(page, `${name} entry ${entry} and rapid choices`, { firstHomeVisit: entry !== '/' });
      await tab(page, '/explore').click();
      await page.waitForTimeout(400);
      await capture(page);
      await tab(page, '/').click();
      await page.waitForURL(url => url.pathname === '/');
      await page.waitForTimeout(750);
      await assertContinuity(page, `${name} return after entry at ${entry}`);
      await page.close();
      console.log(`PASS ${name}: entry ${entry}, rapid choices and return`);
    }
  } finally {
    await browser.close();
  }
}
