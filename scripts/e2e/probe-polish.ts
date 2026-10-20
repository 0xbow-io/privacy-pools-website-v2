// @ts-nocheck
// QA sweep for the "Polish Explore" and "Polish Asset Pool page" todo items.
// Visits the Explore surfaces and the Sepolia ETH pool page (desktop + mobile),
// signed in as A, and reports: page/console errors, suspicious figures
// (NaN / undefined / [object), em dashes in copy (house rule: none), and
// whether the ?action deep links open the right panel. Screenshots per page.
import { accountFromKey, bodyText, clickButton, openApp, signIn, sleep, unlockIfPrompted, waitForText } from './lib';
import { envValue } from './funding';

const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const A = accountFromKey(aKey.startsWith('0x') ? aKey : `0x${aKey}`);
const BASE = process.env.PROBE_URL || 'http://localhost:8081';

const PAGES: Array<{ name: string; path: string; expect?: RegExp; action?: 'deposit' | 'withdraw' }> = [
  { name: 'explore', path: '/explore' },
  { name: 'stats-redirect', path: '/stats', expect: /Explore|Total value|pools/i },
  { name: 'explore-balances', path: '/explore/balances', expect: /My private balance/i },
  { name: 'explore-activity', path: '/explore/activity', expect: /Activity|Transactions/i },
  { name: 'explore-pools-legacy', path: '/explore/pools' },
  { name: 'pool-eth', path: '/chains/sepolia/eth' },
  { name: 'pool-eth-deposit', path: '/chains/sepolia/eth?action=deposit', action: 'deposit' },
  { name: 'pool-eth-withdraw', path: '/chains/sepolia/eth?action=withdraw', action: 'withdraw' },
  { name: 'pool-usdc', path: '/chains/sepolia/usdc' },
  { name: 'pool-bogus', path: '/chains/sepolia/doge' },
];

const app = await openApp(A, { tag: 'polish' });
const errors: string[] = [];
app.page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
app.page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Download the React DevTools/i.test(m.text())) errors.push(`console.error: ${m.text().slice(0, 200)}`); });

const findings: string[] = [];
async function sweep(label: string, viewport: { width: number; height: number }) {
  await app.page.setViewportSize(viewport);
  for (const p of PAGES) {
    const before = errors.length;
    await app.page.goto(`${BASE}${p.path}`, { waitUntil: 'domcontentloaded' }).catch((e) => findings.push(`${label}/${p.name}: goto failed ${e.message.slice(0, 80)}`));
    await sleep(5000);
    await unlockIfPrompted(app.page);
    await sleep(1500);
    const t = await bodyText(app.page);
    const url = app.page.url();
    if (p.expect && !p.expect.test(t)) findings.push(`${label}/${p.name}: expected ${p.expect} not found (url ${url})`);
    for (const bad of [/\bNaN\b/, /\bundefined\b/, /\[object /, /\$-?\d+\.\d{3,}/]) {
      const m = t.match(bad); if (m) findings.push(`${label}/${p.name}: suspicious text "${m[0]}" near "${t.slice(Math.max(0, m.index! - 40), m.index! + 40).replace(/\n/g, ' ')}"`);
    }
    const dashes = (t.match(/—/g) ?? []).length;
    if (dashes) findings.push(`${label}/${p.name}: ${dashes} em dash(es) in copy, e.g. "${t.split('\n').find((l) => l.includes('—'))?.slice(0, 100)}"`);
    if (p.action) {
      const opened = p.action === 'deposit' ? /Shield|Deposit/i.test(t) && /Into .* pool|Shield ETH|Deposit/.test(t) : /Withdraw/i.test(t) && /Shielded balance|Withdraw/.test(t);
      // The deep link should open the matching panel with the ETH pool selected.
      const panelText = p.action === 'deposit' ? /Shield ETH|Deposit ETH/i : /Withdraw/i;
      if (!panelText.test(t)) findings.push(`${label}/${p.name}: ?action=${p.action} did not open the ${p.action} panel`);
      if (!/ETH/.test(t)) findings.push(`${label}/${p.name}: pool asset ETH not visible after deep link`);
      void opened;
    }
    if (p.name === 'pool-bogus' && !/not found|unknown|No pool|Pool not/i.test(t)) findings.push(`${label}/${p.name}: bogus pool route shows no not-found state (url ${url}; title line "${t.split('\n').find((l) => l.trim())?.slice(0, 60)}")`);
    const newErrors = errors.slice(before);
    for (const e of newErrors.slice(0, 3)) findings.push(`${label}/${p.name}: ${e}`);
    await app.shot(`${label}-${p.name}`);
    console.log(`  swept ${label}/${p.name} (${url}) errors=${newErrors.length}`);
  }
}

try {
  await app.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await signIn(app.page);
  await clickButton(app.page, 'My balances');
  await sleep(1500);
  if (/Sign in to sync/i.test(await bodyText(app.page))) { await clickButton(app.page, 'Sign in'); await sleep(1500); }
  await unlockIfPrompted(app.page);
  await waitForText(app.page, /My private balance/i, 60_000);
  await sweep('desktop', { width: 1440, height: 1200 });
  await sweep('mobile', { width: 390, height: 844 });
} finally {
  await app.browser.close();
}

console.log('\n===== polish sweep findings =====');
if (findings.length === 0) console.log('none');
for (const f of findings) console.log(`- ${f}`);
console.log(`(total console/page errors: ${errors.length})`);
