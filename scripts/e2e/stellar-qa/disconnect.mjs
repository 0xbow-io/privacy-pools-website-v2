import assert from 'node:assert/strict';
import { launchChrome } from '../../lib/chrome.mjs';
const browser = await launchChrome({ headless: true });
try {
  for (const width of [1440, 390]) for (const tab of ['shield', 'withdraw', 'send', 'request']) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://localhost:8093/?env=staging&qa=funded&qaFlow=${tab}&qaStage=input`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__stellarQaDone, { timeout: 45000 });
    await page.getByTestId('header-account').click();
    await page.getByText('Sign Out', { exact: true }).click();
    await page.getByTestId('header-account').filter({ hasText: 'Connect' }).waitFor();
    await page.getByTestId('hub-cta-shield').filter({ hasText: 'Get Started' }).waitFor();
    assert.equal(await page.getByTestId('hub-page-shield').getByTestId('hub-amount-input').inputValue(), '');
    assert.equal(await page.getByTestId('hub-tab-swap').count(), 0);
    assert.equal(await page.evaluate(() => window.__stellarQaCalls.length), 0);
    assert.deepEqual(errors, []);
    // Let the tab indicator settle before capturing the returned landing page.
    await page.waitForTimeout(800);
    await page.screenshot({ path: `/tmp/dev825-disconnect-${width}-${tab}.png` });
    console.log('PASS disconnect to landing', width, tab);
    await page.close();
  }
} finally { await browser.close(); }
