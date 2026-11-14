import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('pools-provider.tsx',
  readFileSync(new URL('../../components/pools-provider.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function initializer(name: string): string {
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && !found) {
      found = node.initializer.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

const names = ['myAddress', 'evmIdentity', 'myActivityAddress', 'storedNoteSets', 'freshSpendNotes', 'receivedCandidates', 'feedChainIds'] as const;
const code = ts.transpileModule(
  `${names.map((name) => `const ${name} = ${initializer(name)};`).join('\n')}\nreturn { ${names.join(', ')} };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function activity(activeChainId: number, multiChainAddress: string | undefined, keyMode = false) {
  const reads: string[] = [];
  const notes = [{ commitment: 'live' }];
  const env = {
    activeChainId,
    isEvmActive: activeChainId === 1,
    multiChainAddress,
    sessionAddress: 'evm-account',
    identityMode: keyMode ? 'key' : 'wallet',
    notes,
    liveChainId: activeChainId,
    syncedHoldings: new Set(),
    isDebugEnabled: false,
    supportedChainIds: [1, 10, 101, 202],
    STELLAR_TESTNET_ID: 202,
    getChainConfig: (id: number) => ({ chainType: id === 101 ? 'sui' : id === 202 ? 'stellar' : 'evm' }),
    useMemo: (fn: () => unknown) => fn(),
    loadStoredAccountExport: (address: string, chainId: number) => {
      reads.push(`${address}:${chainId}`);
      return { notes: [{ commitment: `stored-${chainId}` }] };
    },
    mergeNotesByCommitment: (live: unknown[], stored: unknown[][]) => [...live, ...stored.flat()],
    tagNotesByChain: (live: { chainId: number; notes: typeof notes } | null, stored: { chainId: number; notes: typeof notes }[]) =>
      [...(live?.notes ?? []), ...stored.flatMap((set) => set.notes)],
  };
  const result = new Function(...Object.keys(env), code)(...Object.values(env)) as Record<(typeof names)[number], unknown>;
  return { ...result, reads };
}

test('Stellar personal activity excludes a dormant EVM wallet and its saved notes', () => {
  const result = activity(202, 'stellar-account');
  expect(result.myActivityAddress).toBe('stellar-account');
  expect(result.reads).toEqual([]);
  expect(result.freshSpendNotes).toEqual([]);
  expect(result.receivedCandidates).toEqual([]);
  expect(result.feedChainIds).toEqual([1, 10]); // Public All still spans EVM chains.
});

test('a disconnected Stellar session does not fall back to the EVM wallet', () => {
  const result = activity(202, undefined, true);
  expect(result.myAddress).toBeUndefined();
  expect(result.myActivityAddress).toBeUndefined();
  expect(result.reads).toEqual([]);
});

test('Sui retains its live personal notes without classifying them as EVM spends', () => {
  const result = activity(101, 'sui-account');
  expect(result.myActivityAddress).toBe('sui-account');
  expect(result.receivedCandidates).toEqual([{ commitment: 'live' }]);
  expect(result.freshSpendNotes).toEqual([]);
  expect(result.reads).toEqual([]);
});

test('EVM retains saved cross-chain notes and account-key identity', () => {
  const wallet = activity(1, 'evm-account');
  expect(wallet.myActivityAddress).toBe('evm-account');
  expect(wallet.reads).toEqual(['evm-account:1', 'evm-account:10']);
  expect(wallet.freshSpendNotes).toHaveLength(3);
  const key = activity(1, 'funding-wallet', true);
  expect(key.myActivityAddress).toBe('evm-account');
  expect(key.reads).toEqual(['evm-account:1', 'evm-account:10']);
});
