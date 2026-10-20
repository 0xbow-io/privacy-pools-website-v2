// PROBE_URL=http://localhost:8081 node scripts/e2e/landing-wallet-state.mjs
// A disposable wallet fixture: no keys, signing, or transaction submission.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installLandingWallet } from './fixtures/landing-wallet.mjs';

const browser = await chromium.launch({ headless: true });
try {
  for (const [width, reducedMotion] of [
    [1440, 'no-preference'], [390, 'no-preference'],
    [1440, 'reduce'], [390, 'reduce'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion });
    const page = await context.newPage();
    await installLandingWallet(page);
    // intro links and a fresh visit must both yield to connection state.
    await page.goto(`${process.env.PROBE_URL ?? 'http://localhost:8081'}/?intro=true`);
    const expectSettledMotion = async () => {
      const frames = await page.getByTestId('home-action-column').evaluate(async column => {
        const frames = [];
        const start = performance.now();
        while (performance.now() - start < 500) {
          const rect = column.getBoundingClientRect();
          frames.push({ transform: getComputedStyle(column).transform, x: rect.x, width: rect.width });
          await new Promise(requestAnimationFrame);
        }
        return frames;
      });
      assert.ok(frames.every(frame => frame.transform === 'none'), 'Form never slides or stretches across the page');
      assert.ok(frames.every(frame => frame.x >= 0 && frame.x + frame.width <= width + 1), 'Form stays inside the viewport');
    };
    const story = page.getByTestId('front-page');
    const hero = page.getByRole('heading', { level: 1, name: 'Privacy for public chains.' });
    await story.waitFor({ state: 'visible', timeout: 60_000 });
    await hero.waitFor({ state: 'visible' });
    const cta = page.getByText(/^Get Started Shielding /).first();
    const picker = page.getByTestId('hub-card').getByText('Landing Test Wallet', { exact: true });
    const expectLanding = async () => {
      await story.waitFor({ state: 'visible' });
      await hero.waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('site-header').getByText('Payroll', { exact: true }).count(), 0, 'Payroll stays out of the navbar after disconnect');
      if (width >= 1024) {
        const heading = await hero.boundingBox();
        const widget = await page.getByTestId('home-action-column').boundingBox();
        assert.ok(heading && widget && heading.x < widget.x, 'Landing hero stays beside the widget');
      }
    };
    const openPicker = async () => {
      await cta.click();
      await picker.waitFor({ state: 'visible' });
      await expectLanding();
    };
    // Editing reduces the page to the form: the hero and the story leave
    // TOGETHER, and both come back on blur. Neither may leave without the other.
    const amount = page.getByTestId('hub-card').getByPlaceholder('0').first();
    await amount.focus();
    await story.waitFor({ state: 'detached' });
    await hero.waitFor({ state: 'hidden' });
    await amount.blur();
    await expectLanding();
    // Cancelling the CTA must restore the whole landing page.
    await openPicker();
    await page.getByText('Back to shielding', { exact: true }).click();
    await cta.waitFor({ state: 'visible' });
    await expectLanding();
    // Browser Back cancels the inline picker too.
    await openPicker();
    await page.goBack();
    await cta.waitFor({ state: 'visible' });
    await expectLanding();
    // Browser Back must discard account-key text and its revealed state.
    await openPicker();
    await page.getByTestId('hub-card').getByText('Or sign in with an account key (no wallet)', { exact: true }).click();
    await page.getByTestId('account-key-input').fill('dummy text, not an account key');
    await page.getByTestId('account-key-reveal').click();
    await page.goBack();
    await cta.waitFor({ state: 'visible' });
    await openPicker();
    assert.equal(await page.getByTestId('account-key-input').count(), 0);
    await page.getByText('Back to shielding', { exact: true }).click();
    // Complete the actual shielding CTA flow, rather than the header modal.
    await openPicker();
    await picker.click();
    await story.waitFor({ state: 'detached' });
    await hero.waitFor({ state: 'hidden' });
    await expectSettledMotion();
    if (reducedMotion === 'no-preference') await page.screenshot({ path: `/tmp/wallet-connected-${width}.png` });
    assert.equal(await page.getByTestId('home-action-column').isVisible(), true);
    assert.equal(await page.getByTestId('site-header').getByText('Payroll', { exact: true }).count(), 0, 'Payroll stays out of the connected navbar');
    // Restored sessions and subsequent disconnects must behave like fresh ones.
    await page.reload();
    await page.getByTestId('notification-bell').waitFor({ state: 'visible' });
    await story.waitFor({ state: 'detached' });
    await hero.waitFor({ state: 'hidden' });
    // Account panels must close with the session; public exploration remains available.
    if (width >= 1024) {
      await page.getByTestId('home-door-mine').click();
      await page.waitForURL('**panel=balances');
    }
    await page.evaluate(() => window.disconnectLandingWallet());
    await expectLanding();
    await expectSettledMotion();
    if (reducedMotion === 'no-preference') await page.screenshot({ path: `/tmp/wallet-disconnected-${width}.png` });
    assert.equal(new URL(page.url()).searchParams.has('panel'), false);
    await openPicker();
    await page.getByText('Back to shielding', { exact: true }).click();
    await cta.waitFor({ state: 'visible' });
    await expectLanding();
    // Connect from deep in the story: the new app must start at the top.
    await page.getByTestId('front-scroll-hint').click();
    // The header entry point must agree with the widget after a disconnect.
    await page.getByText('Connect Wallet', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
    await story.waitFor({ state: 'detached' });
    await hero.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => {
      const column = document.querySelector('[data-testid="home-action-column"]');
      const header = document.querySelector('[data-testid="site-header"]');
      const top = column.getBoundingClientRect().top;
      return top >= header.getBoundingClientRect().bottom && top < 140;
    });
    await page.evaluate(() => window.disconnectLandingWallet());
    await expectLanding();
    await expectSettledMotion();
    // A cancelled wallet approval may still succeed after the modal reopens.
    await page.evaluate(() => { window.holdLandingConnect = true; });
    await page.getByText('Connect Wallet', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Landing Test Wallet Browser' }).click();
    await page.waitForFunction(() => typeof window.releaseLandingConnect === 'function');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByText('Connect Wallet', { exact: true }).first().click();
    await page.evaluate(() => { window.holdLandingConnect = false; window.releaseLandingConnect(); });
    await page.getByRole('button', { name: 'Close', exact: true }).waitFor({ state: 'hidden' });
    await story.waitFor({ state: 'detached' });
    await page.evaluate(() => window.disconnectLandingWallet());
    await expectLanding();
    // A wallet-less imported session gets the same signed-in navigation.
    // Synthetic identity only: no funded account, wallet signing or transaction.
    await page.evaluate(() => sessionStorage.setItem('ppv2_account_key_v1', btoa(JSON.stringify({
      kind: 'ppv2-account-key', v: 1,
      address: '0x0000000000000000000000000000000000000123',
      signature: `0x${'11'.repeat(65)}`,
    }))));
    await page.reload();
    await page.getByTestId('notification-bell').waitFor({ state: 'visible' });
    await story.waitFor({ state: 'detached' });
    if (width < 930) {
      await page.getByTestId('explore-tab-mine').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('explore-tab-stats').count(), 0);
      const more = await page.getByTestId('explore-tab-more').boundingBox();
      assert.ok(more);
      await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2);
      await page.getByTestId('more-drawer').getByText('Explore', { exact: true }).waitFor({ state: 'visible' });
    }
    console.log(`PASS ${width}px ${reducedMotion}: CTA cancel/back/connect, restored session, disconnect, header reconnect`);
    await context.close();
  }
} finally {
  await browser.close();
}
