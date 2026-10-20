// Reload regression: resolving the live yield rate must not move the card or CTA.
// Uses the configured default yield pool's real reads, holding its last RPC response.
// Run against a production preview: PROBE_URL=http://localhost:8083 node scripts/visual/home-startup.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { toFunctionSelector } from 'viem';

const base = process.env.PROBE_URL ?? 'http://localhost:8083';
const reserveSelector = toFunctionSelector('getReserveData(address)').slice(2);
const isYieldCall = call => call?.method === 'eth_call' && call.params?.[0]?.data?.includes(reserveSelector);
function readsYield(request) {
  if (request.method() !== 'POST') return false;
  try {
    const body = request.postDataJSON();
    return (Array.isArray(body) ? body : [body]).some(isYieldCall);
  } catch { return false; }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const { width, unavailable = false, reducedMotion = 'no-preference' } of [
    { width: 1440 }, { width: 412 }, { width: 360 },
    { width: 412, unavailable: true }, { width: 1440, reducedMotion: 'reduce' },
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion });
    const release = Promise.withResolvers();
    try {
      await page.route('**/*', async route => {
        if (readsYield(route.request())) {
          await release.promise;
          if (unavailable) {
            const body = route.request().postDataJSON();
            const error = call => ({ jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'Rate unavailable in startup test' } });
            if (Array.isArray(body) && body.some(call => !isYieldCall(call))) {
              const response = await route.fetch();
              const results = await response.json();
              const yieldIds = new Set(body.filter(isYieldCall).map(call => call.id));
              await route.fulfill({ response, json: results.map(result => yieldIds.has(result.id) ? error(result) : result) });
            } else {
              await route.fulfill({ json: Array.isArray(body) ? body.map(error) : error(body) });
            }
            return;
          }
        }
        await route.continue();
      });
      const requested = page.waitForRequest(readsYield);
      await page.goto(base);
      await requested;
      await page.getByRole('progressbar', { name: 'Loading live yield rate' }).waitFor();
      if (reducedMotion === 'reduce') {
        assert.equal(await page.getByTestId('shield-live-apy').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
      }
      const button = page.getByRole('button', { name: /^Get Started Shielding / });
      await button.waitFor();
      // Measure rate-driven movement after the intentional entrance has settled.
      await button.evaluate(async node => {
        const entrance = node.closest('.landing-entrance-widget');
        await Promise.all((entrance?.getAnimations() ?? []).map(animation => animation.finished));
      });
      const suffix = await page.getByTestId('shield-live-apy').getByText('net APY', { exact: true }).elementHandle();
      await button.evaluate((button, suffix) => {
        const card = document.querySelector('[data-testid="hub-card"]');
        window.startupBoxes = [];
        window.sampleStartup = true;
        function sample() {
          if (!window.sampleStartup) return;
          window.startupBoxes.push([card, button, suffix].map(node => {
            const rect = node.getBoundingClientRect();
            return [rect.top, rect.bottom, rect.left, rect.right];
          }).flat());
          requestAnimationFrame(sample);
        }
        sample();
      }, suffix);
      release.resolve();
      if (unavailable) {
        await page.getByLabel('Yield rate unavailable', { exact: true }).waitFor();
        assert.doesNotMatch(await page.getByTestId('shield-apy-value').innerText(), /\d.*%/);
      } else {
        await page.getByTestId('shield-apy-value').getByText(/[\d.,]+%$/).waitFor();
      }
      const boxes = await page.getByTestId('hub-card').evaluate(async card => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(card.getAnimations({ subtree: true }).map(animation => animation.finished));
        window.sampleStartup = false;
        return window.startupBoxes;
      });
      for (const frame of boxes) {
        assert.ok(frame.every((edge, i) => Math.abs(edge - boxes[0][i]) <= 1),
          `${width}px: the rate response moved the card, button, or net APY label: ${JSON.stringify([boxes[0], frame])}`);
      }
      console.log(`${width}px (${unavailable ? 'unavailable' : 'live rate'}, ${reducedMotion}): card, CTA, and net APY label stayed stable`);
    } finally {
      release.resolve();
      await page.close();
    }
  }
} finally {
  await browser.close();
}
