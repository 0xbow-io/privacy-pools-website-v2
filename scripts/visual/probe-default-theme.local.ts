import { chromium } from 'playwright';
const BASE = process.env.PROBE_URL ?? 'http://localhost:8080';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
// NO ?theme param, NO stored variant — fresh visitor.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
const cls = await page.evaluate(() => document.documentElement.className);
const stored = await page.evaluate(() => window.localStorage.getItem('ppv2_design_variant'));
console.log('root class:', cls, '| stored variant:', stored);
await page.screenshot({ path: '.pwcheck/default-theme.png' });
await browser.close();
