// PROBE_URL=http://localhost:8081 node scripts/e2e/wallet-reload.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installLandingWallet } from './fixtures/landing-wallet.mjs';
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installLandingWallet(page);
    await page.addInitScript(() => {
      window.marketingFrames = 0;
      const sample = () => {
        const story = document.querySelector('[data-testid="front-page"]');
        const hero = [...document.querySelectorAll('h1')].find(element => element.textContent.includes('Privacy for public chains.'));
        const visibleHero = hero && !hero.closest('[aria-hidden="true"]') && hero.getBoundingClientRect().height > 0;
        if (story?.getBoundingClientRect().height || visibleHero) window.marketingFrames++;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.route('**/global/public/events?**', route => route.fulfill({ json: { events: [], total: 0, page: 1, perPage: 100 } }));
    await page.goto(process.env.PROBE_URL ?? 'http://localhost:8081');
    await page.getByTestId('front-page').waitFor();
    await page.getByText('Connect Wallet', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
    await page.getByTestId('notification-bell').waitFor();
    await page.evaluate(() => sessionStorage.setItem('landing-test-hold-restore', 'true'));
    await page.reload();
    await page.waitForFunction(() => window.landingRestoreRequested);
    const hub = page.getByTestId('home-action-column');
    await hub.waitFor();
    const before = await hub.boundingBox();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.marketingFrames), 0, 'No marketing while reconnection is pending');
    assert.equal(await page.getByText('Loading Privacy Pools…', { exact: true }).count(), 0, 'The real app is visible without a loading screen');
    await page.evaluate(() => window.releaseLandingRestore());
    await page.getByTestId('notification-bell').waitFor();
    const after = await hub.boundingBox();
    assert.equal(await page.evaluate(() => window.marketingFrames), 0, 'Reconnection does not pass through landing');
    assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.width - after.width) <= 1, 'Layout stays in place when wallet confirmation arrives');
    const identityReset = page.waitForEvent('console', message => message.text().includes('[PP-LAND] identity changed'));
    await page.evaluate(() => window.switchLandingWallet('0x0000000000000000000000000000000000000456'));
    await identityReset;
    await page.evaluate(() => window.disconnectLandingWallet());
    await page.getByTestId('front-page').waitFor();
    await page.getByText('Connect Wallet', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
    await page.getByTestId('notification-bell').waitFor();
    await page.evaluate(() => sessionStorage.removeItem('landing-test-connected'));
    await page.reload();
    await page.getByTestId('front-page').waitFor();
    assert.deepEqual(await page.evaluate(() => window.landingSignRequests), []);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: app visible during reload; no marketing/loading frame; failed restore returns to landing`);
    await page.close();
  }
} finally { await browser.close(); }
