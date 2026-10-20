// Local navigation regression: panels, route return, and late funding.
// PROBE_URL=http://localhost:8081 node scripts/e2e/panel-navigation.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installLandingWallet } from './fixtures/landing-wallet.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 1440, height: 1000 } });
  page.setDefaultNavigationTimeout(30_000);
  page.setDefaultTimeout(30_000);
  await installLandingWallet(page);
  const errors = [];
  const prompts = [];
  let fundingObserved = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.text().includes('[PP-LAND] invariant-check') && message.text().includes('"funded":true')) fundingObserved = true;
    if (message.text().includes('[PP-LAND] opening sign-in')) prompts.push(message.text());
  });
  let releaseFunding;
  let heldRequest = false;
  const pendingFunding = new Promise(resolve => { releaseFunding = resolve; });
  await page.route('**/global/public/events?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('address')?.toLowerCase() === '0x0000000000000000000000000000000000000123' && !heldRequest) {
      heldRequest = true;
      await pendingFunding;
      const chainId = Number(url.searchParams.get('chainId')) || 1;
      await route.fulfill({ json: {
        page: 1, perPage: 100, total: 1,
        events: [{ type: 'deposit', eventId: 900001, createdAt: new Date().toISOString(),
          amount: '1000000000000000000', address: '0x0000000000000000000000000000000000000123',
          txHash: `0x${'12'.repeat(32)}`, timestamp: Math.floor(Date.now() / 1000), reviewStatus: 'approved',
          asset: { asset: 'ETH', chainId, chainName: 'Ethereum', tokenSymbol: 'ETH',
            tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            assetAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', denomination: 18 },
        }],
      } });
    } else {
      await route.fulfill({ json: { page: 1, perPage: 100, total: 0, events: [] } });
    }
  });
  await page.goto(process.env.PROBE_URL ?? 'http://localhost:8081');
  await page.getByText('Connect Wallet', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
  await page.getByTestId('notification-bell').waitFor();
  const visible = testID => page.getByTestId(testID).filter({ visible: true });
  await visible('home-action-column').evaluate(element => { element.dataset.navigationProbe = 'original'; });
  const header = () => page.locator('[data-testid="site-header"]:visible:not([aria-hidden="true"] *)');
  const expectHome = async panel => {
    await page.waitForFunction(expected => location.pathname === '/' && new URLSearchParams(location.search).get('panel') === expected, panel);
    // Check after pending animation/history work too, not just its first frame.
    await page.waitForTimeout(600);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).searchParams.get('panel'), panel);
    assert.equal(await visible('split-panel-close').count(), panel ? 1 : 0);
  };
  await visible('home-door-mine').click();
  await visible('split-panel-close').click();
  await expectHome(null);
  assert.ok(heldRequest, 'Own-address funding request was intercepted');
  releaseFunding();
  await page.waitForTimeout(2000);
  assert.ok(fundingObserved, 'Synthetic funded activity reached the landing decision');
  assert.deepEqual(prompts, [], 'Closing balances suppresses a late unlock invitation');
  await expectHome(null);

  // Both opening and closing interpolate the actual layout, not just opacity.
  for (const control of ['home-door-mine', 'split-panel-close', 'home-door-activity', 'split-panel-close']) {
    await page.evaluate(() => {
      window.panelFrames = [];
      window.capturePanel = true;
      const sample = () => {
        if (!window.capturePanel) return;
        const element = document.querySelector('[data-testid="home-action-column"]');
        const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        window.panelFrames.push({ left: element.getBoundingClientRect().left, scaleX: transform.a, scaleY: transform.d, opacity: Number(getComputedStyle(element).opacity) });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await visible(control).click();
    await page.waitForTimeout(650);
    const frames = await page.evaluate(() => {
      window.capturePanel = false;
      return window.panelFrames;
    });
    const start = frames[0].left;
    const end = frames.at(-1).left;
    assert.ok(Math.abs(start - end) > 20, 'Panel changes move the form');
    const intermediate = frames.filter(frame => frame.left > Math.min(start, end) + 2 && frame.left < Math.max(start, end) - 2);
    assert.ok(intermediate.length >= 3, `Panel ${control} has continuous intermediate positions (${intermediate.length} frames)`);
    assert.ok(frames.every(frame => frame.left >= Math.min(start, end) - 2 && frame.left <= Math.max(start, end) + 2), 'Panel movement never overshoots');
    assert.ok(frames.every(frame => frame.opacity >= 0.85), 'The form never fades out during a panel change');
    assert.ok(frames.every(frame => frame.scaleX === 1 && frame.scaleY === 1), 'Panel motion never stretches controls');
  }
  console.log('PASS: balances and activity open/close with continuous motion and no scaling or overshoot');

  for (const panel of [null, 'balances', 'activity']) {
    if (panel) await visible(panel === 'balances' ? 'home-door-mine' : 'home-door-activity').click();
    await expectHome(panel);
    for (const [label, path] of [['Explore', '/explore'], ['Portfolio', '/portfolio'], ['Ecosystem', '/ecosystem']]) {
      const savedHeight = await visible('hub-card').evaluate(element => element.getBoundingClientRect().height);
      await header().getByText(label, { exact: true }).click();
      await page.waitForURL(url => url.pathname === path);
      console.log(`route ${panel ?? 'closed'} → ${label}`);
      await page.evaluate(() => {
        window.returnFrames = [];
        window.captureReturn = true;
        const sample = () => {
          if (!window.captureReturn) return;
          const card = document.querySelector('[data-testid="hub-card"]');
          const height = card?.getBoundingClientRect().height ?? 0;
          if (height > 0) window.returnFrames.push(height);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await header().getByText('My Pools', { exact: true }).click();
      await expectHome(panel);
      const heights = await page.evaluate(() => {
        window.captureReturn = false;
        return window.returnFrames;
      });
      assert.ok(heights.length > 0);
      assert.ok(heights.every(height => Math.abs(height - savedHeight) <= 2),
        `Returning from ${label} preserves widget height: ${savedHeight} → ${Math.min(...heights)}–${Math.max(...heights)}`);
      // Clicking the active top-level tab must not change the panel or push a route.
      const length = await page.evaluate(() => history.length);
      await header().getByText('My Pools', { exact: true }).click();
      await expectHome(panel);
      assert.equal(await page.evaluate(() => history.length), length);
    }
    if (panel) {
      await visible('split-panel-close').click();
      await expectHome(null);
      await visible('hub-tab-request').click();
      await expectHome(null); // A stale Expo param must not resurrect the closed panel.
      await visible('hub-tab-shield').click();
    }
  }
  await visible('home-door-mine').click();
  await page.goBack();
  await expectHome(null);
  await page.goForward();
  await expectHome('balances');
  await visible('split-panel-close').click();
  await expectHome(null);
  assert.equal(await page.getByTestId('home-action-column').count(), 1, 'Top navigation keeps one mounted workspace');
  assert.equal(await visible('home-action-column').getAttribute('data-navigation-probe'), 'original', 'Returning reuses the original form DOM');
  // The same route identity must survive desktop -> mobile -> desktop use.
  // Jelly tabs expose pointer-disabled accessibility labels over one gesture
  // surface; tap their coordinates so the real shared gesture receives input.
  await page.setViewportSize({ width: 390, height: 900 });
  console.log('mobile → balances');
  await page.getByTestId('explore-tab-mine').tap({ force: true });
  await page.waitForURL(url => url.pathname === '/explore/balances');
  console.log('mobile → Shield');
  await page.getByTestId('explore-tab-shield').tap({ force: true });
  await page.waitForURL(url => url.pathname === '/');
  console.log('mobile → More / Explore');
  await page.getByTestId('explore-tab-more').tap({ force: true });
  await page.getByTestId('more-nav-Explore').tap();
  await page.getByTestId('more-drawer').waitFor({ state: 'hidden' });
  await page.waitForURL(url => url.pathname === '/explore');
  console.log('mobile → Shield');
  await page.getByTestId('explore-tab-shield').tap({ force: true });
  await page.waitForURL(url => url.pathname === '/');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectHome(null);
  assert.equal(await page.getByTestId('home-action-column').count(), 1, 'Mobile navigation also reuses one workspace');
  assert.equal(await visible('home-action-column').getAttribute('data-navigation-probe'), 'original');
  await visible('home-door-mine').click();
  await header().getByText('Explore', { exact: true }).click();
  await page.waitForURL(url => url.pathname === '/explore');
  await page.evaluate(() => window.disconnectLandingWallet());
  await header().getByText('Connect Wallet', { exact: true }).waitFor();
  await header().getByText('My Pools', { exact: true }).click();
  await expectHome(null);
  await page.getByRole('heading', { level: 1, name: 'Privacy for public chains.' }).waitFor();
  assert.deepEqual(prompts, []);
  assert.deepEqual(await page.evaluate(() => window.landingSignRequests), []);
  assert.deepEqual(errors, []);
  console.log('PASS: balances/activity/closed restore across all top tabs; X stays home; late funding never prompts');
} finally {
  await browser.close();
}
