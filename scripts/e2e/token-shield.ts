// @ts-nocheck
// Pack B-b: ERC-20 shields. Blocked until 2026-08-27 on the fixture holding no
// tokens; DEV_PK now holds USDC and USDT on Sepolia.
//
// Real value moves. Amounts are deliberately tiny and the assertion is on-chain
// (the wallet's token balance falls, the deposit receipt succeeds) rather than
// on UI text, because a token shield spends an approve AND a deposit and the
// UI can look right while neither landed.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/e2e/token-shield.ts
import { formatUnits } from 'viem';
import {
  accountFromKey, openApp, signIn, sleep, tab, enterAmount, submit, cardError,
  publicClient, registerKeystoreIfPrompted, waitForDepositHash, bodyText,
} from './lib';
import { envValue } from './funding';

const BASE = process.env.PROBE_URL || 'http://localhost:8081';
const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
const client = publicClient();

const TOKENS = [
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6, amount: '1' },
  { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', decimals: 6, amount: '1' },
] as const;
const ONLY = process.env.E2E_TOKEN_ONLY;

const erc20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
};
const tokenBalance = (address: string) =>
  client.readContract({ address, abi: erc20, functionName: 'balanceOf', args: [acct.address] });

/**
 * Pick a token in the shield card via the pay-token pill and the token sheet.
 *
 * Uses the sheet's own testIDs (token-select-sheet, token-select-row-<SYMBOL>).
 * A first version matched the row by visible text, missed, left the sheet OPEN,
 * and the next step's click was swallowed by the modal scrim - a 90s timeout
 * that looked like the shield flow hanging. So this now proves the sheet closed
 * AND the pill changed before returning.
 */
async function pressCenter(p, locator): Promise<boolean> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await sleep(60);
  await p.mouse.up();
  return true;
}

async function selectToken(p, symbol: string): Promise<boolean> {
  const pill = p.locator('[data-testid="hub-shield-pay-token"]').first();
  if (!(await pressCenter(p, pill))) {
    console.log('  pay-token pill not pressable');
    return false;
  }
  const sheet = p.locator('[data-testid="token-select-sheet"]');
  try {
    await sheet.waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    console.log('  token sheet never opened');
    return false;
  }
  // testID is `token-select-row-<SYMBOL>` and is NOT chain-unique: the sheet can
  // list the same symbol for several chains (pool assets per chain, plus the
  // wallet's own tokens). Picking .first() risked selecting a mainnet row, whose
  // asset the Sepolia pool does not have - which is a candidate explanation for
  // the AssetNotEnabled seen on USDC. Prefer a row that names Sepolia.
  const all = p.locator(`[data-testid="token-select-row-${symbol}"]`);
  const count = await all.count().catch(() => 0);
  console.log(`  sheet lists ${count} row(s) for ${symbol}`);
  let row = all.filter({ hasText: /Sepolia/i }).first();
  if (!(await row.isVisible().catch(() => false))) row = all.first();
  if (!(await row.isVisible().catch(() => false))) {
    console.log(`  no row for ${symbol} in the sheet`);
    await p.keyboard.press('Escape').catch(() => {});
    await sheet.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    return false;
  }
  await pressCenter(p, row);
  // The sheet must close, or the scrim eats every later click.
  try {
    await sheet.waitFor({ state: 'hidden', timeout: 20_000 });
  } catch {
    console.log('  token sheet stayed open after selecting');
    await p.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await sleep(800);
  // And the pill must now name the token we picked.
  const label = await p.locator('[data-testid="hub-shield-pay-token"]').first()
    .getAttribute('aria-label').catch(() => null);
  const picked = (label ?? '').includes(symbol);
  console.log(`  pill now reads: ${label ?? '(no label)'}`);
  return picked;
}

const app = await openApp(acct, { tag: 'token-shield' });
const { page: p, sent, appLogs } = app;
try {
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(6000);
  await signIn(p);

  for (const t of TOKENS) {
    if (ONLY && t.symbol !== ONLY) continue;
    const before = await tokenBalance(t.address);
    if (before === 0n) {
      record(`B-b shield ${t.symbol}`, false, `fixture holds 0 ${t.symbol}; fund ${acct.address}`);
      continue;
    }
    console.log(`\n=== ${t.symbol}: wallet holds ${formatUnits(before, t.decimals)}`);

    if (!(await tab(p, 'Shield'))) { record(`B-b shield ${t.symbol}`, false, 'Shield tab never active'); continue; }
    if (!(await selectToken(p, t.symbol))) { record(`B-b shield ${t.symbol}`, false, 'token picker did not select'); continue; }
    await app.shot(`${t.symbol}-selected`);
    if (!(await enterAmount(p, t.amount, 'Shield'))) { record(`B-b shield ${t.symbol}`, false, 'amount did not stick'); continue; }

    const logFrom = appLogs.length;
    const sentBefore = sent.length;
    const used = await submit(p, [`Shield ${t.symbol}`, 'Shield']);
    if (!used && sent.length === sentBefore) {
      record(`B-b shield ${t.symbol}`, false, `CTA not clickable: ${(await cardError(p)) ?? 'unknown'}`);
      continue;
    }
    if (await registerKeystoreIfPrompted(p)) {
      if (!(await waitForDepositHash(appLogs, 30_000, logFrom))) await submit(p, [`Shield ${t.symbol}`, 'Shield']);
    }
    const note = await cardError(p);
    if (note) console.log(`  card says: ${note}`);

    // The app log line waitForDepositHash watches ("Deposit tx submitted …
    // txHash:") is not emitted on the token path, so a USDT shield that really
    // did broadcast was reported as "no deposit within 300s". The wallet's own
    // eth_sendTransaction is the ground truth, and openApp already records it.
    let hash = await waitForDepositHash(appLogs, 60_000, logFrom);
    if (!hash) {
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline && sent.length === sentBefore) await sleep(2000);
      // A token shield can send an approve first; the deposit is the LAST one.
      if (sent.length > sentBefore) {
        hash = sent[sent.length - 1];
        console.log(`  no app-log hash; using the wallet broadcast ${String(hash).slice(0, 14)} (${sent.length - sentBefore} tx sent)`);
      }
    }
    await app.shot(`${t.symbol}-after`);
    if (!hash) {
      record(`B-b shield ${t.symbol}`, false, `no deposit within 300s${note ? ` — ${note}` : ''}`);
      continue;
    }
    const rc = await client.waitForTransactionReceipt({ hash, timeout: 240_000 }).catch(() => null);
    // An ERC-20 shield spends an approve AND a deposit, so the wallet balance
    // falling is the assertion that actually proves value moved.
    const after = await tokenBalance(t.address);
    const moved = after < before;
    record(
      `B-b shield ${t.symbol}`,
      rc?.status === 'success' && moved,
      `${t.amount} ${t.symbol}, receipt ${rc?.status ?? 'none'}, wallet ${formatUnits(before, t.decimals)} -> ${formatUnits(after, t.decimals)}, tx ${String(hash).slice(0, 12)}`,
    );
  }

  // The asset list must name the tokens once they are in the pool.
  await sleep(8000);
  const body = await bodyText(p);
  const listed = TOKENS.filter((t) => new RegExp(`\\b${t.symbol}\\b`).test(body)).map((t) => t.symbol);
  record('B-b the balances view names the shielded tokens', listed.length > 0, `listed: ${listed.join(', ') || 'none'}`);
} catch (e) {
  record('token-shield', false, `threw: ${(e as Error).message}`);
} finally {
  await app.browser.close().catch(() => {});
}
console.log('\n===== token-shield summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
if (results.length === 0 || results.some((r) => !r.ok)) process.exit(1);
