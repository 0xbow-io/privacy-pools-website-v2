// @ts-nocheck - drives a real browser with real playwright types.
//
// No-deposit browser smokes: the app on the PROD world (?env=prod) with a
// read-only wallet. Nothing here needs Sepolia funds, a deposit or an ASP
// approval, so these checks give a verdict while the funded journey is down.
//
// The wallet is a fresh random key per run. It signs messages (so an EOA can
// unlock its account keys) and REFUSES every transaction method: a smoke can
// open any form and review any quote, but it can never broadcast. Reads go
// through node to public RPCs, so the page's own RPC traffic is unchanged.
//
// Every page gets the share-name guard (../share-name-guard.ts) from the start.
//
// Run one: PROBE_URL=http://localhost:8081 bun scripts/e2e/smoke/<name>.smoke.ts
// Run all: bun scripts/e2e/smoke/run-all.ts
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { installShareNameGuard, type ShareNameGuard } from '../share-name-guard.ts';

export const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
export const BASE = process.env.PROBE_URL || 'http://localhost:8081';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
};
const rpcFor = (chainId: number) => process.env[`E2E_RPC_${chainId}`] || RPC[chainId] || RPC[1];

const SEND_METHODS = new Set(['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction', 'wallet_sendCalls']);

// ---------------------------------------------------------------- verdicts

const failures: string[] = [];
export function check(ok: boolean, label: string, detail = ''): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(detail ? `${label} (${detail})` : label);
  return ok;
}

/** Print the verdict and exit: non-zero on any failed check or share name. */
export async function finish(name: string, browser?: Browser): Promise<never> {
  await browser?.close().catch(() => {});
  if (failures.length) {
    console.error(`\n${name}: ${failures.length} check(s) failed:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log(`\n${name}: all checks passed`);
  // The guard's exit hook still turns an unchecked hit into a failure.
  process.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------- browser

export type Smoke = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  guard: ShareNameGuard;
  /** The test wallet's address (lowercase). */
  address: string;
  /** Transaction methods the page asked the wallet for (all refused). */
  refusedSends: string[];
  /** Run a guard checkpoint and record it as a check instead of throwing. */
  guardStep: (step: string) => Promise<boolean>;
  shot: (name: string) => Promise<void>;
  text: () => Promise<string>;
};

export async function launch(tag: string, opts: {
  /** Answer eth_getCode for the wallet with bytecode, as a smart-contract wallet. */
  smartWallet?: boolean;
  viewport?: { width: number; height: number };
  /**
   * Limit the share-name guard to the surface this smoke owns (a CSS selector),
   * when another surface's share names are another PR's to fix. The whole page
   * when omitted.
   */
  guardScope?: string;
} = {}): Promise<Smoke> {
  // Locally a system Chromium (E2E_CHROMIUM=/usr/bin/chromium) or the pinned
  // build; in CI `playwright install` puts it where playwright looks.
  const candidates = [
    process.env.E2E_CHROMIUM,
    `${ROOT}/.pw-browsers/chromium-1228/chrome-linux64/chrome`,
  ].filter(Boolean) as string[];
  const exe = candidates.find((p) => existsSync(p));
  const browser = await chromium.launch({
    headless: true,
    ...(exe ? { executablePath: exe } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  // Metro compiles the bundle on the first request: minutes on a cold runner.
  context.setDefaultNavigationTimeout(240_000);
  context.setDefaultTimeout(60_000);

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const address = account.address.toLowerCase();
  const refusedSends: string[] = [];
  const fakeCode = `0x6080604052${'ab'.repeat(200)}`;

  await context.exposeBinding('__smokeWallet', async (_src, method: string, params: unknown[], chainId: number) => {
    if (SEND_METHODS.has(method)) {
      refusedSends.push(method);
      console.log(`  [wallet] REFUSED ${method}`);
      return { error: { code: 4001, message: 'The smoke wallet refuses every transaction' } };
    }
    if (method === 'personal_sign') {
      if (opts.smartWallet) return { result: `0x${'cd'.repeat(160)}` };
      return { result: await account.signMessage({ message: { raw: params[0] as `0x${string}` } }) };
    }
    if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
      if (opts.smartWallet) return { result: `0x${'cd'.repeat(160)}` };
      const typed = typeof params[1] === 'string' ? JSON.parse(params[1] as string) : params[1];
      return { result: await account.signTypedData(typed) };
    }
    if (opts.smartWallet && method === 'eth_getCode' && String(params?.[0]).toLowerCase() === address) return { result: fakeCode };
    try {
      const res = await fetch(rpcFor(chainId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json();
      return json.error ? { error: json.error } : { result: json.result };
    } catch (e) {
      return { error: { code: -32603, message: String(e) } };
    }
  });
  await context.addInitScript(({ addr }) => {
    let chainId = 1;
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    const emit = (ev: string, v: unknown) => (listeners[ev] || []).forEach((f) => { try { f(v); } catch {} });
    const provider = {
      isSmokeTestWallet: true,
      request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'net_version') return String(chainId);
        if (method === 'wallet_switchEthereumChain') {
          chainId = parseInt((params[0] as { chainId: string }).chainId, 16);
          emit('chainChanged', `0x${chainId.toString(16)}`);
          return null;
        }
        if (method === 'wallet_addEthereumChain') return null;
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
        if (method === 'wallet_getCapabilities') return {};
        const r = await (window as any).__smokeWallet(method, params, chainId);
        if (r.error) { const e: any = new Error(r.error.message); e.code = r.error.code; throw e; }
        return r.result;
      },
      on: (ev: string, f: (v: unknown) => void) => { (listeners[ev] = listeners[ev] || []).push(f); return provider; },
      removeListener: (ev: string, f: (v: unknown) => void) => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); return provider; },
    };
    (window as any).ethereum = provider;
    const info = { uuid: '0b0b5a0e-0000-4000-8000-00000000500e', name: 'Smoke Test Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.0xbow.smoke-test' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
    // No smart-wallet upsell in front of the flows.
    try { localStorage.setItem('ppv2_smartwallet_skipped_v1', '1'); } catch {}
  }, { addr: address });

  const page = await context.newPage();
  if (opts.smartWallet) {
    // The app's own RPC reads (not only the wallet's) must see the contract.
    await page.route('**/*', async (route) => {
      const req = route.request();
      const body = req.method() === 'POST' ? req.postData() || '' : '';
      if (!body.includes('eth_getCode') || !body.toLowerCase().includes(address.slice(2))) return route.fallback();
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { return route.fallback(); }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const hit = (c: any) => c?.method === 'eth_getCode' && String(c.params?.[0]).toLowerCase() === address;
      if (!list.some(hit)) return route.fallback();
      const res = await route.fetch();
      let out: any = await res.json().catch(() => null);
      const outs = Array.isArray(out) ? out : [out];
      for (const o of outs) {
        const c = list.find((x) => x?.id === o?.id);
        if (c && hit(c)) { delete o.error; o.result = fakeCode; }
      }
      return route.fulfill({ response: res, body: JSON.stringify(Array.isArray(out) ? outs : outs[0]) });
    });
  }
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 200)));
  const guard = await installShareNameGuard(page, { label: tag, scope: opts.guardScope });
  let n = 0;
  const smoke: Smoke = {
    browser, context, page, guard, address, refusedSends,
    async guardStep(step) {
      try {
        // The (i) hints only paint their text on hover, so the guard would
        // never see it: hover each one (it scans on the DOM change).
        const hints = (opts.guardScope ? page.locator(opts.guardScope).locator('text="ⓘ"') : page.locator('text="ⓘ"'))
          .filter({ visible: true });
        const count = Math.min(await hints.count().catch(() => 0), 12);
        for (let i = 0; i < count; i++) {
          await hints.nth(i).hover({ timeout: 3000 }).catch(() => {});
          await sleep(400);
          await guard.checkpoint(`${step} (hint ${i + 1})`);
        }
        if (count) await page.mouse.move(0, 0).catch(() => {});
        await guard.checkpoint(step);
        return check(true, `${step}: no share name on screen`);
      } catch (e) {
        return check(false, `${step}: no share name on screen`, String((e as Error).message).split('\n').slice(1).join(' | ').trim());
      }
    },
    async shot(name) {
      n += 1;
      await page.screenshot({ path: `${ROOT}/.e2e-shots/smoke-${tag}-${n}-${name}.png` }).catch(() => {});
    },
    text: () => page.evaluate(() => document.body.innerText).catch(() => ''),
  };
  return smoke;
}

// ---------------------------------------------------------------- page helpers

/** Wait until `settled(text)` or the budget runs out; returns the last text. */
export async function textUntil(page: Page, settled: (text: string) => boolean, budgetMs = 45_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const text = (await page.evaluate(() => document.body.innerText).catch(() => '')) ?? '';
    if (settled(text) || Date.now() >= deadline) return text;
    await sleep(250);
  }
}

/** Open a prod-world URL and wait for the app to have rendered. */
export async function open(page: Page, path: string): Promise<string> {
  // The query goes before a #fragment: a pay link carries its payload there.
  const hashAt = path.indexOf('#');
  const route = hashAt < 0 ? path : path.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : path.slice(hashAt);
  const sep = route.includes('?') ? '&' : '?';
  await page.goto(`${BASE}${route}${sep}env=prod${hash}`, { waitUntil: 'domcontentloaded' });
  return textUntil(page, (t) => /Ethereum|BNB|Citrea|Shield|Portfolio/i.test(t) && t.length > 200, 240_000);
}

/** Connect the smoke wallet through the app's own picker, if it is not connected yet. */
export async function connect(page: Page): Promise<boolean> {
  const connected = async () => /0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(await page.evaluate(() => document.body.innerText).catch(() => ''));
  for (let i = 0; i < 20 && !(await connected()); i++) {
    const picker = page.getByText('Smoke Test Wallet').first();
    if (await picker.isVisible().catch(() => false)) {
      await picker.click().catch(() => {});
      await sleep(3000);
      continue;
    }
    const btn = page.getByText(/^Connect( Wallet)?$/).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
    await sleep(1500);
  }
  return connected();
}

/** Unlock the account keys with a wallet signature when the gate is up (EOA path). */
export async function unlockWithWallet(page: Page, budgetMs = 90_000): Promise<boolean> {
  const gate = /Unlock with passkey|Unlock your account/;
  const deadline = Date.now() + budgetMs;
  if (!gate.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) return false;
  const walletPath = page.getByText('Use wallet signature instead', { exact: false }).first();
  if (await walletPath.isVisible().catch(() => false)) { await walletPath.click().catch(() => {}); await sleep(1000); }
  await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) =>
      getComputedStyle(d).position === 'fixed' && /Unlock (with passkey|your account)/.test(d.textContent || ''));
    const host = overlays.pop() ?? document.body;
    for (const want of ['Sign in', 'Sign message', 'Continue']) {
      const cta = Array.from(host.querySelectorAll('*')).find((el) => el.textContent?.trim() === want && el.children.length === 0) as HTMLElement | undefined;
      if (cta) { ((cta.closest('button,[role="button"]') as HTMLElement) ?? cta).click(); return; }
    }
  });
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!gate.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) return true;
  }
  return false;
}

/** Open a hub tab by its test id; false when the tab is not offered. */
export async function hubTab(page: Page, key: 'shield' | 'withdraw' | 'send' | 'swap' | 'request'): Promise<boolean> {
  const target = page.getByTestId(`hub-tab-${key}`).filter({ visible: true }).first();
  if (!(await target.count())) return false;
  await target.click({ timeout: 30_000 }).catch(() => {});
  return page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]):visible`).first()
    .waitFor({ timeout: 30_000 }).then(() => true, () => false);
}

/**
 * Hold every request whose body or URL matches until `release()`. Used to pin
 * the state BEFORE a feed has answered (the share rate, the yield inputs),
 * which on a fast machine otherwise lasts a few milliseconds.
 */
export async function hold(page: Page, matches: (url: string, body: string) => boolean): Promise<{ held: () => number; release: () => void }> {
  let released = false;
  let held = 0;
  const waiting: (() => void)[] = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const body = req.method() === 'POST' ? req.postData() || '' : '';
    if (released || !matches(req.url(), body)) return route.fallback();
    held += 1;
    await new Promise<void>((r) => waiting.push(r));
    return route.fallback();
  });
  return {
    held: () => held,
    release: () => { released = true; waiting.splice(0).forEach((r) => r()); },
  };
}

/** A JSON-RPC body that reads an ERC-4626 share rate (convertToAssets). */
export const isShareRateRead = (_url: string, body: string) => body.includes('07a2d13a');

/**
 * The share rates the PAGE itself received, read off its own convertToAssets
 * answers (never assumed): vault address (lower-case) to the underlying base
 * units one whole share is worth, `assets / shares * 10^shareDecimals`.
 * Install before the page loads; the latest answer per vault wins.
 */
export function trackShareRates(page: Page): { rateOf: (vault: string) => bigint | undefined; seen: () => number } {
  const rates = new Map<string, bigint>();
  page.on('response', async (res) => {
    const req = res.request();
    if (req.method() !== 'POST') return;
    const body = req.postData() || '';
    if (!isShareRateRead(res.url(), body)) return;
    try {
      const calls = [].concat(JSON.parse(body));
      const answers = [].concat(await res.json());
      for (const call of calls) {
        const arg = call?.params?.[0];
        const data: string = String(arg?.data ?? arg?.input ?? '');
        if (call?.method !== 'eth_call' || !data.toLowerCase().startsWith('0x07a2d13a')) continue;
        const answer = answers.find((a: any) => a?.id === call.id);
        if (!answer?.result || answer.result === '0x') continue;
        const shares = BigInt(`0x${data.slice(10)}`);
        const assets = BigInt(answer.result);
        // The app asks for one whole share, so the answer IS assets per share.
        if (shares > 0n && assets > 0n) rates.set(String(arg.to).toLowerCase(), assets);
      }
    } catch { /* a body that is not a rate answer is not a rate */ }
  });
  return { rateOf: (vault) => rates.get(vault.toLowerCase()), seen: () => rates.size };
}

/**
 * The figure the app must print for `sharesWei` of a yield share (DEV-621):
 * the UNDERLYING it is worth at `assetsPerShare`, in integers, rounded up to
 * the next base unit (a typed amount was floored into shares) and then cut
 * DOWN for display, with no share symbol. Stablecoins show exactly 2 decimals;
 * any other coin 5 decimals, trailing zeros dropped but never below 2.
 */
export function expectedUnderlyingLabel(sharesWei: bigint, assetsPerShare: bigint, shareDecimals: number, coin: { symbol: string; decimals: number; stable: boolean }): string {
  const unit = 10n ** BigInt(shareDecimals);
  const product = sharesWei * assetsPerShare;
  const wei = product / unit + (product % unit > 0n ? 1n : 0n);
  const digits = coin.stable ? 2 : 5;
  const base = 10n ** BigInt(coin.decimals);
  const whole = wei / base;
  const frac = (wei % base).toString().padStart(coin.decimals, '0').slice(0, digits).padEnd(digits, '0');
  const trimmed = coin.stable ? frac : frac.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed} ${coin.symbol}`;
}

/** Every line of the page text that is exactly an amount ("5.00 USDC", "… USDC"). */
export function amountLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^(?:[\d,]+(?:\.\d+)?|…|<0\.01)\s+[A-Za-z]{2,6}$/.test(l));
}

/**
 * Poll the page until `label()` (re-read each poll, it may wait on a rate) is shown as a whole line (the payment or receipt
 * amount), up to `budgetMs`. Returns the amount lines last seen, so a failure
 * says what the page printed instead.
 */
export async function amountShown(page: Page, label: () => string | undefined, budgetMs = 60_000): Promise<{ ok: boolean; lines: string[] }> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const text = (await page.evaluate(() => document.body.innerText).catch(() => '')) ?? '';
    const lines = amountLines(text);
    const want = label();
    if (want && lines.includes(want)) return { ok: true, lines };
    if (Date.now() >= deadline) return { ok: false, lines };
    await sleep(500);
  }
}
