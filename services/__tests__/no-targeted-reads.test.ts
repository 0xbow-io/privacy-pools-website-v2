import { describe, expect, test } from 'bun:test';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guard against reintroducing the targeted-read privacy leak.
 *
 * `PoolVault.commitments(c)` and `PoolVault.spentNullifiers(n)` take a
 * secret-derived value as the eth_call argument. The RPC provider separately
 * observes that same value on-chain, so it can join "this client asked about N"
 * with "N appeared in a Transacted event" and deanonymize the spend. The
 * transfer and withdraw flows made exactly those calls on the submit path.
 *
 * This is a TEST rather than an ESLint rule on purpose: this app's CI
 * (.github/workflows/ci.yml) runs `bun test` and nothing else — no lint, no
 * typecheck — so a lint rule here would never actually execute.
 */

// `import.meta.dir` is a Bun extension the app's tsconfig doesn't model; the
// URL form is standard and resolves identically under the Bun runner.
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/** Directories that ship to users. Scripts and tests are excluded deliberately. */
const SCANNED_DIRS = ['services', 'components', 'hooks', 'app'];

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__']);

/**
 * Files allowed to name the forbidden methods, each with a reason.
 *
 * `onchain-note-index.ts` is the bulk replacement and names them only in prose.
 *
 * `egress-policy.ts` is the runtime allowlist that REFUSES these calls: it has
 * to name the two selectors in order to block them, the way a denylist names
 * what it denies. The test below proves it actually blocks rather than merely
 * mentions them, so the exemption cannot become a hiding place.
 *
 * Nothing else in a user-reachable path should reference them at all.
 */
const ALLOW_LIST = new Set([
  'services/onchain-note-index.ts',
  'services/egress-policy.ts',
]);

/**
 * Directory prefixes allowed for now, each a KNOWN open instance of the leak
 * class, not an exception to the rule:
 *
 * - `services/sui-witness/`: the Sui witness reconstruction reads the pool's
 *   `getCommitmentTimestamp` Move view once per note (devInspect on the Sui
 *   RPC). Same class of leak on Sui; the bulk index here is EVM-only. Closing it
 *   needs a Sui event index (Deposited/Transacted Move events) and is tracked
 *   separately. Sui is testnet-only today.
 */
const ALLOW_PREFIXES = ['services/sui-witness/'];

/**
 * Anything that names a per-note chain read, however it is spelled: the method
 * names as identifiers (calls, aliasing, destructuring, bracket access), the
 * raw contract functions in a `readContract`/ABI string. Bulk reads (getLogs,
 * event snapshots, association-set leaves) are the replacement and are not
 * matched.
 *
 * Per-label ASP status GETs (`/labels/{label}/status`) are the same leak class
 * on the HTTP side; they are issued by the vendored SDK's note discovery
 * through the wrapper in services/sdk-setup.ts, and close when the SDK
 * tarball is rebuilt with bulk `getRejectedLabels` (asp-v2 #115). Not guarded
 * here because the app cannot remove them yet; see SDK_PATCHES.md.
 */
const FORBIDDEN = new RegExp(
  [
    String.raw`\b(getCommitmentTimestamp|getNullifierTimestamp)\b`,
    String.raw`functionName\s*:\s*['"](commitments|spentNullifiers)['"]`,
    String.raw`function\s+(commitments|spentNullifiers)\s*\(`,
    // ABI fragments and viem contract-instance spellings of the same reads.
    String.raw`name\s*:\s*['"](commitments|spentNullifiers)['"]`,
    String.raw`\.read\.(commitments|spentNullifiers)\s*\(`,
    // 4-byte selectors of commitments(uint256) / spentNullifiers(uint256).
    String.raw`0x49ce8997|0x811608fd`,
  ].join('|'),
);

const RECEIPT_OR_BLOCK_READS = /\b(getTransactionReceipt|waitForTransactionReceipt|getBlock)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('privacy: no targeted commitment/nullifier reads on user-reachable paths', () => {
  test('find no call to getCommitmentTimestamp or getNullifierTimestamp', () => {
    const offenders: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (ALLOW_LIST.has(rel) || ALLOW_PREFIXES.some((p) => rel.startsWith(p))) continue;
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, i) => {
          // Ignore comments: prose may legitimately name the old methods when
          // explaining why they were removed.
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (FORBIDDEN.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  test('the egress policy earns its exemption: it REFUSES the selectors it names', async () => {
    // The allowlist above lets one file name the forbidden selectors. That is
    // only safe while the file is the thing that blocks them, so assert the
    // behaviour rather than trusting the comment: a future edit that keeps the
    // constants but drops the check fails here, not silently in production.
    const { checkRpcRequest, FORBIDDEN_CALL_SELECTORS } = await import('@/services/egress-policy');
    const selectors = Object.keys(FORBIDDEN_CALL_SELECTORS);
    expect(selectors.length).toBeGreaterThanOrEqual(2);
    // The two selectors this guard's own regex names must be among them, so the
    // exemption covers exactly the reads the guard is about.
    expect(selectors).toContain('0x49ce8997');
    expect(selectors).toContain('0x811608fd');
    for (const selector of selectors) {
      const verdict = checkRpcRequest({
        method: 'POST',
        url: 'https://rpc.example',
        body: JSON.stringify({
          method: 'eth_call',
          params: [{ to: '0x'.padEnd(42, '1'), data: `${selector}${'0'.repeat(64)}` }, 'latest'],
        }),
      });
      expect(verdict.allowed).toBe(false);
    }
  });

  test('viem ENS lookups live ONLY in services/ens.ts (counterparty ENS is off by default, a product decision)', () => {
    // Counterparty ENS resolution was deliberately disabled by default on
    // 2026-08-26 (9f8b2c0 + ebe017b): a lookup names the counterparty to the
    // provider. services/ens.ts is the single, flag-gated, off-pool-RPC door.
    // Any other file calling viem's ENS methods bypasses both protections.
    const ENS_CALLS = /\b(getEnsName|getEnsAddress|getEnsAvatar)\s*\(/;
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === 'services/ens.ts') continue;
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (ENS_CALLS.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  test('ENS resolution stays OFF by default: no default-true and the gate stands in every resolver', () => {
    const env = readFileSync(join(ROOT, 'config', 'env.ts'), 'utf8');
    const def = env.slice(env.indexOf('export const ENS_RESOLUTION_ENABLED'));
    const defBlock = def.slice(0, def.indexOf(');') + 2);
    // getBooleanEnv(undefined, undefined) must stay falsy: no literal true
    // anywhere in the definition (a `?? true` or 'true' fallback flips the
    // product decision silently).
    expect(defBlock.includes('true')).toBe(false);
    const ens = readFileSync(join(ROOT, 'services', 'ens.ts'), 'utf8');
    // Every exported resolver early-returns on the flag - one gate per door.
    const resolverCount = (ens.match(/^export async function resolve/gm) ?? []).length;
    const gateCount = (ens.match(/if \(!ENS_RESOLUTION_ENABLED\) return null;/g) ?? []).length;
    expect(resolverCount >= 3).toBe(true);
    expect(gateCount).toBe(resolverCount);
  });

  test('the claim path reads no transaction receipt or block: every tx hash there is someone ELSE\'s relayed transfer', () => {
    // hooks/use-note-import.ts:224 used to heal a stubbed createdAtBlock with
    // getTransactionReceipt(note.txHash) followed by getBlock(receipt.blockNumber).
    // That txHash is the SENDER'S relayed transfer, so a public RPC could join
    // "this client asked about transfer X" against "transfer X's output
    // commitment" - which it separately sees on chain - and link the recipient's
    // device to the note it owns and to the sender. It is the case named in
    // CLAUDE.md and docs/privacy-request-discipline.md. Removed 2026-09-01; the
    // bulk snapshot path in the same function already resolved the same value.
    //
    // Scoped to the claim surfaces rather than banned repo-wide ON PURPOSE.
    // Waiting on a receipt is perfectly fine for a transaction THIS wallet just
    // submitted - deposit, ragequit, transfer - and a dozen call sites correctly
    // do exactly that. What makes it a leak is the ARGUMENT being a hash derived
    // from someone else's note, which no regex can decide in general. These files
    // are where such a hash is reachable, so here the rule is absolute.
    // For a relayed spend, use confirmRelayedSpend() / services/onchain-note-index.ts.
    const CLAIM_PATH = (rel: string) =>
      rel === 'hooks/use-note-import.ts' || rel.startsWith('app/import-note/');

    // The ONLY permitted arguments: hashes this wallet itself just submitted via
    // sendTransactionAsync, a few lines above each call, during the cold-start
    // registration leg. Waiting on your own transaction reveals nothing to the
    // provider that it did not just receive from you. Both are verified by
    // reading the surrounding code, not by their names - add to this list only
    // after doing the same, and never to make a failing scan pass.
    const OWN_SUBMITTED_HASHES = ['keystoreHash', 'viewingKeyHash'];
    const isOwnSubmittedWait = (line: string) =>
      OWN_SUBMITTED_HASHES.some((id) => new RegExp(String.raw`hash\s*:\s*${id}\b`).test(line));

    const offenders: string[] = [];
    let scanned = 0;
    let allowed = 0;

    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (!CLAIM_PATH(rel)) continue;
        scanned += 1;
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          // Prose may name the removed calls to explain why they are gone.
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          if (!RECEIPT_OR_BLOCK_READS.test(line)) return;
          if (isOwnSubmittedWait(line)) { allowed += 1; return; }
          offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });
      }
    }

    // The exemptions must still EXIST. If the cold-start waits are refactored
    // away, this list should shrink rather than sit here permitting a name that
    // some future code could reuse for a note-derived hash.
    expect(allowed).toBe(OWN_SUBMITTED_HASHES.length);

    // A rename would otherwise make this pass by scanning nothing.
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('rebuilt sent payment links do not receipt-read their relayed transfer hash', () => {
    // components/pools/transactions.tsx can rebuild a sent payment link from
    // sentAudits. That tx hash is historical row data, not a transaction this
    // wallet just submitted. A convenience receipt/block lookup there leaks the
    // same association the import path deliberately avoids, so this UI surface
    // gets its own narrow guard.
    const rel = 'components/pools/transactions.tsx';
    const offenders: string[] = [];
    readFileSync(join(ROOT, rel), 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (RECEIPT_OR_BLOCK_READS.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
    expect(offenders).toEqual([]);
  });

  test('scan a non-trivial number of files, so a broken walk cannot pass vacuously', () => {
    const count = SCANNED_DIRS.reduce((n, dir) => n + walk(join(ROOT, dir)).length, 0);
    expect(count > 50).toBe(true);
  });
});

/**
 * The same leak class, keyed on the withdrawal AMOUNT rather than on a note.
 *
 * `GET /:chainId/public/deposits-larger-than?amount=<wei>` answers "how many
 * deposits are at least this large?", so it has to be told the amount. The
 * withdraw form called it on every distinct value typed, with no debounce, for
 * the entered amount and two "blend in" candidates. That integer is the same
 * one that appears in the withdrawal on chain minutes later, so the ASP can
 * join "this session asked about V" to "a withdrawal of V happened", and it
 * already knows which deposits the session owns. Reported publicly 2026-09-10.
 *
 * The replacement is a caller-independent feed of the whole amount
 * distribution (asp-v2#127, `/public/deposit-amounts`) counted locally. Two
 * rules come with it, and only the first can be enforced here:
 *
 *  1. Never send the amount. Guarded below.
 *  2. Fetch the distribution with the other public feeds AT PAGE LOAD, never
 *     when the withdraw form opens. A request that only happens when a
 *     withdrawal is imminent reveals that through its timing even though its
 *     body is neutral. No test can see a trigger, so that one lives in review.
 */
const AMOUNT_KEYED_ASP_READ = new RegExp(
  [
    String.raw`deposits-larger-than`,
    String.raw`\bgetDepositsLargerThan\b`,
    String.raw`\bDepositsLargerThanResponse\b`,
  ].join('|'),
);

describe('privacy: no amount-keyed ASP reads on user-reachable paths', () => {
  test('find no request keyed on the withdrawal amount', () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        scanned++;
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // Prose may name the endpoint when explaining why it is gone.
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
            if (AMOUNT_KEYED_ASP_READ.test(line)) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
          });
      }
    }

    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  test('the recipient exemption is per call, not per file', () => {
    const exempt = (rel: string, line: string) => (RECIPIENT_FALLBACK_CALLS[rel] ?? []).some((re) => re.test(line.trim()));
    expect(exempt('components/deposit-modal-provider.tsx', '{ getViewingKey: (a) => ks.getViewingKey(a) },')).toBe(true);
    expect(exempt('components/deposit-modal-provider.tsx', 'const v = await ks.getViewingKey(sessionAddress);')).toBe(false);
  });
});

/**
 * Keystore reads keyed by an account: `Keystore.getNullifyingKeyHash(account)`
 * and `Keystore.getViewingKey(account)`. Read for the user's OWN account at
 * every sign-in, they named that account to the RPC provider (L2BEAT). The
 * identity check now reads the bulk ASP registries
 * (services/nullifying-key-hash-cache.ts, services/viewing-key-cache.ts).
 *
 * `getNullifyingKeyHash` has no legitimate caller left. `getViewingKey` still
 * has one use: the RPC FALLBACK of a recipient lookup, which runs only when the
 * ASP registry is not deployed or a sync failed (services/viewing-key-cache.ts
 * lookupViewingKey), and the relayed-transfer builder that is handed that
 * lookup. Those files are listed below; the user's own account must never be
 * read this way anywhere.
 */
const KEYSTORE_ACCOUNT_READS = /\b(getNullifyingKeyHash|getViewingKey)\s*\(/;
// Exactly the recipient-lookup call shapes, per file: a new getViewingKey call
// in one of these files (say on the session account) is still an offender.
const RECIPIENT_FALLBACK_CALLS: Record<string, RegExp[]> = {
  'services/viewing-key-cache.ts': [
    /^const key = await rpcFallback\.getViewingKey\(account\);$/,
    // The RpcFallback interface declaration, not a call.
    /^getViewingKey\(account: Address\): Promise<Hex \| string>;$/,
  ],
  'services/relayed-transfer.ts': [
    /^const publicViewingKey = await deps\.getViewingKey\(spec\.evmAddress\);$/,
    /^getViewingKey: async \(evmAddress\) => \(await keystore\.getViewingKey\(evmAddress\)\) as Hex,$/,
  ],
  'components/transfer-modal-provider.tsx': [/^\{ getViewingKey: \(a\) => ks\.getViewingKey\(a\) \},$/],
  'components/deposit-modal-provider.tsx': [/^\{ getViewingKey: \(a\) => ks\.getViewingKey\(a\) \},$/],
  'components/payment-request-modal-provider.tsx': [/^\{ getViewingKey: \(account\) => ks\.getViewingKey\(account\) \},$/],
};

describe('privacy: no per-account keystore reads for the session account', () => {
  test('getNullifyingKeyHash is never called, getViewingKey only as a recipient fallback', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (ALLOW_PREFIXES.some((p) => rel.startsWith(p))) continue;
        const source = readFileSync(file, 'utf8');
        source.split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
          const m = KEYSTORE_ACCOUNT_READS.exec(line);
          if (!m) return;
          if (m[1] === 'getViewingKey' && (RECIPIENT_FALLBACK_CALLS[rel] ?? []).some((re) => re.test(trimmed))) return;
          offenders.push(`${rel}:${i + 1}: ${trimmed}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
