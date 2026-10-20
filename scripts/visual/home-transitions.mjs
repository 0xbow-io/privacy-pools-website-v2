// Local landing interaction regression probe. The mock wallet refuses signing and writes.
// Run with: node scripts/visual/home-transitions.mjs (PROBE_URL overrides :8083).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const base = process.env.PROBE_URL ?? 'http://localhost:8083';

async function expectPanel(page, panel) {
  await page.waitForFunction(
    expected => new URLSearchParams(location.search).get('panel') === expected,
    panel,
  );
}

try {
  for (const color of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await page.addInitScript(
      ({ address }) => {
        let connected = false;
        const listeners = {};
        const provider = {
          on: (event, listener) => (listeners[event] ??= []).push(listener),
          removeListener: (event, listener) => {
            listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener);
          },
          request: async ({ method }) => {
            if (method === 'eth_accounts') return connected ? [address] : [];
            if (method === 'eth_requestAccounts') {
              connected = true;
              return [address];
            }
            if (method === 'eth_chainId') return '0x1';
            if (method === 'net_version') return '1';
            if (method === 'wallet_requestPermissions')
              return [{ parentCapability: 'eth_accounts' }];
            throw new Error(`Preview wallet refuses ${method}`);
          },
        };
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent('eip6963:announceProvider', {
              detail: {
                info: {
                  uuid: 'd152d9de-5bc0-4884-98ed-99cc35f5ba61',
                  name: 'Motion preview',
                  rdns: 'test.motion',
                  icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                },
                provider,
              },
            }),
          );
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      },
      { address: `0x${randomBytes(20).toString('hex')}` },
    );
    await page.goto(`${base}/?color=${color}`);
    await page.getByTestId('home-action-column').waitFor();
    // Returning to Shield preserves its token and amount, even when spend
    // tabs fall back to their own native asset. Each page fits its content.
    const shield = page.getByTestId('hub-page-shield');
    const initialAsset = await shield.getByTestId('hub-shield-pay-token').getAttribute('aria-label');
    await shield.getByRole('textbox').fill('12.5');
    await shield.getByRole('textbox').blur();
    for (const action of ['withdraw', 'send', 'request', 'shield']) {
      await page.getByTestId(`hub-tab-${action}`).click();
      // Inactive pages remain mounted. Check selection and vertical containment.
      await page.waitForFunction(action => {
        const card = document.querySelector('[data-testid="hub-card"]').getBoundingClientRect();
        const page = document.querySelector(`[data-testid="hub-page-${action}"]`);
        const content = page.getBoundingClientRect();
        return page.getAttribute('aria-hidden') !== 'true'
          && new URLSearchParams(location.search).get('action') === action
          && content.bottom <= card.bottom;
      }, action);
    }
    assert.equal(await shield.getByTestId('hub-shield-pay-token').getAttribute('aria-label'), initialAsset);
    assert.equal(await shield.getByRole('textbox').inputValue(), '12.5');
    await shield.getByRole('textbox').fill('');
    await shield.getByRole('textbox').blur();
    const mine = page.getByTestId('home-door-mine');
    const activity = page.getByTestId('home-door-activity');
    await mine.click();
    await expectPanel(page, 'balances');
    await page.getByTestId('split-panel-close').waitFor();
    await activity.click();
    await expectPanel(page, 'activity');
    await activity.click();
    await expectPanel(page, null);
    await page.getByTestId('split-panel-close').waitFor({ state: 'hidden' });

    // Browser history must close and restore the panel without leaving home.
    await mine.click();
    await expectPanel(page, 'balances');
    await page.goBack();
    await expectPanel(page, null);
    await page.goForward();
    await expectPanel(page, 'balances');
    await page.getByTestId('split-panel-close').click();
    await expectPanel(page, null);
    await page.getByTestId('split-panel-close').waitFor({ state: 'hidden' });

    await page.getByText(/Get Started Shielding/).click();
    await page.waitForFunction(() => new URLSearchParams(location.search).has('connect'));
    await page.getByText('Motion preview', { exact: true }).click();
    await page.waitForFunction(() => /0x[0-9a-f]{4}\.\.\./i.test(document.body.innerText));
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('connect'));
    console.log(`${color}: tab state, content containment, panel history and wallet connection passed`);
    await page.close();
  }
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  await page.goto(base);
  await page.getByTestId('home-door-mine').click();
  await page.getByTestId('split-panel-close').waitFor();
  assert.equal(
    await page
      .getByTestId('home-action-column')
      .evaluate((element) => element.getAnimations().length),
    0,
  );
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByTestId('split-panel-close').waitFor({ state: 'hidden' });
  console.log('Reduced motion and narrow-layout fallback passed');
} finally {
  await browser.close();
}
