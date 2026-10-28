// @ts-nocheck
// The recipient autocomplete on the REAL Withdraw form (PR #37).
//
//   1. Nothing on this origin (no payout records, no contacts): focusing the
//      recipient field shows the empty state. It must never look dead, which
//      is what a fresh origin (a Vercel preview, a new device) looked like.
//   2. Seeded device payout records: focusing opens the listbox, newest first;
//      ArrowDown + Enter fills the field with the checksummed address.
//
// Read-only: no transaction, no deposit. Seeds only this device's local
// records, never anything derived from a note.
//
//   SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/e2e/recipient-autocomplete.ts
//   PROBE_URL=https://<preview>.vercel.app  (Vercel-protected: VERCEL_OIDC_TOKEN is sent to that host only)
import { BASE, openApp, signIn, sleep, tab } from './lib';
import { accountFromKey, envValue } from './funding';

const key = envValue('E2E_ACCOUNT_A_PK') ?? envValue('DEV_PK');
if (!key) throw new Error('E2E_ACCOUNT_A_PK or DEV_PK is required');
const acct = accountFromKey(`0x${key.replace(/^0x/, '')}`);

const SEEDED = [
  { recipient: '0xd3581763f41fc0763a49e9ab53f2d3d425870a3d', ageMs: 3_600_000 },
  { recipient: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', ageMs: 86_400_000 },
  { recipient: '0xab5801a7d398351b8be11c439e05c5b3259aec9b', ageMs: 5 * 86_400_000 },
];

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

async function withPreviewAuth(page) {
  const token = process.env.VERCEL_OIDC_TOKEN;
  if (!token || !/\.vercel\.app$/.test(new URL(BASE).host)) return;
  const host = new URL(BASE).host;
  // Origin-scoped: the token goes to the preview host and nowhere else.
  await page.context().route('**/*', (route) => {
    const req = route.request();
    if (new URL(req.url()).host !== host) return route.continue();
    return route.continue({ headers: { ...req.headers(), 'x-vercel-trusted-oidc-idp-token': token } });
  });
}

async function focusRecipient(page) {
  await tab(page, 'Withdraw');
  const field = page.getByTestId('withdraw-recipient-input').filter({ visible: true }).first();
  await field.waitFor({ timeout: 90_000 });
  await field.click();
  await sleep(1500);
  return field;
}

async function run(phase: 'empty' | 'seeded') {
  const app = await openApp(acct, { tag: `recipient-autocomplete-${phase}` });
  const { page, browser } = app;
  try {
    await withPreviewAuth(page);
    if (phase === 'seeded') {
      await page.context().addInitScript((rows) => {
        const h = (n) => `0x${n.toString(16).padStart(64, '0')}`;
        const now = Date.now();
        const list = rows.map((r, i) => ({ txHash: h(i + 1), chainId: 1, recipient: r.recipient, timestamp: now - r.ageMs }));
        for (const sfx of ['', '_prod']) localStorage.setItem(`ppv2_withdraw_recipients_v1${sfx}`, JSON.stringify(list));
      }, SEEDED);
    }
    await signIn(page);
    const field = await focusRecipient(page);
    if (phase === 'empty') {
      const hasRecords = await page.evaluate(() => Object.keys(localStorage).some((k) => /withdraw_recipients|sent_transfers|ppv2_contacts/.test(k)));
      const empty = await page.getByTestId('withdraw-recipient-empty').isVisible().catch(() => false);
      const list = await page.getByTestId('withdraw-recipient-suggestions').isVisible().catch(() => false);
      // A session whose Activity rows name a payee can show rows here instead;
      // either way focus must answer with something visible.
      record('focus answers on a fresh origin', empty || list, `empty state ${empty}, list ${list}, local records ${hasRecords}`);
      await app.shot('empty-focused');
    } else {
      const options = page.getByRole('option');
      const n = await options.count();
      const first = n ? (await options.first().innerText()).trim() : '';
      record('focus opens the list', n >= SEEDED.length, `${n} rows`);
      record('newest first', /0xD358/i.test(first), `first row ${first.replace(/\s+/g, ' ')}`);
      await app.shot('seeded-open');
      await field.press('ArrowDown');
      await field.press('Enter');
      await sleep(500);
      const value = await field.inputValue();
      record('Enter fills the field', value.toLowerCase() === SEEDED[0].recipient, value);
    }
  } finally {
    await browser.close();
  }
}

await run('empty');
await run('seeded');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
