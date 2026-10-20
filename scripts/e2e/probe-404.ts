// @ts-nocheck
// ONE-OFF: which request 404s on the USDC pool page?
import { accountFromKey, openApp, sleep } from './lib';
import { envValue } from './funding';
const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const A = accountFromKey(aKey.startsWith('0x') ? aKey : `0x${aKey}`);
const app = await openApp(A, { tag: 'p404' });
const bad: string[] = [];
app.page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`); });
await app.page.goto(`${process.env.PROBE_URL || 'http://localhost:8081'}/chains/sepolia/usdc`, { waitUntil: 'domcontentloaded' });
await sleep(9000);
console.log(bad.length ? bad.join('\n') : 'no 4xx/5xx responses');
await app.browser.close();
