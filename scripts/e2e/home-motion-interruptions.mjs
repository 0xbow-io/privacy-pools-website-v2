// PROBE_URL=http://localhost:8081 node scripts/e2e/home-motion-interruptions.mjs
// Exercise interrupted motion, not just settled layouts. No wallet or signing.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.PROBE_URL ?? 'http://localhost:8081');
  await page.getByTestId('hub-tab-shield').waitFor();
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const expectAction = async expected => {
    // Let delayed RN scroll events and the pager's settle timer run too.
    await page.waitForTimeout(1300);
    assert.equal(new URL(page.url()).searchParams.get('action'), expected);
    assert.notEqual(await page.getByTestId(`hub-page-${expected}`).getAttribute('aria-hidden'), 'true');
    const offset = await page.getByTestId(`hub-page-${expected}`).evaluate(element => {
      let scroller = element.parentElement;
      while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
      if (!scroller) throw new Error('Pager scroll container missing');
      return Math.abs(element.getBoundingClientRect().left - scroller.getBoundingClientRect().left);
    });
    assert.ok(offset <= 2, `Selected ${expected} page is aligned with the pager (${offset}px)`);
  };

  await page.evaluate(() => {
    window.tabFrames = [];
    window.captureTab = true;
    const sample = () => {
      if (!window.captureTab) return;
      const frame = document.querySelector('[data-testid="hub-pager-frame"]');
      const selected = document.querySelector('[data-testid="hub-page-request"]');
      window.tabFrames.push({ opacity: Number(getComputedStyle(frame).opacity), left: selected.getBoundingClientRect().left });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByTestId('hub-tab-request').click();
  await expectAction('request');
  const tabFrames = await page.evaluate(() => {
    window.captureTab = false;
    return window.tabFrames;
  });
  assert.ok(tabFrames.every(frame => frame.opacity >= 0.85), 'Tab content remains visible throughout its subtle fade');
  const end = tabFrames.at(-1).left;
  const start = tabFrames[0].left;
  assert.ok(tabFrames.every(frame => Math.abs(frame.left - start) <= 2 || Math.abs(frame.left - end) <= 2), 'Tab clicks switch in place without a swipe');
  console.log('PASS: action tab content switches in place with no blank frame or swipe');

  for (const [action, width] of [
    ['request', 800], ['shield', 1440], ['send', 1000], ['request', 1100],
    ['shield', 390], ['request', 1440], ['withdraw', 800], ['shield', 1440],
  ]) {
    await page.getByTestId(`hub-tab-${action}`).click();
    await page.waitForTimeout(40);
    await page.setViewportSize({ width, height: 1000 });
    await expectAction(action);
  }
  console.log('PASS: interrupted tab changes preserve selection across desktop/mobile widths');

  await page.getByTestId('hub-tab-request').click();
  await page.getByTestId('home-door-mine').click();
  await expectAction('request');
  await page.getByTestId('split-panel-close').click();
  await expectAction('request');
  for (const action of ['shield', 'request', 'withdraw', 'send']) {
    await page.getByTestId(`hub-tab-${action}`).click();
  }
  await expectAction('send');
  console.log('PASS: panel reflow and rapid clicks preserve the requested tab');

  await page.getByTestId('hub-tab-shield').click();
  await expectAction('shield');
  await page.getByTestId('hub-page-shield').getByPlaceholder('0').first().hover();
  await page.mouse.wheel(468, 0);
  await expectAction('withdraw');
  console.log('PASS: real horizontal wheel gestures still select tabs');

  await page.getByTestId('hub-tab-shield').click();
  await expectAction('shield');
  await page.getByText(/^Get Started Shielding /).first().click();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.pickerMotionFrames = [];
    window.capturePickerMotion = true;
    const sample = () => {
      if (!window.capturePickerMotion) return;
      const card = document.querySelector('[data-testid="hub-card"]');
      const form = card.children[0];
      window.pickerMotionFrames.push({
        cardHeight: card.getBoundingClientRect().height,
        formHeight: form.getBoundingClientRect().height,
        opacity: Number(getComputedStyle(form).opacity),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByText('Back to shielding', { exact: true }).click();
  await page.waitForTimeout(600);
  const frames = await page.evaluate(() => {
    window.capturePickerMotion = false;
    return window.pickerMotionFrames;
  });
  assert.ok(frames.some(frame => frame.opacity > 0 && frame.opacity < 1), 'Picker close crossfades');
  assert.ok(frames.every(frame => frame.opacity < 1 || frame.formHeight <= frame.cardHeight + 2), `Opaque form is not clipped during picker close: ${JSON.stringify(frames.filter(frame => frame.opacity === 1 && frame.formHeight > frame.cardHeight + 2).slice(0, 3))}`);
  assert.deepEqual(errors, []);
  console.log('PASS: picker close restores the form without abruptly revealing clipped controls');
} finally {
  await browser.close();
}
