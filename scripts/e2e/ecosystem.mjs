// Run against an existing local server: E2E_BASE_URL=http://localhost:8093 bun scripts/e2e/ecosystem.mjs
// Public directory only; no wallet, transactions, or authenticated fixtures.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8081';
const output = '.pwcheck/ecosystem';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const cards = page.locator('[data-testid^="ecosystem-project-"]');
const card = (slug) => page.getByTestId(`ecosystem-project-${slug}`);

try {
  for (const theme of ['light', 'dark']) {
    await page.goto(`${baseURL}/ecosystem?color=${theme}`);
    await card('casberi').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const total = await cards.count();
    const allFilter = page.getByRole('button', { name: 'All', exact: true });
    assert.ok((await allFilter.boundingBox()).height >= 44, 'Filter has a comfortable hit area');
    assert.equal((await page.getByTestId('ecosystem-filter-pill-all').boundingBox()).height, 32, 'Visible filter matches the compact app pill');
    assert.deepEqual(await cards.evaluateAll((elements) => elements.map((el) => el.dataset.testid.replace('ecosystem-project-', ''))), [
      'kohaku-sdk', 'casberi', 'nymis', 'brevis', 'ambire', 'cloaked', 'veil-cash', 'zfi', 'shielded-eth', 'wenwithdraw', 'defillama-privacy',
    ], 'Every project appears exactly once in reading order');
    for (const [name, href] of [
      ['Read the SDK docs', 'https://privacy-pools-v2-docs.vercel.app/introduction/quickstart'],
      ['Explore the SDK', 'https://privacy-pools-v2-docs.vercel.app/introduction/quickstart'],
      ['View on GitHub', 'https://github.com/0xbow-io/privacy-pools-v2-monorepo'],
      ['Join Telegram', 'https://t.me/privacypoolspublic'],
    ]) assert.equal(await page.getByRole('link', { name, exact: true }).getAttribute('href'), href);
    for (const [slug, href] of [['casberi', 'https://casberi.app'], ['nymis', 'https://nymis.io']]) {
      assert.equal(await card(slug).getAttribute('href'), href);
      assert.equal(await card(slug).getAttribute('target'), '_blank');
      assert.match(await card(slug).getAttribute('rel'), /noopener/);
      assert.match(await card(slug).getAttribute('rel'), /noreferrer/);
    }
    for (const width of [320, 390, 700, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      // RN's onLayout updates the cross-platform grid after a viewport resize.
      await page.waitForTimeout(150);
      const problems = await page.getByTestId('ecosystem-page').evaluate((root) => {
        const failures = [];
        for (const element of root.querySelectorAll('*')) {
          const r = element.getBoundingClientRect();
          if (r.width && (r.left < -1 || r.right > innerWidth + 1)) failures.push(`outside viewport: ${element.textContent.slice(0, 60)}`);
          if (element.children.length === 0 && element.textContent.trim() && element.scrollWidth > element.clientWidth + 1) failures.push(`clipped text: ${element.textContent.slice(0, 60)}`);
        }
        const rects = [...root.querySelectorAll('[data-testid^="ecosystem-project-"]')].map((el) => el.getBoundingClientRect());
        for (let i = 1; i < rects.length; i++) {
          if (rects[i].top < rects[i-1].top - 1) failures.push('visual order differs from keyboard order');
        }
        return failures;
      });
      assert.deepEqual(problems, [], `${theme} at ${width}px`);
      if ([320, 390, 1440].includes(width)) await page.screenshot({ path: `${output}/${theme}-${width}.png` });
    }
    const kohaku = card('kohaku-sdk');
    const logo = page.getByTestId('ecosystem-logo-kohaku-sdk');
    const featuredSize = (await logo.boundingBox()).width;
    assert.ok(featuredSize > 56, 'Kohaku has an enlarged logo in the unfiltered directory');
    await page.mouse.move(0, 0);
    const surfaceBefore = await kohaku.locator(':scope > div').evaluate((el) => getComputedStyle(el).backgroundColor);
    await kohaku.hover();
    assert.equal(await kohaku.locator(':scope > div').evaluate((el) => getComputedStyle(el).backgroundColor), surfaceBefore, 'Hover preserves the card fill');
    assert.notEqual(await logo.evaluate((el) => getComputedStyle(el).backgroundColor), surfaceBefore, 'Logo tile stays distinct on hover');
    assert.notEqual(await kohaku.getByText('SDK', { exact: true }).evaluate((el) => getComputedStyle(el.parentElement).backgroundColor), surfaceBefore, 'Pills stay distinct on hover');
    await page.screenshot({ path: `${output}/${theme}-featured-hover.png` });
    await page.getByRole('button', { name: 'Privacy', exact: true }).click();
    assert.equal((await logo.boundingBox()).width, 56, 'Filtering removes featured logo sizing');
    assert.ok(Math.abs((await kohaku.boundingBox()).width - (await card('casberi').boundingBox()).width) < 1, 'Filtered Kohaku uses the regular grid width');
    await page.screenshot({ path: `${output}/${theme}-filtered.png` });
    await page.getByRole('button', { name: 'Wallet', exact: true }).click();
    assert.equal(await card('casberi').count(), 1);
    assert.equal(await card('nymis').count(), 0);
    assert.equal(await card('kohaku-sdk').count(), 0);
    const tools = page.getByRole('button', { name: 'Tools', exact: true });
    await tools.focus();
    await page.keyboard.press('Enter');
    assert.equal(await card('nymis').count(), 1);
    assert.equal(await card('casberi').count(), 0);
    assert.equal(await tools.getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'All', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await cards.count(), total);
    await card('casberi').focus();
    assert.equal(await card('casberi').evaluate((el) => getComputedStyle(el).outlineStyle), 'solid', 'Visible keyboard focus');
    await page.screenshot({ path: `${output}/${theme}-keyboard-focus.png` });
    await page.getByRole('link', { name: 'Explore the SDK' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${theme}-footer.png` });
    const docs = page.getByRole('link', { name: 'Explore the SDK', exact: true });
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      await docs.hover();
      await page.waitForTimeout(250);
      assert.equal(await docs.locator('.ecosystem-arrow').evaluate((el) => getComputedStyle(el).transform),
        reducedMotion === 'reduce' ? 'none' : 'matrix(1, 0, 0, 1, 3, -3)', 'CTA motion respects the user preference');
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  // A 200% zoom-equivalent CSS viewport and longer labels must still reflow.
  await page.setViewportSize({ width: 720, height: 500 });
  await page.getByTestId('ecosystem-project-casberi').evaluate((el) => {
    el.querySelector('[role="heading"]').textContent = 'Casberi — your accounts, feeds, and private wallet';
  });
  await card('casberi').scrollIntoViewIfNeeded();
  assert.equal(await card('casberi').evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
  await page.screenshot({ path: `${output}/long-label-zoom-equivalent.png` });
  // Direction is an inherited layout input; verify the grid stays inside its container.
  await page.getByTestId('ecosystem-page').evaluate((el) => { el.dir = 'rtl'; });
  await page.screenshot({ path: `${output}/rtl.png` });
  assert.equal(await card('casberi').evaluate((el) => el.getBoundingClientRect().right > innerWidth), false);
  assert.deepEqual(errors, [], 'No uncaught browser exceptions');
  console.log('PASS: both themes, six widths, category filters, link semantics, keyboard focus, reading order, and text reflow.');
} finally {
  await browser.close();
}
