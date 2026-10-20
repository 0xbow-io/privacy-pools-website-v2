// Run against a production export: PROBE_URL=http://localhost:8083 node scripts/e2e/landing-document.mjs
// Check the delivered document, not an import of the content generator.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.PROBE_URL ?? 'http://localhost:8083';
const browser = await chromium.launch({ headless: true });
try {
  const plain = await browser.newPage({ javaScriptEnabled: false });
  const response = await plain.goto(base);
  assert.equal(response.status(), 200);
  const document = plain.locator('#landing-document');
  await document.waitFor({ state: 'visible' });
  assert.equal(await plain.getByRole('heading', { level: 1 }).innerText(), 'Privacy for public chains.');
  for (const name of ['What stays private?', 'Why are deposits reviewed?', 'Who controls my funds?', 'Which assets and networks can I use?']) {
    await plain.getByRole('heading', { name, exact: true }).waitFor();
  }
  const text = await document.innerText();
  assert.match(text, /Shielding is public and reveals your address, asset, and amount shielded/);
  assert.match(text, /Your deposit needs approval before it can be used for private transactions/);
  await plain.getByRole('link', { name: 'Threat Model', exact: true }).waitFor();
  await plain.getByRole('link', { name: 'Ragequit', exact: true }).waitFor();
  await plain.getByRole('link', { name: 'Explore the SDK', exact: true }).waitFor();

  const canonical = await plain.locator('link[rel="canonical"]').getAttribute('href');
  const metadata = JSON.parse(await plain.locator('script[type="application/ld+json"]').textContent());
  const website = metadata['@graph'].find(item => item['@type'] === 'WebSite');
  const organization = metadata['@graph'].find(item => item['@type'] === 'Organization');
  assert.equal(website.url, canonical);
  assert.equal(website.name, 'Privacy Pools');
  assert.equal(website.publisher['@id'], organization['@id']);
  assert.equal(organization.name, '0xbow');
  assert.equal(organization.url, await plain.getByRole('link', { name: '0xbow', exact: true }).getAttribute('href'));
  const sitemap = await plain.request.get(`${base}/sitemap.xml`);
  assert.equal(sitemap.status(), 200);
  assert.match(sitemap.headers()['content-type'], /xml/);
  const xml = await sitemap.text();
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [canonical]);
  const robots = await plain.request.get(`${base}/robots.txt`);
  assert.equal(robots.status(), 200);
  assert.ok((await robots.text()).split(/\r?\n/).includes(`Sitemap: ${canonical}sitemap.xml`));

  const interactive = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  interactive.on('pageerror', error => errors.push(error.message));
  // Pause every application script: the fallback must not flash before mount.
  const release = Promise.withResolvers();
  await interactive.route('**/*.js', async route => { await release.promise; await route.continue(); });
  try {
    await interactive.goto(base, { waitUntil: 'commit' });
    await interactive.locator('#landing-document').waitFor({ state: 'attached' });
    assert.equal(await interactive.locator('#landing-document').isVisible(), false);
  } finally { release.resolve(); }
  await interactive.getByTestId('hub-shield-pay-token').waitFor();
  await interactive.getByTestId('front-page').waitFor();
  assert.equal(await interactive.locator('#landing-document').count(), 0);
  const staticHeadings = await document.locator('h2').allTextContents();
  const liveHeadings = await interactive.getByTestId('front-page').getByRole('heading', { level: 2 }).allTextContents();
  const normalize = value => value.replace(/\s+/g, ' ').trim();
  assert.deepEqual(liveHeadings.map(normalize), staticHeadings.map(normalize));
  const liveLinks = new Set(await interactive.getByTestId('front-page').locator('a[href^="https://"]').evaluateAll(links => links.map(link => link.href)));
  for (let i = 0; i < 4; i++) {
    const question = interactive.getByTestId(`landing-faq-${i}`);
    if (await question.getAttribute('aria-expanded') !== 'true') await question.click();
    const answer = await interactive.locator(`#landing-answer-${i}`).innerText();
    assert.ok(normalize(text).includes(normalize(answer)), 'The HTML and interactive FAQ answers must agree');
    for (const href of await interactive.locator(`#landing-answer-${i} a`).evaluateAll(links => links.map(link => link.href))) liveLinks.add(href);
  }
  const staticLinks = await document.locator('a[href^="https://"]').evaluateAll(links => links.map(link => link.href));
  assert.deepEqual([...new Set(staticLinks)].sort(), [...liveLinks].sort());
  await interactive.setViewportSize({ width: 930, height: 900 });
  const explore = interactive.getByTestId('site-header').getByText('Explore', { exact: true });
  await explore.waitFor({ state: 'visible' });
  await explore.click();
  await interactive.waitForURL('**/explore');
  assert.deepEqual(errors, []);
  console.log('Landing HTML: readable without JavaScript, matching live copy, linked metadata/sitemap, and no startup flash');
} finally {
  await browser.close();
}
