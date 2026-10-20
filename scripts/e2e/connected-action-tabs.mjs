// PROBE_URL=http://localhost:8081 node scripts/e2e/connected-action-tabs.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installLandingWallet } from './fixtures/landing-wallet.mjs';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await installLandingWallet(page);
  await page.route('**/global/public/events?**', route => route.fulfill({ json: { events: [], total: 0, page: 1, perPage: 100 } }));
  await page.goto(process.env.PROBE_URL ?? 'http://localhost:8081');
  await page.getByText('Connect Wallet', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
  await page.getByTestId('notification-bell').waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (const action of ['request', 'send', 'request', 'send']) {
    await page.evaluate(() => {
      window.actionFrames = [];
      window.captureAction = true;
      const sample = () => {
        if (!window.captureAction) return;
        const action = new URLSearchParams(location.search).get('action');
        const host = document.getElementById('pp-inline-op-host');
        const zone = document.querySelector(`[data-testid="hub-page-${action}"]`);
        window.actionFrames.push({ action, children: host?.childElementCount ?? 0,
          height: zone?.getBoundingClientRect().height ?? 0 });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByTestId(`hub-tab-${action}`).click();
    await page.waitForTimeout(700);
    const frames = await page.evaluate(() => { window.captureAction = false; return window.actionFrames; });
    const selected = frames.filter(frame => frame.action === action);
    assert.ok(selected.length > 0);
    assert.ok(selected.every(frame => frame.children > 0), `Complete ${action} form on each visible frame: ${JSON.stringify(selected.filter(frame => !frame.children))}`);
    const host = page.locator('#pp-inline-op-host');
    await host.evaluate(element => { element.dataset.formProbe = 'retained'; });
    await page.getByTestId(`hub-tab-${action}`).click();
    await page.waitForTimeout(300);
    assert.equal(await host.getAttribute('data-form-probe'), 'retained', 'Re-selecting a tab keeps its existing form');
  }
  // Two clicks before Expo commits either URL must honor the last choice.
  await page.evaluate(() => {
    document.querySelector('[data-testid="hub-tab-request"]').click();
    document.querySelector('[data-testid="hub-tab-send"]').click();
  });
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).searchParams.get('action'), 'send');
  assert.ok(await page.locator('#pp-inline-op-host').evaluate(element => element.childElementCount > 0));
  console.log('PASS: connected action tabs show a complete form without a delayed empty frame or remount on reselect');
} finally { await browser.close(); }
