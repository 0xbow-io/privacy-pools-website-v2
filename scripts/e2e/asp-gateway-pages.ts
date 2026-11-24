// @ts-nocheck - uses Bun runtime APIs (Bun.serve, Bun.file); the repo type-checks against a minimal Bun stub.
//
// Opens the public pages of a build that calls a chosen ASP gateway. asp-v2's CI builds this site for staging with
// EXPO_PUBLIC_ASP_URL set to a pull request's own gateway and runs this script, so a gateway change that breaks a
// page fails before it merges. No wallet is connected and nothing is sent.
//
// A page fails when it throws, when it never calls the gateway, or when the gateway answers in a way that means the
// two disagree. That is a 5xx, a 400, or a 404 for a route that doesn't exist. Any other 404 is a missing row or
// feed, such as a pool the test data doesn't have.
//
//   ASP_URL=http://localhost:3203 bun scripts/e2e/asp-gateway-pages.ts [dist]
import { launchChrome } from '../lib/chrome.mjs';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const ASP = (process.env.ASP_URL ?? '').replace(/\/+$/, '');
if (!ASP) {
  console.error('ASP_URL is required: the gateway the build calls');
  process.exit(2);
}
// A URL on the gateway, and not on a host whose port only starts with the gateway's, such as :32030 for :3203.
const onAsp = (url: string) => url === ASP || url.startsWith(`${ASP}/`) || url.startsWith(`${ASP}?`);
const ROOT = process.argv[2] ?? join(import.meta.dir, '..', '..', 'dist');
const PAGES = ['/', '/stats', '/explore', '/chains/sepolia/eth', '/chains/sepolia/usdc', '/chains/stellar', '/chains/sui'];

// The export is a single page, and vercel.json sends every path that isn't a file to it.
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const file = join(ROOT, normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, ''));
    return new Response(Bun.file(existsSync(file) && statSync(file).isFile() ? file : join(ROOT, 'index.html')));
  },
});
const BASE = `http://localhost:${server.port}`;

function disagreement(status: number, body: string): boolean {
  if (status >= 500 || status === 400) return true;
  return status === 404 && /Cannot (GET|POST) /.test(body);
}

const browser = await launchChrome();
let failures = 0;
for (const path of PAGES) {
  const page = await browser.newPage();
  const errors: string[] = [];
  const breaks = new Set<string>();
  const reads: Promise<void>[] = [];
  let asked = 0;
  let open = 0;
  let lastChange = Date.now();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (!onAsp(r.url())) return;
    asked += 1;
    open += 1;
    lastChange = Date.now();
  });
  const closed = (r) => {
    if (!onAsp(r.url())) return;
    open -= 1;
    lastChange = Date.now();
  };
  page.on('requestfinished', closed);
  page.on('requestfailed', (r) => {
    closed(r);
    if (onAsp(r.url()) && !(r.failure()?.errorText ?? '').includes('ERR_ABORTED')) {
      breaks.add(`${r.method()} ${r.url().slice(ASP.length)} failed: ${r.failure()?.errorText}`);
    }
  });
  page.on('response', (r) => {
    if (!onAsp(r.url()) || r.status() < 400) return;
    reads.push(
      r
        .text()
        .catch(() => '')
        .then((body) => {
          if (disagreement(r.status(), body)) breaks.add(`${r.url().slice(ASP.length)} -> ${r.status()} ${body.slice(0, 140)}`);
        }),
    );
  });

  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 120_000;
  // waitForLoadState('networkidle') returns at once when the page was idle earlier in start-up, so this waits until
  // the page has called the gateway and no call has been open for 2 s.
  while ((asked === 0 || open > 0 || Date.now() - lastChange < 2_000) && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }
  await Promise.all(reads);
  const problems = [
    ...errors.map((e) => `page error: ${e}`),
    ...breaks,
    ...(asked === 0 ? ['never called the gateway'] : []),
    ...(Date.now() >= deadline && open > 0 ? [`${open} gateway requests still open after 120 s`] : []),
  ];
  console.log(`${problems.length ? 'FAIL' : 'PASS'} ${path}: ${asked} gateway requests${problems.length ? `\n  ${problems.join('\n  ')}` : ''}`);
  failures += problems.length ? 1 : 0;
  await page.close();
}
await browser.close();
server.stop();
console.log(failures ? `${failures} of ${PAGES.length} pages failed` : `all ${PAGES.length} pages passed`);
process.exit(failures ? 1 : 0);
