// @ts-nocheck
// Renders the relayer-fee rows for known relayed spends (Pat/Mike, 2026-08-26).
// The fee is never in the ASP feed, so the detail panel reads it from
// services/withdraw-fees-store; this probe seeds a fee exactly as the flows do,
// opens the row by its ?tx= deep link, and reads the panel back. Two cases:
//   SINGLE  a withdrawal that is one row → "Relayer fee" + "Net after fee";
//   BATCH   a batch withdrawal, several rows under ONE hash sharing ONE
//           aggregate fee → the fee block must be SUPPRESSED, because the
//           aggregate against a per-item gross understates every item.
// The transfer side is proven end to end by the sepolia `send` phase.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap env E2E_NO_DEBUG=1 bun scripts/visual/probe-relayer-fee-row.local.ts
import { accountFromKey, bodyText, openApp, sleep, unlockIfPrompted } from '../e2e/lib';
import { envValue } from '../e2e/funding';

const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
const acct = accountFromKey(key.startsWith('0x') ? key : `0x${key}`);
const BASE = process.env.PROBE_URL || 'http://localhost:8081';
// Real Sepolia withdrawals from the ASP feed. SINGLE is one row of
// 0.00087021819365 ETH gross; BATCH is six rows under one hash.
const SINGLE = '0x4a35789df2d944c58bf528d1c800965d42f328c305fc03cac8ac394dd27e806d';
const BATCH = '0x4fcf2e9f2717e56692802ff35e048eaa121fafb51ab592b535625f51694ba6ba';
const FEE_WEI = 493000000000000n; // 0.000493 ETH, a real relayer quote

const app = await openApp(acct, { tag: 'relayer-fee-row' });

async function seed(txHash: string) {
  await app.page.evaluate(({ hash, feeHex }) => {
    const rows = JSON.parse(localStorage.getItem('ppv2_withdraw_fees_v1') || '[]');
    const kept = (Array.isArray(rows) ? rows : []).filter((r) => String(r.txHash).toLowerCase() !== hash);
    kept.push({
      txHash: hash,
      feeAmount: feeHex,
      tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      chainId: 11155111,
      timestamp: Date.now(),
      kind: 'withdrawal',
    });
    localStorage.setItem('ppv2_withdraw_fees_v1', JSON.stringify(kept));
  }, { hash: txHash.toLowerCase(), feeHex: `0x${FEE_WEI.toString(16)}` });
}

/** Open a row by deep link and return the page text once it settles. */
async function openAndRead(txHash: string, expectFee: boolean): Promise<string> {
  await app.page.goto(`${BASE}/chains/sepolia/eth?tx=${txHash}`, { waitUntil: 'domcontentloaded' });
  await sleep(9000);
  await unlockIfPrompted(app.page);
  let body = '';
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    body = await bodyText(app.page);
    // The panel is up once it prints the tx it is about; only then is the
    // absence of a fee row meaningful rather than "not rendered yet".
    const shown = body.toLowerCase().includes(txHash.slice(0, 8).toLowerCase())
      && body.toLowerCase().includes(txHash.slice(-6).toLowerCase());
    if (shown && (!expectFee || /Relayer fee/i.test(body))) break;
    await sleep(5000);
  }
  return body;
}

try {
  // Unlock once, on a plain page, before any deep link.
  await app.page.goto(`${BASE}/chains/sepolia/eth`, { waitUntil: 'domcontentloaded' });
  await sleep(9000);
  await unlockIfPrompted(app.page);
  await sleep(20000);
  await seed(SINGLE);
  await seed(BATCH);

  const single = await openAndRead(SINGLE, true);
  console.log('SINGLE withdrawal row:');
  console.log(`  panel is this tx: ${single.toLowerCase().includes(SINGLE.slice(0, 8))}`);
  console.log(`  "Relayer fee" shown: ${/Relayer fee/i.test(single)}`);
  console.log(`  exact figure 0.000493 shown: ${/0\.000493/.test(single)}`);
  console.log(`  "Net after fee" shown: ${/Net after fee/i.test(single)}`);
  // gross 0.00087021819365 - fee 0.000493 = 0.00037721819365
  console.log(`  net 0.00037721 shown: ${/0\.00037721/.test(single)}`);
  await app.shot('fee-single-withdrawal');

  const batch = await openAndRead(BATCH, false);
  console.log('BATCH withdrawal item row:');
  console.log(`  panel is this tx: ${batch.toLowerCase().includes(BATCH.slice(0, 8))}`);
  console.log(`  "Relayer fee" suppressed: ${!/Relayer fee/i.test(batch)}`);
  console.log(`  "Net after fee" suppressed: ${!/Net after fee/i.test(batch)}`);
  await app.shot('fee-batch-item');
} finally {
  await app.browser.close();
}
