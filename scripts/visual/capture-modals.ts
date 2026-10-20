// Connected modal-state captures (deposit / withdraw / send / request / swap
// + the connect picker). Uses the headless EIP-6963 wallet (evm-wallet.ts);
// only states reachable WITHOUT submitting an on-chain transaction are
// captured (the wallet hard-rejects eth_sendTransaction). States that need
// funds/relayer responses the account can't produce are logged as
// not-capturable — see README.md for the honest inventory.
//
//   safewrap bun scripts/visual/capture-modals.ts --mode record
//   safewrap bun scripts/visual/capture-modals.ts --mode replay [--only v0-light]
//   safewrap bun scripts/visual/capture-modals.ts --out /tmp/candidate-modals  # candidate run for compare.ts
//
// Output defaults to baselines/ (the ground-truth location). Pass --out for
// candidate runs — re-running WITHOUT --out overwrites the baselines, which
// would make a later compare.ts diff meaningless.
//
// Runs desktop-viewport only, on 4 sets: v0/v1 × light/dark (classic + vault
// modal chrome across both schemes; variants 2-4 share the vault structure).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { BASELINE_DIR, BASE_URL, FIXTURE_DIR, type ColorName, type Variant } from './config';
import { openFixtureStore, type FixtureMode } from './fixtures';
import { assertOrUpdateBaselineManifest } from './baseline-manifest';
import { launchBrowser, newDeterministicContext, stableScreenshot, waitForAppReady } from './harness';
import { installEvmWallet, loadDevAccount } from './evm-wallet';

const MODAL_SETS: { variant: Variant; color: ColorName }[] = [
  { variant: 1, color: 'light' },
  { variant: 1, color: 'dark' },
];

interface ShotLog {
  name: string;
  status: 'captured' | 'not-capturable';
  detail?: string;
}

const bodyText = (page: Page) => page.evaluate(() => document.body?.innerText || '');

async function clickText(page: Page, text: string, exact = true): Promise<boolean> {
  try {
    await page.getByText(text, { exact }).first().click({ timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

/** RN-Web modals portal to the END of <body>: when the same label exists on
 * the page underneath (e.g. "Sign in"), the LAST match is the modal's. */
async function clickTextLast(page: Page, text: string, exact = true): Promise<boolean> {
  try {
    await page.getByText(text, { exact }).last().click({ timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

async function settleAndShoot(page: Page, outDir: string, name: string, logs: ShotLog[]): Promise<void> {
  const buf = await stableScreenshot(page, { maxTries: 30 });
  fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
  logs.push({ name, status: 'captured' });
  console.log(`  ok ${name}`);
}

function notCapturable(logs: ShotLog[], name: string, detail: string): void {
  logs.push({ name, status: 'not-capturable', detail });
  console.log(`  SKIP ${name}: ${detail}`);
}

async function main(): Promise<void> {
  // Playwright's internal event handlers can throw on odd server responses
  // (e.g. unparsable Set-Cookie domains); never let that kill a capture run.
  process.on('uncaughtException', (e) => console.log(`  [uncaught] ${e.message.slice(0, 160)}`));
  process.on('unhandledRejection', (e) => console.log(`  [unhandled] ${String(e).slice(0, 160)}`));

  const args = process.argv.slice(2);
  let mode: FixtureMode = 'replay';
  let outDir = BASELINE_DIR;
  const only: string[] = [];
  let commit = '';
  let refreshBaselines = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') mode = args[++i] as FixtureMode;
    else if (args[i] === '--out') outDir = path.resolve(args[++i]);
    else if (args[i] === '--only') only.push(args[++i]);
    else if (args[i] === '--commit') commit = args[++i];
    else if (args[i] === '--refresh-baselines') refreshBaselines = true;
  }
  if (outDir === BASELINE_DIR) {
    assertOrUpdateBaselineManifest({ allowRefresh: refreshBaselines, ...(commit ? { commit } : {}) });
  }

  const account = loadDevAccount();
  console.log(`headless EVM wallet: ${account.address} (mode=${mode})`);
  const store = openFixtureStore(FIXTURE_DIR, mode);
  const browser = await launchBrowser();
  fs.mkdirSync(outDir, { recursive: true });
  const logs: ShotLog[] = [];

  for (const { variant, color } of MODAL_SETS) {
    const prefix = `v${variant}-${color}`;
    if (only.length > 0 && !only.every((f) => prefix.includes(f))) continue;
    console.log(`\n=== ${prefix} (modal states) ===`);
    const homeUrl = `${BASE_URL}/?theme=${variant}&color=${color}`;
    const homeMarker = 'Privacy Pools';

    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      color,
      fixtures: { store, mode },
    });

    // --- connect picker (disconnected state — page WITHOUT the wallet) ---
    {
      const bare = await context.newPage();
      await bare.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await waitForAppReady(bare, homeMarker, 90_000);
      if (await clickText(bare, 'Connect Wallet')) {
        await bare.waitForTimeout(1000);
        await settleAndShoot(bare, outDir, `${prefix}-modal-connect-picker-desktop`, logs);
      } else {
        notCapturable(logs, `${prefix}-modal-connect-picker-desktop`, 'Connect Wallet button not found');
      }
      await bare.close();
    }

    // --- connected page: the injected EIP-6963 wallet auto-connects ---
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 160)}`));
    await installEvmWallet(page, account);
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForAppReady(page, homeMarker, 90_000);
    let connected = false;
    for (let i = 0; i < 30; i++) {
      const t = await bodyText(page);
      if (/0x[0-9a-fA-F]{2,4}(…|\.\.\.)/.test(t) && !t.includes('Connect Wallet')) {
        connected = true;
        break;
      }
      // Fallback: explicit connect via the picker tile.
      if (i === 10 && t.includes('Connect Wallet')) {
        await clickText(page, 'Connect Wallet');
        await page.waitForTimeout(1000);
        await clickText(page, 'Headless Test Wallet', false);
      }
      await page.waitForTimeout(1000);
    }
    if (!connected) {
      notCapturable(logs, `${prefix}-modal-*`, 'headless wallet connect did not complete');
      await context.close();
      continue;
    }
    console.log('  connected');
    await page.waitForTimeout(3000); // key derivation / initial account sync

    // --- keystore unlock gate. The in-memory unlock does NOT survive a
    //     reload, and every deep link below is a fresh goto — so this runs
    //     after every navigation. This build defaults to passkey unlock
    //     (impossible headless); the harness takes the supported
    //     wallet-signature path, auto-signed by the headless wallet.
    let unlockCaptured = false;
    const ensureUnlocked = async (): Promise<void> => {
      if (!/Unlock (with passkey|your account)/.test(await bodyText(page))) return;
      if (!unlockCaptured) {
        await settleAndShoot(page, outDir, `${prefix}-modal-unlock-desktop`, logs);
        unlockCaptured = true;
      }
      if ((await bodyText(page)).includes('Unlock with passkey')) {
        await clickTextLast(page, 'Use wallet signature instead', false);
        await page.waitForTimeout(1000);
      }
      // Last match: the transactions table renders its own occluded "Sign in".
      await clickTextLast(page, 'Sign in');
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const t = await bodyText(page);
        if (!t.includes('Unlock with passkey') && !t.includes('Unlock your account')) break;
      }
      await page.waitForTimeout(2000); // decryption + discovery kick-off
    };

    // --- money modals via their deep links ---
    const modals: { name: string; marker: string; reviewLabel?: string }[] = [
      { name: 'deposit', marker: 'eposit', reviewLabel: 'Review Deposit' },
      { name: 'withdraw', marker: 'ithdraw', reviewLabel: 'Review Withdrawal' },
      { name: 'send', marker: 'end', reviewLabel: 'Next: Enter Recipient' },
      { name: 'request', marker: 'equest' },
    ];
    for (const modal of modals) {
      const url = `${BASE_URL}/?theme=${variant}&color=${color}&modal=${modal.name}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await waitForAppReady(page, homeMarker, 90_000);
      await page.waitForTimeout(4000); // reconnect + deep-link modal open
      await ensureUnlocked();
      await page.waitForTimeout(1500); // gated modal opens after unlock
      const text = await bodyText(page);
      if (!text.includes(modal.marker)) {
        notCapturable(logs, `${prefix}-modal-${modal.name}-input-desktop`, `deep link did not open (marker "${modal.marker}" missing)`);
        continue;
      }
      await settleAndShoot(page, outDir, `${prefix}-modal-${modal.name}-input-desktop`, logs);

      // Filled state: type into the amount input when present.
      const amount = page.getByPlaceholder('0').last();
      let filled = false;
      try {
        await amount.click({ timeout: 4000 });
        await amount.fill('0.01');
        await page.waitForTimeout(1200);
        filled = true;
        await settleAndShoot(page, outDir, `${prefix}-modal-${modal.name}-filled-desktop`, logs);
      } catch {
        notCapturable(logs, `${prefix}-modal-${modal.name}-filled-desktop`, 'no amount input (placeholder "0") in this modal');
      }

      // Review state: click the review CTA when present; capture whatever
      // state results (review screen OR validation-blocked state) — never
      // confirm (the wallet would reject the tx anyway).
      if (filled && modal.reviewLabel) {
        if (await clickText(page, modal.reviewLabel, false)) {
          await page.waitForTimeout(2500);
          await settleAndShoot(page, outDir, `${prefix}-modal-${modal.name}-review-desktop`, logs);
        } else {
          notCapturable(logs, `${prefix}-modal-${modal.name}-review-desktop`, `review CTA "${modal.reviewLabel}" not clickable (validation-blocked)`);
        }
      }
      // Close via Escape to leave a clean URL for the next deep link.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(800);
    }

    // --- swap (no deep link; UI entry differs per design) ---
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForAppReady(page, homeMarker, 90_000);
    await page.waitForTimeout(3000);
    await ensureUnlocked();
    if (await clickText(page, 'Swap')) {
      await page.waitForTimeout(2000);
      await ensureUnlocked(); // the spend gate can pop on the swap entry itself
      await page.waitForTimeout(1500);
      const t = await bodyText(page);
      if (/[Ss]wap/.test(t)) {
        await settleAndShoot(page, outDir, `${prefix}-modal-swap-input-desktop`, logs);
        const amount = page.getByPlaceholder('0').last();
        try {
          await amount.click({ timeout: 4000 });
          await amount.fill('0.01');
          await page.waitForTimeout(2000);
          await settleAndShoot(page, outDir, `${prefix}-modal-swap-filled-desktop`, logs);
        } catch {
          notCapturable(logs, `${prefix}-modal-swap-filled-desktop`, 'no amount input in swap surface');
        }
      } else {
        notCapturable(logs, `${prefix}-modal-swap-input-desktop`, 'Swap click produced no swap surface');
      }
    } else {
      notCapturable(logs, `${prefix}-modal-swap-input-desktop`, 'no Swap entry point on this design');
    }

    await context.close();
  }

  await browser.close();
  store.writeIndex();

  const capturedCount = logs.filter((l) => l.status === 'captured').length;
  const skipped = logs.filter((l) => l.status === 'not-capturable');
  console.log(`\ncaptured ${capturedCount}, not-capturable ${skipped.length}, fixture misses ${store.misses.length}`);
  fs.writeFileSync(
    path.join(outDir, 'modal-capture-log.json'),
    JSON.stringify({ mode, wallet: account.address, shots: logs }, null, 2) + '\n',
  );
  // Same rule as capture.ts: replay misses degrade the UI behind a
  // stable-looking screenshot — fail the run instead of writing poisoned
  // baselines/candidates with exit 0.
  if (store.misses.length > 0) {
    for (const m of store.misses) console.error(`  fixture MISS: ${m.method} ${m.url}`);
    console.error('replay fixtures incomplete — re-record (--mode record) before capturing');
    process.exit(1);
  }
}

main();
