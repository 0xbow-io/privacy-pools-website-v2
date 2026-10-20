// @ts-nocheck - drives a real browser with real playwright types; playwright is a
// repo also declares a limited fallback stub for offline tooling
// (see scripts/visual/playwright-fallback.d.ts).
// Shared plumbing for the on-chain Sepolia e2e runs.
//
// No MetaMask and no browser extension: the account is announced to the page as
// an EIP-6963 provider (scripts/visual/evm-wallet.ts), so wagmi discovers and
// auto-connects it, and every signature and broadcast happens node-side with
// viem. That makes a run frictionless: no wallet popups to drive, nothing to
// click except the app's own UI.
import { chromium, type Browser, type Page } from 'playwright';
import type { CapturedRequest } from './network-privacy';
import { startNetworkCapture } from './network-capture';
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionData, formatEther, http, parseEther } from 'viem';
import { ENTRYPOINT_DEPOSIT_ABI } from '@privacy-pools-v2/sdk';
import { sepolia } from 'viem/chains';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { installEvmWallet } from '../visual/evm-wallet';
import { waitForApproval } from './approval-wait';
import { FIXTURE_NOTE_ETH, PAYMENT_FEE_RESERVE_ETH } from './funding';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
// The relayer's CORS allowlist contains http://localhost:8081 and no other local
// origin, so the app must be served from that port or the browser blocks every
// quote request: it looks like the flow simply stalls.
export const BASE = process.env.PROBE_URL || 'http://localhost:8081';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tabs that own a card in the hub, used to attribute inputs to a flow. */
export type Owner = 'Shield' | 'Withdraw' | 'Send';

/**
 * .env, parsed here rather than read from the environment: safewrap clears the
 * env, so a probe that trusted process.env silently saw nothing.
 */
export function env(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = `${ROOT}/.env`;
  if (!existsSync(p)) throw new Error(`.env not found at ${p}`);
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** CI passes E2E_PK for either a fixed account or the fresh-account journey. */
export function account(which: 'DEV_PK' | 'DEV_PK2' | 'TEST_PHRASE'): PrivateKeyAccount {
  const injected = process.env.E2E_PK;
  if (injected) {
    return privateKeyToAccount(`0x${injected.replace(/^0x/, '')}` as `0x${string}`);
  }
  const v = env()[which];
  if (!v) throw new Error(`${which} missing from .env`);
  return which === 'TEST_PHRASE'
    ? (mnemonicToAccount(v) as unknown as PrivateKeyAccount)
    : privateKeyToAccount(`0x${v.replace(/^0x/, '')}` as `0x${string}`);
}

/** An account from a raw private key, which is how CI passes its secrets. */
export function accountFromKey(key: string): PrivateKeyAccount {
  return privateKeyToAccount(`0x${key.replace(/^0x/, '')}` as `0x${string}`);
}

export function publicClient() {
  const e = env();
  const url = e.EXPO_PUBLIC_ALCHEMY_KEY
    ? `https://eth-sepolia.g.alchemy.com/v2/${e.EXPO_PUBLIC_ALCHEMY_KEY}`
    : e.EXPO_PUBLIC_RPC_URL!;
  return createPublicClient({ chain: sepolia, transport: http(url) });
}

/** Open a browser with the account installed as a live, broadcasting wallet. */
export async function openApp(
  acct: PrivateKeyAccount,
  opts: {
    tag: string;
    /** The chain the wallet starts on, e.g. 10 for OP. Sepolia when omitted. */
    initialChainId?: number;
  },
): Promise<{
  browser: Browser;
  page: Page;
  shot: (n: string) => Promise<void>;
  sent: `0x${string}`[];
  appLogs: string[];
  /** Outbound requests in the explicitly started observation window. */
  captured: CapturedRequest[];
  flushCapture: () => Promise<void>;
  clearCapture: () => void;
  startCapture: () => Promise<void>;
  stopCapture: () => Promise<void>;
}> {
  // Locally the browser is pinned under .pw-browsers; in CI `playwright install`
  // puts it in its own cache, so fall back to playwright's resolution instead of
  // failing on a path that only exists on one machine.
  const pinned = `${ROOT}/.pw-browsers/chromium-1228/chrome-linux64/chrome`;
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(pinned) ? { executablePath: pinned } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const capture = startNetworkCapture(context, { enabled: false, file: process.env.E2E_RPC_CAPTURE, devServerOrigin: BASE });
  // Allow UI actions to finish while Metro and proof workers share the runner.
  // Journey assertions still require explicit success and confirmed outcomes.
  const ACTION_TIMEOUT_MS = Number(process.env.E2E_ACTION_TIMEOUT_MS ?? 90_000);
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(Math.max(ACTION_TIMEOUT_MS, 120_000));
  // The smart-wallet upsell would otherwise sit in front of the flow.
  // E2E_NO_DEBUG exists to separate two costs that both scale with note count.
  // The withdraw spendability effect builds an array of EVERY note purely to log
  // it, and with debug on that array is also serialised to the console and
  // captured by the handler below — so at ~100 notes the instrumentation is
  // doing real work on every effect run. Turning debug off tells us whether a
  // slow click is the product or the observation of it.
  const debugOff = process.env.E2E_NO_DEBUG === '1';
  await context.addInitScript((skipDebug) => {
    localStorage.setItem('ppv2_smartwallet_skipped_v1', '1');
    // Debug mode on: the app's log() only reaches the console when it is, and
    // without it a run cannot see the providers' own decisions (a press that
    // returns early looks identical to a press that never landed).
    if (!skipDebug) localStorage.setItem('ppv2_debug', '1');
  }, debugOff);
  if (opts.initialChainId !== undefined) {
    const hex = `0x${opts.initialChainId.toString(16)}`;
    await context.addInitScript((chainHex) => {
      (window as unknown as { __hwInitialChainId?: string }).__hwInitialChainId = chainHex;
    }, hex);
  }
  const page = await context.newPage();
  const debugClose = page.getByRole('button', { name: 'Close debug logs', exact: true });
  // Instrumentation can sit behind the unlock modal; a forced pointer click
  // would hit that modal instead. Dismiss only the debug control directly.
  await page.addLocatorHandler(debugClose, () => debugClose.evaluate(button => button.click()));
  await capture.attachPage(page);
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 160)));
  const appLogs: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/\[(Deposit|Withdraw|Transfer|Relayer|Session|PayRequest|PaymentRequest|PaymentTransfer|SeedDerivationModal|PrivacyPools|KeystoreRegistration|SDK|NoteDiscovery|Claim|ViewingKey|PoolPage|PrivacyIndex)\]|proof|revert|insufficient|error/i.test(t)) {
      appLogs.push(t);
      console.log('  [app]', t.slice(0, 220));
    }
  });
  // Capture was installed before page creation/navigation. The browser API
  // omits some upload bytes; an incomplete observation fails flushCapture().
  // Capture each preparation or transaction phase; flush before asserting and
  // clear only after its verdict. See network-capture.ts for scope/limits.
  // Every hash the flow broadcasts, so a phase can assert on the receipt rather
  // than on a balance read that races the block.
  const sent: `0x${string}`[] = [];
  await installEvmWallet(page, acct, { liveSend: true, onSend: (h) => sent.push(h) });
  let n = 0;
  const shot = async (name: string) => {
    n += 1;
    await page.screenshot({ path: `${ROOT}/.e2e-shots/${opts.tag}-${n}-${name}.png` });
  };
  return { browser, page, shot, sent, appLogs, captured: capture.captured, flushCapture: capture.flushCapture, clearCapture: capture.clearCapture, startCapture: capture.startCapture, stopCapture: capture.stopCapture };
}

// Navigation-safe: an in-flight page navigation destroys the execution context
// mid-evaluate and playwright throws instead of returning - which killed a
// whole withdraw phase once (wd6, 2026-08-27). One short retry absorbs it.
export async function bodyText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body.innerText);
  } catch (err) {
    if (!/Execution context was destroyed|Target closed/i.test(String(err))) throw err;
    await sleep(1500);
    return page.evaluate(() => document.body.innerText).catch(() => '');
  }
}

/** Land connected; the keystore unlock itself is raised later, by the first action. */
export async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, null, { timeout: 120_000 });
  // wagmi usually auto-connects to the announced provider, but not always: the
  // connect picker can win the race, and while it is up no keys are derived and
  // the card reports a 0 shielded balance.
  //
  // Connected is checked FIRST and the picker only when we are not: the picker's
  // markup stays in the DOM after it closes, so keying on its text alone made
  // this loop pick the wallet forever and never notice it had connected.
  let pickerTries = 0;
  for (let i = 0; i < 45; i++) {
    const t = await bodyText(page);
    if (/0x[0-9a-fA-F]{2,6}(…|\.\.\.)/.test(t)) break;
    if (/Pick how you want to connect/.test(t) && pickerTries < 3) {
      pickerTries += 1;
      console.log(`  connect picker is up: choosing the headless test wallet (${pickerTries})`);
      await clickButton(page, 'Headless Test Wallet');
      await sleep(5000);
      continue;
    }
    await sleep(1000);
  }
  await sleep(6000);
  await unlockIfPrompted(page);
}

/**
 * Clear the keystore-unlock gate if it is on screen, via a real wallet signature
 * (a headless browser has no passkey).
 *
 * This cannot be done once at sign-in: the gate is raised by the first ACTION,
 * so a flow's CTA click gets answered by "Unlock with passkey" instead of by the
 * transaction. Returns whether a gate was present.
 */
export async function unlockIfPrompted(page: Page, maxWaitMs = 120_000): Promise<boolean> {
  const gate = /Unlock with passkey|Unlock your account/;
  if (!gate.test(await bodyText(page))) return false;
  console.log('  unlock gate: taking the wallet-signature path');
  const walletPath = page.getByText('Use wallet signature instead', { exact: false }).first();
  if (await walletPath.isVisible().catch(() => false)) {
    await walletPath.click().catch(() => {});
    await sleep(1500);
  }
  // "Sign in" also exists in the header, so target the overlay's own copy.
  const clicked = await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return s.position === 'fixed' && /Unlock (with passkey|your account)/.test(d.textContent || '');
    });
    const host = overlays.pop() ?? document.body;
    for (const want of ['Sign in', 'Sign message', 'Continue']) {
      const cta = Array.from(host.querySelectorAll('*')).find(
        (el) => el.textContent?.trim() === want && el.children.length === 0,
      ) as HTMLElement | undefined;
      if (cta) { ((cta.closest('button,[role="button"]') as HTMLElement) ?? cta).click(); return want; }
    }
    return null;
  });
  console.log('  unlock gate: clicked', clicked ?? '(nothing found)');
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    await sleep(Math.min(2000, Math.max(0, until - Date.now())));
    if (!gate.test(await bodyText(page))) { console.log('  unlock gate: cleared'); return true; }
  }
  console.log(`  unlock gate: STILL on screen after ${Math.round(maxWaitMs / 1000)}s`);
  return true;
}

/**
 * Answer the one-time keystore-registration gate.
 *
 * A brand-new account has no keys on-chain, so its FIRST action stops on an
 * explicit modal ("Register before you deposit") describing the one-time
 * on-chain transaction and its gas cost. Nothing broadcasts until it is
 * answered, which is exactly how the fresh-key CI step failed: the driver never
 * pressed the button, so the run only reported "no transaction was broadcast".
 *
 * The modal's own success path resumes the parked deposit, so accepting here is
 * all that is needed. Returns true when a gate was answered.
 */
export async function registerKeystoreIfPrompted(page: Page, timeoutMs = 180_000): Promise<boolean> {
  const gate = /Register before you|register your wallet|one-time onchain transaction/i;
  const deadline = Date.now() + timeoutMs;
  let seen = false;
  const appearanceDeadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!gate.test(await bodyText(page))) {
      if (seen) { console.log('  keystore registration: gate cleared'); return true; }
      if (Date.now() >= appearanceDeadline) return false;
      await sleep(500);
      continue;
    }
    if (!seen) { seen = true; console.log('  keystore registration: gate is up, accepting'); }
    // "Registering…" replaces the label while the wallet transaction is in
    // flight, so a press during that window would be a no-op on a disabled
    // control. Only reach for the actionable label.
    //
    // "Register for free" is the same button on a wallet that cannot pay gas:
    // the modal's gasless probe (hooks/use-gasless-registration.ts) relabels it
    // when the relayer will register the wallet instead. It only appears on a
    // cold-start-capable chain, so it never fires on the Sepolia CI path — but
    // a staging run would otherwise sit on an unpressed gate.
    const pressed = await page.evaluate(() => {
      const labels = ['Register and continue', 'Register and pay', 'Register for free', 'Register'];
      for (const want of labels) {
        const leaf = Array.from(document.querySelectorAll('*')).find(
          (el) => el.textContent?.trim() === want && el.children.length === 0,
        ) as HTMLElement | undefined;
        if (leaf) { ((leaf.closest('button,[role="button"]') as HTMLElement) ?? leaf.parentElement ?? leaf).click(); return want; }
      }
      return null;
    });
    if (pressed) console.log(`  keystore registration: pressed "${pressed}"`);
    await sleep(3000);
  }
  console.log('  keystore registration: STILL on screen when the wait ran out');
  return true;
}

/** Select the mounted pager page by its accessibility state, not hidden text. */
export async function tab(page: Page, label: Owner | 'Request', timeoutMs = 90_000): Promise<boolean> {
  const key = label.toLowerCase();
  const target = page.getByTestId(`hub-tab-${key}`).filter({ visible: true });
  // A settled deposit retains its success panel until explicitly dismissed.
  const again = page.getByRole('button', { name: 'New deposit', exact: true });
  if (await again.isVisible()) await again.click();
  // The unlock gate can rise seconds AFTER signIn's one check, and its overlay
  // then covers the tab for the whole click timeout (run 37792693715: payer B,
  // "click: Timeout 90000ms exceeded" on hub-tab-send under "Unlock your
  // account"). Click in short tries; retry only when a gate was on screen and
  // has been cleared. Any other failure is the real error and is thrown at
  // once, and the unlock wait is bounded by what is left of the deadline.
  const deadline = Date.now() + timeoutMs;
  const gateUp = async () => /Unlock with passkey|Unlock your account/.test(await bodyText(page));
  for (;;) {
    const left = deadline - Date.now();
    try {
      await target.click({ timeout: Math.max(1000, Math.min(15_000, left)) });
      break;
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      // No gate: not something a retry can fix. One last attempt with the
      // rest of the original timeout keeps the old patience for a slow mount,
      // and its own error is what surfaces.
      if (!(await gateUp())) { await target.click({ timeout: remaining }); break; }
      await unlockIfPrompted(page, remaining);
      if (await gateUp()) throw error;
    }
  }
  await page.locator(`[data-testid="hub-page-${key}"]:not([aria-hidden="true"]):visible`).waitFor({ timeout: timeoutMs });
  return true;
}

/** Only the active form's editable input; never fall back to a hidden neighbour. */
async function activeInput(page: Page, kind: 'amount' | 'recipient', owner?: Owner) {
  const dialog = page.getByRole('dialog').filter({ visible: true }).last();
  const root = await dialog.count() ? dialog : page.locator(
    owner ? `[data-testid="hub-page-${owner.toLowerCase()}"]:not([aria-hidden="true"]):visible`
      : '[data-testid^="hub-page-"]:not([aria-hidden="true"]):visible',
  );
  const field = kind === 'amount'
    ? root.locator('input[placeholder="0"], input[placeholder="0.0"]')
    : root.locator('input[placeholder*="recipient address" i]');
  return field.filter({ visible: true });
}

/** Select the intended Sepolia asset instead of trusting wallet-balance sorting. */
export async function selectToken(page: Page, owner: Owner | 'Request', symbol = 'ETH') {
  const root = page.locator(`[data-testid="hub-page-${owner.toLowerCase()}"]:not([aria-hidden="true"]):visible`);
  const id = owner === 'Shield' ? 'hub-shield-pay-token' : owner === 'Request' ? 'hub-request-token' : 'hub-withdraw-pool';
  const pill = root.getByTestId(id);
  // Pending-only pools may be absent from the spend picker. A correctly
  // selected pool remains valid while its deposit awaits approval.
  const current = await pill.getAttribute('aria-label');
  if (!new RegExp(`\\b${symbol} on Sepolia$`).test(current ?? '')) {
    await pill.click();
    const sheet = page.getByTestId('token-select-sheet');
    await sheet.waitFor();
    await sheet.getByRole('button', { name: `${symbol} on Sepolia`, exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
  }
  const label = await pill.getAttribute('aria-label');
  if (!new RegExp(`\\b${symbol}\\b`).test(label ?? '')) throw new Error(`Wrong selected asset: ${label}`);
  if (owner === 'Shield') {
    const destination = await root.getByTestId('hub-shield-pool').getAttribute('aria-label');
    if (!new RegExp(`\\b${symbol}(?: pool)? on Sepolia$`).test(destination ?? '')) throw new Error(`Wrong deposit pool: ${destination}`);
  }
}

/** The selected request asset is separate from the shared amount input. */
export async function requestPillSymbol(page: Page): Promise<string> {
  return (await page.locator('[data-testid="hub-page-request"]:not([aria-hidden="true"]):visible').getByTestId('hub-request-token').getAttribute('aria-label'))?.replace(/^Request in /, '') ?? '';
}

export async function enterAmount(page: Page, amount: string, owner?: Owner): Promise<boolean> {
  const input = await activeInput(page, 'amount', owner);
  await input.fill(amount);
  return await input.inputValue() === amount;
}

/**
 * Fill the visible input whose placeholder matches, with real keystrokes.
 *
 * Not every card names its amount field "0": the payment-request card uses
 * "0.01 ETH", so the generic amount helper silently found nothing and the CTA
 * just said "Enter an amount first".
 */
export async function fillByPlaceholder(page: Page, placeholder: RegExp, value: string): Promise<boolean> {
  const idx = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const vw = window.innerWidth;
    const inputs = Array.from(document.querySelectorAll('input'));
    for (let i = 0; i < inputs.length; i += 1) {
      const el = inputs[i] as HTMLInputElement;
      if (!re.test(el.placeholder || '') || el.readOnly || el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.left >= 0 && r.right <= vw) return i;
    }
    return -1;
  }, placeholder.source);
  if (idx < 0) { console.log(`  no visible input matching /${placeholder.source}/`); return false; }
  const input = page.locator('input').nth(idx);
  await input.click();
  await page.keyboard.type(value, { delay: 50 });
  await sleep(1200);
  if ((await input.inputValue()) === value) return true;
  await input.fill(value);
  await sleep(1000);
  return (await input.inputValue()) === value;
}

/** Fill the recipient field of `owner`'s card (withdraw and send both have one). */
export async function fillRecipient(page: Page, address: string, owner?: Owner): Promise<boolean> {
  const input = await activeInput(page, 'recipient', owner);
  await input.fill(address);
  return (await input.inputValue()).toLowerCase() === address.toLowerCase();
}

/**
 * Clear the FullWithdrawalGuard if it is up.
 *
 * Withdrawing the whole per-transaction cap is a full-balance selection, which
 * trips a privacy warning that BLOCKS the CTA until acknowledged
 * (`withdrawCtaDisabled = ... || guardBlocksCta(guardState)`). Every test deposit
 * here is its own lineage, so test withdrawals are nearly always full selections,
 * and an unacknowledged guard is why a filled form with an apparently pressable
 * button produced no quote and no proof.
 */
export async function acknowledgeFullWithdrawal(page: Page): Promise<boolean> {
  const present = await page.evaluate(() => !!document.querySelector('[data-testid="full-withdrawal-guard"]'));
  if (!present) return false;
  console.log('  full-withdrawal guard is up: acknowledging it');
  const ok = await page.evaluate(() => {
    const ack = document.querySelector('[data-testid="full-withdrawal-ack"]') as HTMLElement | null;
    if (!ack) return false;
    const r = ack.getBoundingClientRect();
    return { x: r.x + Math.min(12, r.width / 2), y: r.y + r.height / 2 };
  });
  if (!ok || typeof ok === 'boolean') { console.log('  guard ack control not found'); return false; }
  await page.mouse.move(ok.x, ok.y);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(1500);
  return true;
}

/** Any validation error the card is showing, for a useful failure message. */
export async function cardError(page: Page): Promise<string | null> {
  const t = await bodyText(page);
  // "You can shield up to X" is the one a fresh account hits: the app reserves
  // room for the vetting fee and the registration/deposit gas, so a deposit that
  // ignores the cap simply never broadcasts. Reporting "no transaction was
  // broadcast" for that hid the actual reason.
  const m = t.match(/^.*(exceeds available balance|You can shield up to[^\n]*|insufficient|not enough|too small|unavailable).*$/im);
  return m ? m[0].trim() : null;
}

/** Exact labels and real pointer actionability: hidden pages are never clickable. */
/**
 * Replace the File System Access save dialog, which a headless browser cannot
 * click (it rejects with AbortError, i.e. "cancelled"), with one that saves
 * into page memory. The app's real proof path still runs: the target is opened
 * at the press and written later. Call before navigating.
 */
export async function installSavePickerStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __savedBackups: { name?: string; text: string }[]; __pickerCalls: number; showSaveFilePicker: unknown };
    w.__savedBackups = [];
    w.__pickerCalls = 0;
    w.showSaveFilePicker = async (options?: { suggestedName?: string }) => {
      w.__pickerCalls += 1;
      return {
        async createWritable() {
          let text = '';
          return {
            async write(data: unknown) { text += String(data); },
            async close() { w.__savedBackups.push({ name: options?.suggestedName, text }); },
          };
        },
      };
    };
  });
}

/** What the stubbed save dialog has "written" so far. */
export async function savedBackups(page: Page): Promise<{ calls: number; files: { name?: string; text: string }[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __savedBackups?: { name?: string; text: string }[]; __pickerCalls?: number };
    return { calls: w.__pickerCalls ?? 0, files: w.__savedBackups ?? [] };
  });
}

export async function clickButton(page: Page, label: string): Promise<boolean> {
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const button = page.getByRole('button', { name }).filter({ visible: true });
  if (await button.count()) {
    if (!await button.last().isEnabled()) return false;
    await button.last().click();
    return true;
  }
  // Some existing RN Pressables lack a role. Resolve their exact text to the
  // clickable ancestor, but still let Playwright check visibility and overlays.
  const handle = await page.evaluateHandle((want) => {
    for (const leaf of document.querySelectorAll('*')) {
      if (leaf.children.length || leaf.textContent?.trim().toLowerCase() !== want.toLowerCase() || leaf.closest('[aria-hidden="true"]')) continue;
      let box = leaf.parentElement;
      while (box && getComputedStyle(box).cursor !== 'pointer') box = box.parentElement;
      if (!box || box.closest('[aria-disabled="true"]')) continue;
      const r = box.getBoundingClientRect();
      if (!r.width || !r.height || !box.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) continue;
      return box;
    }
    return null;
  }, label);
  try {
    const element = handle.asElement();
    if (!element) return false;
    await element.click();
    return true;
  } finally { await handle.dispose(); }
}

/**
 * Press the flow's CTA, clear an unlock gate if one answers instead, and press
 * again so the action the gate swallowed actually runs. Returns the label used.
 */
/**
 * submit(), with the one distinction its `null` return hides.
 *
 * `null` means "pressed nothing", and that covers two opposite situations: the
 * CTA is genuinely stuck, or the flow is ALREADY past the form and submit()
 * returned early because its advance check saw the review panel. Callers that
 * treat null as failure fail a run whose form had simply moved on — which is
 * exactly what happened to the withdrawal on 2026-08-21 once a retry loop made
 * the second case common.
 *
 *   'pressed' — a CTA was clicked
 *   'past'    — nothing to click, but a Confirm step is on screen: carry on
 *   'stuck'   — nothing to click and nowhere to go: the caller should fail
 */
export async function submitOrPast(page: Page, labels: string[]): Promise<'pressed' | 'past' | 'stuck'> {
  if (await submit(page, labels)) return 'pressed';
  return /\bConfirm\b/i.test(await bodyText(page)) ? 'past' : 'stuck';
}

export async function submit(page: Page, labels: string[]): Promise<string | null> {
  // Anything that shows the flow has actually started working.
  const PROGRESS = /Confirming|Generating|Preparing|Submitting|Building|proof|Sending|in progress/i;
  const press = async () => {
    for (const l of labels) if (await clickButton(page, l)) return l;
    return null;
  };

  let used: string | null = null;
  // Retry, because a press can be swallowed: RN-Web marks a CTA disabled by
  // style, so a button that is inert while a transaction settles still accepts
  // the click and reports success. Pressing once and trusting it is how several
  // runs sat in a wait with a perfectly filled form and no quote in the logs.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const label = await press();
    if (label) {
      used = label;
      console.log(`  clicked: ${label}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    } else {
      console.log(`  no CTA matched (attempt ${attempt})`);
    }
    await sleep(2500);

    // The gate answers instead of the action when the keystore is locked.
    if (await unlockIfPrompted(page)) return used; // The app resumes its parked action.

    // Advanced? Either the flow is working, or it has already finished.
    const t = await bodyText(page);
    if (PROGRESS.test(t) || /Successful|outcome unknown/i.test(t)) return used;
    // Reaching a REVIEW step is advancing too, and this used to be missed:
    // review shows no progress wording, so submit() kept pressing and waiting
    // for ~100s. That is not merely slow — the relayer's fee quote lives about
    // 60s, so the retry loop outlived the quote and Confirm landed on a dead
    // one ("Fee quote expired before confirm", CI 2026-08-21). The withdrawal
    // then correctly refused, and the run reported it as "recipient balance
    // never increased", which pointed at the chain instead of at this loop.
    if (/\bConfirm\b/i.test(t)) return used;

    if (attempt < 4) {
      console.log('  flow did not advance, waiting for the card to settle before pressing again');
      await sleep(15_000);
    }
  }
  console.log('  flow never advanced after 4 presses');
  return used;
}

/** Wait until the page text matches, returning the matching text or null. */
export async function waitForText(page: Page, re: RegExp, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await bodyText(page);
    if (re.test(t)) return t;
    await sleep(2000);
  }
  return null;
}

/** Unlock through balances without creating an extra deposit. */
export async function forceUnlock(page: Page): Promise<boolean> {
  const url = new URL(page.url());
  if (url.pathname !== '/') await page.goto(`${BASE}/?panel=balances`, { waitUntil: 'domcontentloaded' });
  else if (url.searchParams.get('panel') !== 'balances') await page.getByTestId('home-door-mine').click();
  await page.getByTestId('my-privacy-pools-card').waitFor();
  if (await unlockIfPrompted(page)) return true;
  const sync = page.getByRole('button', { name: 'Sync balances', exact: true }).filter({ visible: true }).first();
  if (await sync.isVisible()) {
    await sync.click();
    await sleep(1000);
  }
  return unlockIfPrompted(page);
}

/**
 * Wait until the card reports a spendable shielded balance.
 *
 * A just-made deposit is only spendable once the ASP snapshot carries it, and
 * the card shows the rest as "+n pending" until then.
 */
export async function waitForShieldedBalance(page: Page, minutes = 10): Promise<number> {
  const read = async () => {
    const text = await page.locator('[data-testid^="hub-page-"]:not([aria-hidden="true"]):visible').innerText();
    const m = text.match(/Shielded(?: balance)?\s+([0-9.]+)/i);
    return m ? Number(m[1]) : 0;
  };
  let last = await read();
  if (last > 0) { console.log(`  shielded balance: ${last}`); return last; }
  console.log('  shielded balance is 0 - waiting for note sync / ASP snapshot');
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    // Nudge the header sync button, which resyncs every chain.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('[role="button"],button'))
        .find((b) => /sync|refresh/i.test(b.getAttribute('aria-label') || ''));
      (btn as HTMLElement | undefined)?.click();
    });
    await sleep(15_000);
    last = await read();
    if (last > 0) { console.log(`  shielded balance: ${last}`); return last; }
  }
  console.log(`  shielded balance still 0 after ${minutes}m`);
  return 0;
}

/**
 * Wait for the DEPOSIT's own transaction hash, taken from the app's log.
 *
 * Counting broadcasts cannot identify it: a first-time account registers its
 * keystore first, so a press produces two or three transactions, and which one
 * is the deposit depends on timing. A run that shielded successfully was
 * reported as "no transaction was broadcast" because both had already landed
 * before the count was sampled.
 */
export async function waitForDepositHash(
  appLogs: string[],
  timeoutMs = 300_000,
  /**
   * Scan only from here on. Without it a SECOND deposit in the same session
   * matched the FIRST one's log line instantly and reported the earlier hash,
   * so the run judged a deposit that had not happened yet. Pass appLogs.length
   * captured before pressing the CTA.
   */
  fromIndex = 0,
): Promise<`0x${string}` | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = appLogs.slice(fromIndex).join('\n').match(/Deposit tx submitted.*?txHash: (0x[0-9a-fA-F]{64})/);
    if (hit) return hit[1] as `0x${string}`;
    await sleep(3000);
  }
  return null;
}

export async function awaitReceipt(
  hashes: `0x${string}`[],
  only?: `0x${string}` | null,
): Promise<'success' | 'reverted' | null> {
  const hash = only ?? hashes[hashes.length - 1];
  if (!hash) return null;
  console.log(`  waiting for receipt ${hash}`);
  const r = await publicClient().waitForTransactionReceipt({ hash, timeout: 300_000 });
  console.log(`  receipt: ${r.status} in block ${r.blockNumber} (gas ${r.gasUsed})`);
  return r.status;
}

export function reportBalance(label: string, wei: bigint): void {
  console.log(`  ${label}: ${formatEther(wei)} ETH`);
}

/** Receipt success alone also accepts approvals and deposits of the wrong asset. */
export async function awaitNativeDeposit(hash: `0x${string}`, amount: string, owner: string) {
  const client = publicClient();
  const [receipt, tx] = await Promise.all([
    client.waitForTransactionReceipt({ hash, timeout: 300_000 }),
    client.getTransaction({ hash }),
  ]);
  const call = decodeFunctionData({ abi: ENTRYPOINT_DEPOSIT_ABI, data: tx.input });
  if (call.functionName !== 'deposit' || tx.value !== parseEther(amount) || tx.from.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('Broadcast does not match the expected native ETH deposit');
  }
  if (receipt.status !== 'success') throw new Error(`Native ETH deposit reverted: ${hash}`);
  return receipt.status;
}


/** Fresh browser contexts must finish discovery before counting fixture notes. */
export async function waitForInitialDiscovery(page: Page, address: string) {
  await page.waitForFunction(owner => {
    const data = JSON.parse(sessionStorage.getItem(`ppv2_account_export_v2_${owner}_11155111`) ?? '{}');
    return BigInt(data.syncCursor ?? 0) > 0n;
  }, address.toLowerCase(), { timeout: 180_000 });
}

/** Notes from this account's persisted Sepolia SDK export. */
export async function accountNotes(page: Page, address: string) {
  return page.evaluate((owner) => {
    const data = JSON.parse(sessionStorage.getItem(`ppv2_account_export_v2_${owner}_11155111`) ?? '{}');
    return Array.isArray(data.notes) ? data.notes : [];
  }, address.toLowerCase());
}

/** Reloaded activity needs an explicit signing session before reconstruction. */
export async function openTransactionDetail(page: Page, hash: string) {
  await page.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded' });
  await sleep(9000);
  await unlockIfPrompted(page);
  const sync = page.getByRole('button', { name: 'Sync full activity', exact: true });
  if (await sync.isVisible()) {
    await sync.click();
    await unlockIfPrompted(page);
  }
  await page.evaluate((hash) => {
    const url = new URL(location.href);
    url.searchParams.set('tx', hash);
    history.pushState(history.state, '', url);
  }, hash);
}

/** A positive old balance does not make a new fixture deposit spendable. */
export async function waitForApprovedDeposit(page: Page, address: string, hash: string) {
  await waitForApproval(`Fixture deposit ${hash}`, async () =>
    (await accountNotes(page, address)).some(n => n.txHash?.toLowerCase() === hash.toLowerCase() && n.status === 'ACTIVE'));
}

/** Reuse discovered payment funding; seed capped notes together before approval. */
export async function ensurePaymentFunding(page: Page, logs: string[], address: string, amount: string, count = 1,
  approve: (wait: () => Promise<unknown>) => Promise<unknown> = wait => wait()) {
  // Fee room inside the note: see PAYMENT_FEE_RESERVE_ETH for the measured fee.
  // A shielded fixture note is the cap minus the vetting fee, and the filter
  // below compares against real note values, so a note short of this is
  // never picked as funding.
  const needed = parseEther(amount) + parseEther(PAYMENT_FEE_RESERVE_ETH);
  if (needed > parseEther(FIXTURE_NOTE_ETH)) {
    throw new Error(`Payment ${amount} ETH plus the ${PAYMENT_FEE_RESERVE_ETH} ETH fee reserve exceeds the ${FIXTURE_NOTE_ETH} ETH fixture cap`);
  }
  if (!(await tab(page, 'Send'))) throw new Error('Send tab did not open');
  await selectToken(page, 'Send');
  await forceUnlock(page);
  await waitForInitialDiscovery(page, address);
  const notes = (await accountNotes(page, address)).filter(n => BigInt(n.value) >= needed);
  const active = notes.filter(n => n.status === 'ACTIVE').length;
  const pending = notes.filter(n => n.status === 'PENDING' && n.txHash).slice(0, Math.max(0, count - active));
  const hashes = pending.map(n => n.txHash);
  for (let i = active + pending.length; i < count; i++) {
    const from = logs.length;
    if (!(await tab(page, 'Shield'))) throw new Error('Shield tab did not open');
    await selectToken(page, 'Shield');
    if (!(await enterAmount(page, FIXTURE_NOTE_ETH, 'Shield'))) throw new Error('Fixture amount did not stick');
    await submit(page, ['Shield ETH']);
    await registerKeystoreIfPrompted(page);
    const hash = await waitForDepositHash(logs, 300_000, from);
    if (!hash) throw new Error('Payer fixture deposit did not broadcast');
    await awaitNativeDeposit(hash, FIXTURE_NOTE_ETH, address);
    // A receipt can precede the frontend's persistence and submission-lock release.
    await page.getByText('New deposit', { exact: true }).waitFor({ timeout: 180_000 });
    hashes.push(hash);
  }
  await approve(() => Promise.all(hashes.map(hash => waitForApprovedDeposit(page, address, hash))));
  // The guard above checks the gross deposit; the note holds what is left
  // after the vetting fee. Check the notes themselves, so a payment that fits
  // the deposit but not the note fails here with the numbers, not mid-payment.
  const seeded = (await accountNotes(page, address)).filter(n => hashes.some(h => n.txHash?.toLowerCase() === h.toLowerCase()));
  const short = seeded.filter(n => BigInt(n.value) < needed);
  if (short.length) {
    throw new Error(`Seeded note holds ${formatEther(BigInt(short[0].value))} ETH after the vetting fee, less than the ${formatEther(needed)} ETH payment plus fee reserve`);
  }
}

/** Follow the payment's terminal UI; never retry an unknown broadcast outcome. */
export async function payPrivateRequest(page: Page, logs: string[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const from = logs.length;
    if (!(await clickButton(page, 'Pay via Private Transfer'))) throw new Error('Private payment is not actionable');
    const deadline = Date.now() + 420_000;
    let stale = false;
    while (Date.now() < deadline) {
      await unlockIfPrompted(page);
      const text = await bodyText(page);
      const current = logs.slice(from).join('\n');
      if (/Transfer Successful|Payment sent|sent via relay/i.test(text)) return;
      if (/outcome unknown|transaction reverted|Payment cannot be funded|Insufficient value for transact/i.test(text + current)) {
        throw new Error('Private payment failed; inspect the payment log and screenshot');
      }
      if (/ASP leaves root mismatch|ASP unavailable/i.test(text + current)) { stale = true; break; }
      await sleep(2000);
    }
    if (!stale) throw new Error('Private payment did not reach a terminal state within 7 minutes');
    if (attempt < 2) await sleep(45_000);
  }
  throw new Error('ASP snapshot remained stale across three payment attempts');
}
