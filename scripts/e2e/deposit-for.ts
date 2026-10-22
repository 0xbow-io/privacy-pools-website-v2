// @ts-nocheck
// Sepolia e2e: "Deposit to another address" (SDK depositFor, path B).
//
// Case 1 (A -> B, both registered): A shields a small amount FOR B from the
//   hub's Shield tab. Asserts: no "Register before you deposit" prompt for A,
//   exactly one deposit broadcast that confirms, A's app never persists the
//   recipient's note ("Persisted pending deposit note" must NOT appear) and
//   stamps the outgoing tx instead, and B's session discovers a note with that
//   tx hash on its next sync.
// Case 2 (A -> fresh, never-registered address): one confirmed blind deposit
//   produces a claim link for the intended recipient and exact deposited note.
//
// Env: DEV_PK (A, payer) and DEV_PK2 (B) or E2E_ACCOUNT_A_PK / E2E_ACCOUNT_B_PK.
import type { Page } from 'playwright';
import { parseEther } from 'viem';
import {
  accountFromKey, bodyText, clickButton, enterAmount, openApp,
  signIn, sleep, tab, unlockIfPrompted, submit, waitForDepositHash, waitForText,
  selectToken, awaitNativeDeposit, accountNotes, forceUnlock,
} from './lib';
import { envValue, mintEphemeral } from './funding';

const aKey = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const bKey = envValue('E2E_ACCOUNT_B_PK') ?? envValue('DEV_PK2');
if (!aKey || !bKey) throw new Error('need E2E_ACCOUNT_A_PK/E2E_ACCOUNT_B_PK or DEV_PK/DEV_PK2');
const A = accountFromKey(aKey.startsWith('0x') ? aKey : `0x${aKey}`);
const B = accountFromKey(bKey.startsWith('0x') ? bKey : `0x${bKey}`);
const AMOUNT = envValue('E2E_DEPOSIT_FOR_ETH') ?? '0.0002';
const BASE = process.env.PROBE_URL || 'http://localhost:8081';

const results: { name: string; ok: boolean; detail: string }[] = [];
let failed = false;
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`>>> ${name}: ${ok ? 'PASS' : 'FAIL'} ${detail}`);
  if (!ok) failed = true;
};

console.log(`A (payer): ${A.address}\nB (recipient): ${B.address}`);

const payer = await openApp(A, { tag: 'depfor-a' });
let recipient: Awaited<ReturnType<typeof openApp>> | null = null;

/** Open the collapsed recipient field on the Shield tab and type an address. */
async function setShieldRecipient(page: Page, address: string): Promise<boolean> {
  const toggle = page.getByTestId('hub-shield-recipient-toggle');
  if (!(await toggle.isVisible().catch(() => false))) return false;
  const expanded = await toggle.getAttribute('aria-expanded');
  if (expanded !== 'true') { await toggle.click(); await sleep(500); }
  const input = page.getByTestId('hub-shield-recipient-input');
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.fill(address);
  await sleep(300);
  return (await input.inputValue()) === address;
}

try {
  await payer.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(payer.page);
  await tab(payer.page, 'Shield');
  await selectToken(payer.page, 'Shield');
  await sleep(1500);
  await unlockIfPrompted(payer.page);

  // ---- Case 1: A -> B (registered) ------------------------------------------
  if (!(await enterAmount(payer.page, AMOUNT, 'Shield'))) throw new Error('amount did not stick');
  if (!(await setShieldRecipient(payer.page, B.address))) throw new Error('recipient field not available on the Shield tab');
  await payer.shot('depfor-form');
  const sentBefore = payer.sent.length;
  const logFrom = payer.appLogs.length;
  const used = await submit(payer.page, ['Shield ETH']);
  console.log(`  pressed: ${used}`);
  // The payer must NOT be asked to register: the note is B's.
  let registerPrompt = false;
  const hash = await (async () => {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const t = await bodyText(payer.page);
      if (/Register before you deposit/i.test(t)) { registerPrompt = true; return null; }
      const h = await waitForDepositHash(payer.appLogs, 5_000, logFrom);
      if (h) return h;
      if (/Nothing was sent|not registered/i.test(t)) return null;
    }
    return null;
  })();
  record('no payer registration prompt', !registerPrompt, registerPrompt ? 'A was asked to register for a depositFor' : 'A was not asked to register');
  if (!hash) {
    await payer.shot('depfor-nohash');
    throw new Error(`deposit never broadcast: ${(await bodyText(payer.page)).match(/(Nothing was sent|failed|error)[^\n]{0,120}/i)?.[0] ?? 'no error text'}`);
  }
  const status = await awaitNativeDeposit(hash, AMOUNT, A.address);
  record('depositFor broadcast + confirmed', status === 'success' && payer.sent.length === sentBefore + 1,
    `${AMOUNT} ETH for B, receipt ${status}, ${payer.sent.length - sentBefore} tx(s), https://sepolia.etherscan.io/tx/${hash}`);
  // The stamp lands after the receipt, 2 to 6s later with a large fixture
  // account. A fixed 4s wait raced it (e2e runs 38251768622, 38253851048).
  const stampDeadline = Date.now() + 30_000;
  while (Date.now() < stampDeadline && !/Deposit for another address confirmed and stamped/.test(payer.appLogs.slice(logFrom).join('\n'))) {
    await sleep(1000);
  }
  await sleep(2000);
  const said = payer.appLogs.slice(logFrom).join('\n');
  record('payer keeps no recipient note', !/Persisted pending deposit note|Updated note with block timestamp/.test(said) && /Deposit for another address confirmed and stamped/.test(said),
    /stamped/.test(said) ? 'no own-note write; outgoing tx stamped' : 'stamp log missing or a note was persisted');
  const settled = await waitForText(payer.page, /shielded for 0x/i, 30_000);
  record('payer success copy names the recipient', !!settled, settled ? 'says "shielded for 0x…"' : 'own-balance copy shown instead');
  await payer.shot('depfor-success');

  // ---- B discovers the note -------------------------------------------------
  recipient = await openApp(B, { tag: 'depfor-b' });
  await recipient.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await signIn(recipient.page);
  await forceUnlock(recipient.page);
  // Ownership comes from B's SDK export, not a hash mentioned in debug logs.
  let discovered = false;
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline && !discovered) {
    discovered = (await accountNotes(recipient.page, B.address)).some(n =>
      n.txHash?.toLowerCase() === hash.toLowerCase() && BigInt(n.value) > 0n);
    if (!discovered) await sleep(5000);
  }
  await recipient.shot('depfor-b-discovery');
  if (!discovered) {
    console.log('  --- B SDK/discovery console lines ---');
    for (const l of recipient.appLogs.filter((x) => /\[SDK|Note discovery|KeystoreRegistration/.test(x)).slice(-25)) console.log('  ', l.slice(0, 260));
  }
  record('recipient discovers the note', discovered, discovered ? `B holds a note from ${hash.slice(0, 10)}…` : 'B never saw a note with the deposit tx hash within 8 min');

  // ---- Case 2: A -> fresh unregistered address: blind deposit + claim link ----
  const fresh = mintEphemeral().account;
  await payer.page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await unlockIfPrompted(payer.page);
  await tab(payer.page, 'Shield');
  await selectToken(payer.page, 'Shield');
  await sleep(1000);
  await unlockIfPrompted(payer.page);
  if (!(await enterAmount(payer.page, AMOUNT, 'Shield'))) throw new Error('amount did not stick (case 2)');
  if (!(await setShieldRecipient(payer.page, fresh.address))) throw new Error('recipient field not available (case 2)');
  const sentBefore2 = payer.sent.length;
  const logFrom2 = payer.appLogs.length;
  await submit(payer.page, ['Shield ETH']);
  const blindHash = await waitForDepositHash(payer.appLogs, 300_000, logFrom2);
  if (!blindHash) throw new Error('Blind deposit did not broadcast');
  const blindStatus = await awaitNativeDeposit(blindHash, AMOUNT, A.address);
  record('unregistered deposit confirmed', blindStatus === 'success' && payer.sent.length === sentBefore2 + 1,
    'exactly one deposit for the unregistered recipient');
  const claimCopy = await waitForText(payer.page, /send them the claim link below/i, 30_000);
  if (!claimCopy) throw new Error('Blind deposit success did not explain the claim link');
  await payer.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  if (!(await clickButton(payer.page, 'Copy claim link'))) throw new Error('Claim link copy is not actionable');
  await waitForText(payer.page, /Claim link copied/i, 15_000);
  let matches = false;
  try {
    const link = await payer.page.evaluate(() => navigator.clipboard.readText());
    const encoded = new URL(link).hash.slice(1);
    const receipt = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const note = receipt.notes?.[0];
    matches = receipt.chainId === 11155111 && receipt.notes.length === 1
      && note.txHash?.toLowerCase() === blindHash.toLowerCase()
      && note.ownerAddress?.toLowerCase() === fresh.address.toLowerCase()
      && note.tokenId?.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      && BigInt(note.value) === parseEther(AMOUNT) && Boolean(note.noteSecret && note.label && note.commitment);
  } catch { /* Report only the verdict; never print a claim payload or secret. */ }
  record('unregistered claim link matches the deposit', matches,
    matches ? 'link carries the confirmed note for the intended recipient' : 'claim fields did not match the deposit');
  await payer.shot('depfor-unregistered');

} catch (e) {
  record('deposit-for', false, (e as Error).message);
} finally {
  await payer.browser.close();
  await recipient?.browser.close();
}

console.log('\n===== deposit-for summary =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
process.exit(failed ? 1 : 0);
