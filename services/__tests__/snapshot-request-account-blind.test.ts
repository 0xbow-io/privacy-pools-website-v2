import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createSnapshotStore } from '@/services/snapshot-cache';
import { snapshotCursor } from '@/services/asp-event-snapshot';
import { mergeSnapshotDelta, snapshotDeltaSince } from '@/services/snapshot-delta';

// The held event snapshot is what note discovery now reads on every chain, so
// its request must be the SAME bytes for every account: the whole pool's rows,
// no address, label, commitment, nullifier or amount, and a cursor that comes
// from the pool's own watermark. Runs the production refresh path
// (gridOwnedPayload in services/snapshot-source.ts) twice, once per account,
// and compares every request it sent.

const path = new URL('../snapshot-source.ts', import.meta.url);
const source = ts.createSourceFile('snapshot-source.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const pick = (name: string) => source.statements.find((s) =>
  (ts.isFunctionDeclaration(s) && s.name?.text === name)
  || (ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(source) === name)))!.getText(source);
const code = ['poolKeyOf', 'splitPoolKey', 'gridOwnedPayload', 'INCLUDE'].map(pick).join('\n');
const js = ts.transpileModule(`${code}\nreturn { gridOwnedPayload, INCLUDE };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const ACCOUNTS = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];

async function requestsFor(account: string): Promise<unknown[]> {
  const sent: unknown[] = [];
  let head = 26_000_000;
  const apiClient = {
    getEventSnapshotPayload: async (chainId: number, include: readonly string[], since: bigint | undefined, entrypoint?: string) => {
      sent.push({ chainId, include: [...include], since: since === undefined ? null : String(since), entrypoint });
      head += 10;
      const rows = { deposits: [], transacts: [], ragequits: [], notes: [] };
      return { chainId: String(chainId), snapshotBlockNumber: String(head), ...rows };
    },
  };
  // What a session would hold for this account; the request path must never read it.
  (globalThis as Record<string, unknown>).__ppv2ActiveAccount = account;
  const env = {
    apiClient,
    resolveConfiguredEntrypoint: async () => '0xca1e072236d231130059eea6bfceb7f4e9a1f0c3',
    createSnapshotStore,
    snapshotCursor,
    mergeSnapshotDelta,
    snapshotDeltaSince,
    getChainConfig: () => ({ contracts: { fromBlock: 25_884_228n } }),
    blockTimeMs: () => 12_000,
    publicFeeds: { isRunning: () => true, registered: () => ['event-snapshot:1'] },
  };
  const { gridOwnedPayload, INCLUDE } = new Function(...Object.keys(env), js)(...Object.values(env));
  const feed = gridOwnedPayload({
    flag: `__testSnapshot_${account}`,
    label: 'event snapshot',
    include: INCLUDE,
    feedKey: (c: number) => `event-snapshot:${c}`,
  });
  try {
    await feed.refresh(1); // the page-load download
    await feed.refresh(1); // a grid instant's delta
  } finally {
    delete (globalThis as Record<string, unknown>).__ppv2ActiveAccount;
  }
  return sent;
}

test('two accounts send byte-identical snapshot requests that name nothing of theirs', async () => {
  const a = await requestsFor(ACCOUNTS[0]);
  const b = await requestsFor(ACCOUNTS[1]);
  expect(a.length).toBe(2);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  for (const account of ACCOUNTS) expect(JSON.stringify(a).toLowerCase()).not.toContain(account.slice(2));
  // Whole pool, every section discovery reads.
  expect((a[0] as { include: string[] }).include).toEqual(['deposits', 'transacts', 'ragequits', 'notes']);
});
