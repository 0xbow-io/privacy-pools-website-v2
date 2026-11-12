// Local browser regression; no RPC, wallet key, application server or spending.
import { expect } from 'bun:test';
import { launchChrome } from '../../lib/chrome.mjs';
import { installUnlockGateHandler, unlockIfPrompted, waitForUnlockedLink } from '../unlock-gate';
import { fillRecipient } from '../lib';

const browser = await launchChrome({ headless: true });
try {
  for (const passkey of [false, true]) {
    const page = await browser.newPage();
    await page.setContent(`<button id="header" onclick="this.dataset.clicked='yes'">Sign in</button><button id="pill" onclick="this.textContent='Token picker opened'">Choose token</button>`);
    // The initial signIn check happens before the asynchronously raised gate.
    expect(await unlockIfPrompted(page)).toBe(false);
    await page.evaluate((usePasskey) => {
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:#888;z-index:10';
      overlay.innerHTML = `<h2>${usePasskey ? 'Unlock with passkey' : 'Unlock your account'}</h2>${usePasskey ? '<button id="wallet">Use wallet signature instead</button>' : ''}<button id="sign">Sign in</button>`;
      document.body.append(overlay);
      if (usePasskey) overlay.querySelector('#wallet')!.addEventListener('click', () => {
        overlay.querySelector('h2')!.textContent = 'Unlock your account';
      });
      overlay.querySelector('#sign')!.addEventListener('click', () => setTimeout(() => overlay.remove(), 50));
    }, passkey);
    // Reproduce the original interception before installing the recovery handler.
    await expect(page.locator('#pill').click({ timeout: 300 })).rejects.toThrow('Timeout');
    await installUnlockGateHandler(page);
    await page.locator('#pill').click({ timeout: 10_000 });
    expect(await page.locator('#pill').innerText()).toBe('Token picker opened');
    expect(await page.locator('#header').getAttribute('data-clicked')).toBeNull();
    console.log(`PASS delayed ${passkey ? 'passkey' : 'wallet'} gate: real pointer click reached token picker`);
    await page.close();
  }
  for (const owner of ['Send', 'Withdraw'] as const) {
    const page = await browser.newPage();
    const key = owner.toLowerCase();
    await page.setContent(`
      <section data-testid="hub-page-${key}" aria-hidden="true" style="display:none">
        <input id="hidden" data-testid="${key}-recipient-input" placeholder="recipient address">
      </section>
      <section data-testid="hub-page-${key}">
        <input id="active" data-testid="${key}-recipient-input" placeholder="Recipient 0x address">
      </section>`);
    expect(await fillRecipient(page, '0x1234', owner)).toBe(true);
    expect(await page.locator('#active').evaluate(el => (el as HTMLInputElement).value)).toBe('0x1234');
    expect(await page.locator('#hidden').evaluate(el => (el as HTMLInputElement).value)).toBe('');
    console.log(`PASS ${owner} recipient uses stable ID in active page, ignoring hidden sibling and placeholder copy`);
    await page.close();
  }
  const polling = await browser.newPage();
  await polling.setContent('<div id="result">Creating request</div>');
  await installUnlockGateHandler(polling);
  await polling.evaluate(() => {
    setTimeout(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0';
      overlay.innerHTML = '<h2>Unlock your account</h2><button>Sign in</button>';
      document.body.append(overlay);
      overlay.querySelector('button')!.onclick = () => {
        overlay.remove();
        document.querySelector('#result')!.textContent = 'Copy this http://localhost/pay#test-link';
      };
    }, 100);
  });
  expect(await waitForUnlockedLink(polling, '/pay#', 10_000)).toBe('http://localhost/pay#test-link');
  console.log('PASS read-only link polling clears a late gate and reads a text-only link');
  await polling.close();
  const page = await browser.newPage();
  await page.setContent('<div style="position:fixed;inset:0"><h2>Unlock your account</h2><button>Sign in</button></div>');
  await expect(unlockIfPrompted(page, 100)).rejects.toThrow('did not finish');
  console.log('PASS a stuck unlock fails explicitly');
} finally {
  await browser.close();
}
