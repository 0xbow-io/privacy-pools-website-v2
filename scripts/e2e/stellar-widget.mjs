// Read-only picker smoke: PROBE_URL=http://localhost:8092 node scripts/e2e/stellar-widget.mjs
import assert from 'node:assert/strict';
import { launchChrome } from '../lib/chrome.mjs';
const base = process.env.PROBE_URL ?? 'http://localhost:8092';
const browser = await launchChrome({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, colorScheme: 'dark' });
    page.setDefaultTimeout(20_000);
    console.log(`Checking ${viewport.width}px`);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/?env=staging`, { waitUntil: 'domcontentloaded' });
    const pay = page.getByTestId('hub-shield-pay-token').first();
    await pay.waitFor();
    // A direct-only source has a fixed output, not a one-item selector.
    assert.equal(await page.getByTestId('hub-shield-pool').first().isDisabled(), true);
    await pay.click();
    await page.getByText('Stellar Lumens · Stellar Testnet', { exact: true }).click();
    await page.getByRole('button', { name: 'Pay token: XLM on Stellar Testnet', exact: true }).waitFor();
    await page.getByText('Into the $XLM pool on Stellar Testnet', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('hub-shield-pool').first().isDisabled(), true);
    for (const tab of ['withdraw', 'send', 'request']) {
      await page.getByTestId(`hub-tab-${tab}`).click();
      assert.match(await page.getByTestId(tab === 'request' ? 'hub-request-token' : 'hub-withdraw-pool').filter({ visible: true }).first().innerText(), /XLM/);
      if (tab !== 'request') {
        const source = page.getByTestId(`hub-page-${tab}`).getByTestId('hub-withdraw-pool');
        await source.click();
        await page.getByRole('button', { name: 'ETH on Sepolia', exact: true }).click();
        await source.filter({ hasText: 'ETH' }).waitFor();
        await source.click();
        await page.getByRole('button', { name: 'XLM on Stellar Testnet', exact: true }).click();
        await source.filter({ hasText: 'XLM' }).waitFor();
      }
    }
    const requestAmount = page.getByTestId('hub-page-request').getByTestId('hub-amount-input');
    await requestAmount.fill('1.1234567');
    // Selecting an EVM request asset after Stellar must survive the provider rerender.
    await page.getByTestId('hub-request-token').filter({ visible: true }).click();
    await page.getByText('USDC Pool · Sepolia', { exact: true }).click();
    await page.getByTestId('hub-request-token').filter({ visible: true }).filter({ hasText: 'USDC' }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="hub-page-request"] input').value === '1.123456');
    await page.getByTestId('hub-request-token').filter({ visible: true }).click();
    await page.getByRole('button', { name: 'ETH on Sepolia', exact: true }).click();
    await requestAmount.fill('1.123456789');
    await page.getByTestId('header-chain-selector').click();
    await page.getByTestId('header-chain-option-202').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="hub-page-request"] input').value === '1.1234567');
    await page.getByTestId('hub-tab-shield').click();
    assert.equal(await page.getByTestId('hub-shield-pool').first().isDisabled(), true);
    await page.getByRole('button', { name: 'Pay token: XLM on Stellar Testnet', exact: true }).waitFor();
    await page.getByTestId('header-chain-selector').click();
    await page.getByTestId('header-chain-option-11155111').click();
    await page.getByTestId('header-chain-selector').click();
    await page.getByTestId('header-chain-option-202').click();
    await page.getByTestId('hub-request-token').filter({ visible: true }).filter({ hasText: 'XLM' }).waitFor();
    assert.equal(await page.getByTestId('hub-tab-swap').count(), 0);
    await page.getByTestId('hub-tab-shield').click();
    // The pager spring must settle before capturing its layout.
    await page.waitForTimeout(800);
    assert.equal(await page.getByTestId('hub-pager-frame').evaluate(node => node.scrollLeft), 0, 'Picker focus must not scroll the clip frame');
    await page.screenshot({ path: `/tmp/dev825-stellar-${viewport.width}.png` });
    // Mainnet chains with supported conversions retain their destination picker.
    await page.getByTestId('header-chain-selector').click();
    await page.getByTestId('header-chain-option-56').click();
    const output = page.getByTestId('hub-shield-pool').first();
    await output.filter({ hasText: 'BNB' }).waitFor();
    assert.equal(await output.isEnabled(), true);
    await output.click();
    await page.getByText('Deposit in pool', { exact: true }).waitFor();
    assert.equal(await page.getByTestId('token-select-row-XLM').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Stellar widget: desktop/mobile selection, four XLM tabs, request return to EVM, header switching passed.');
} finally { await browser.close(); }
