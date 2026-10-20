// The route-owned headers share the same in-place highlight motion as ActionHub.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.PROBE_URL ?? 'http://localhost:8081');
    const header = () => page.locator('[data-testid="site-header"]:visible:not([aria-hidden="true"] *)');
    await header().getByText('Explore', { exact: true }).waitFor();
    for (const [label, path] of [['Explore', '/explore'], ['Ecosystem', '/ecosystem'], ['My Pools', '/']]) {
      await page.evaluate(() => {
        window.navFrames = [];
        window.captureNav = true;
        const sample = () => {
          if (!window.captureNav) return;
          const pill = [...document.querySelectorAll('[data-testid="navbar-highlight"]')].find(el => el.getBoundingClientRect().width > 0 && !el.closest('[aria-hidden="true"]'));
          if (pill) {
            const rect = pill.getBoundingClientRect();
            window.navFrames.push({ left: rect.left - pill.parentElement.getBoundingClientRect().left, width: rect.width, animated: pill.getAnimations().some(animation => animation.playState === 'running') });
          }
          requestAnimationFrame(sample);
        };
        sample();
      });
      await header().getByText(label, { exact: true }).click();
      await page.waitForURL(url => url.pathname === path, { timeout: 30_000 });
      await page.waitForTimeout(500);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="navbar-highlight"]')]
        .filter(pill => pill.getBoundingClientRect().width > 0 && !pill.closest('[aria-hidden="true"]'))
        .every(pill => pill.getAnimations().every(animation => animation.playState !== 'running')));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const frames = await page.evaluate(() => { window.captureNav = false; return window.navFrames; });
      const first = frames[0], last = frames.at(-1);
      assert.ok(first && last && Math.abs(first.left - last.left) > 15);
      assert.ok(frames.every(frame => frame.left >= Math.min(first.left, last.left) - 1 && frame.left <= Math.max(first.left, last.left) + 1), `${label} ${reducedMotion}: highlight never overshoots: ${JSON.stringify(frames.slice(0, 12))}`);
      const between = frames.filter(frame => frame.left > Math.min(first.left, last.left) + 2 && frame.left < Math.max(first.left, last.left) - 2);
      assert.ok(reducedMotion === 'reduce' ? frames.every(frame => !frame.animated) : between.length >= 2 && frames.some(frame => frame.animated),
        `${label}: ${reducedMotion} highlight movement: ${JSON.stringify(frames.slice(0, 12))}`);
      const selected = await header().getByTestId(`navbar-item-${path}`).boundingBox();
      const row = await header().getByTestId('navbar-tabs').boundingBox();
      assert.ok(Math.abs(last.left - (selected.x - row.x)) <= 1 && Math.abs(last.width - selected.width) <= 1, `${label}: highlight ${JSON.stringify(last)} / label ${JSON.stringify(selected)} / row ${JSON.stringify(row)}`);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/navbar-motion-${reducedMotion}.png` });
    await page.close();
    console.log(`PASS navbar ${reducedMotion}: route changes retain one aligned highlight with matching tab motion`);
  }
} finally { await browser.close(); }
