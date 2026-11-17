import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../hooks/use-my-transaction-ownership.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('  const { notes }'), source.indexOf('  const ownedIdentity'));
const compiled = ts.transpileModule(`${body}\nreturn { ownAddress, allOwnedNotes, notesByChain };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function activity(isEvm: boolean, connectedAddress: string | undefined, keyMode = false) {
  const reads: string[] = [];
  const live = { commitment: 'live', txHash: 'live-tx' };
  const env = {
    useNotes: () => ({ notes: [live] }),
    useMultiChainWallet: () => ({ address: connectedAddress }),
    useChainRouter: () => ({ isEvm }),
    usePoolSession: () => ({ sessionAddress: 'evm-account', identityMode: keyMode ? 'key' : 'wallet' }),
    useMemo: (fn: () => unknown) => fn(),
    useLiveNotesChainId: () => isEvm ? 1 : 202,
    supportedChainIds: [1, 10, 202],
    getChainConfig: (id: number) => ({ chainType: id === 202 ? 'stellar' : 'evm' }),
    loadStoredAccountExport: (address: string, chainId: number) => {
      reads.push(address);
      return { notes: [{ commitment: `stored-${chainId}` }] };
    },
    mergeNotesByCommitment: (notes: unknown[], sets: unknown[][]) => [...notes, ...sets.flat()],
    Platform: { OS: 'native' },
  };
  const result = new Function(...Object.keys(env), compiled)(...Object.values(env));
  return { ...result, reads };
}

test('Stellar uses only its live account notes while an EVM wallet remains connected', () => {
  const result = activity(false, 'stellar-account');
  expect(result.ownAddress).toBe('stellar-account');
  expect(result.reads).toEqual([]);
  expect(result.allOwnedNotes).toHaveLength(1);
  expect([...result.notesByChain.keys()]).toEqual([202]);
});

test('an inactive EVM key account cannot replace the Stellar identity', () => {
  expect(activity(false, 'stellar-account', true).ownAddress).toBe('stellar-account');
  const disconnected = activity(false, undefined, true);
  expect(disconnected.ownAddress).toBeUndefined();
  expect(disconnected.reads).toEqual([]);
});

test('EVM retains the same account history across chains', () => {
  const result = activity(true, 'evm-account');
  expect(result.ownAddress).toBe('evm-account');
  expect(result.allOwnedNotes).toHaveLength(3);
  expect([...result.notesByChain.keys()]).toEqual([1, 10]);
  expect(new Set(result.reads)).toEqual(new Set(['evm-account']));
});

test('EVM key sessions retain their identity when a different funding wallet connects', () => {
  const result = activity(true, 'funding-wallet', true);
  expect(result.ownAddress).toBe('evm-account');
  expect(new Set(result.reads)).toEqual(new Set(['evm-account']));
});
