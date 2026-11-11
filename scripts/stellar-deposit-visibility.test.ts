import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { canonicalCommitment, deriveStellarActivity, type StellarNoteOrigins } from '@/services/stellar-activity';

// Run the actual account methods with an in-memory SDK session. Any discovery
// must come from an explicit sync, never from the deposit's completion.
const source = ts.createSourceFile('account.ts', readFileSync('services/stellar/stellar-account.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'StellarAccount')!;
const js = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const OWNER = 'G-owner';
const note = { commitment: '0x0001', label: '0x2', value: '0x3b9aca00', tokenId: 'XLM', isOwned: true, status: 'PENDING', txHash: 'abc' };
const receipt = { status: true, txHash: 'abc', blockNumber: '0x64', logs: [{ ledgerClosedAt: '2026-11-11T04:00:00Z' }] };
const context = { chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7, priceUsd: 1, ownAddress: OWNER };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let notes: typeof note[] = [];
  let discovery = 0;
  let execution = async () => receipt;
  let origins = async (): Promise<StellarNoteOrigins> => ({ byCommitment: {}, complete: false });
  const session = {
    prepareDeposit: async () => ({ pendingNote: note }),
    prepareDepositFor: async () => ({ pendingNote: { ...note, isOwned: false } }),
    executeDeposit: async (prepared: { pendingNote: typeof note }) => {
      const result = await execution();
      if (result.status && prepared.pendingNote.isOwned) notes = [note];
      return result;
    },
    exportAccount: async () => ({ notes }),
    discoverNotes: async () => { discovery++; },
    isKeystoreRegistered: async () => true,
  };
  const globals = {
    EMPTY: { address: OWNER, notes: [], noteOrigins: null, paymentRequests: [], unlocked: true },
    STELLAR_TESTNET_CONTRACTS: { nativeAssetContractId: 'XLM' },
    toHex: (n: bigint) => `0x${n.toString(16)}`,
    canonicalCommitment, saveAccount: () => {}, requestStates: () => [],
  };
  const account = new Function(...Object.keys(globals), `${js}; return new StellarAccount();`)(...Object.values(globals)) as {
    snapshot: { address: string; notes: typeof note[]; noteOrigins: StellarNoteOrigins | null };
    generation: number; signer: object; sessionPromise: Promise<typeof session>;
    ensureSession(): Promise<typeof session>; ensureRegistered(): Promise<void>;
    readNoteOrigins(): Promise<StellarNoteOrigins>;
    deposit(params: { amount: bigint; recipient?: string }): Promise<unknown>;
    sync(): Promise<void>;
  };
  account.signer = {};
  account.sessionPromise = Promise.resolve(session);
  account.ensureSession = async () => session;
  account.ensureRegistered = async () => {};
  account.readNoteOrigins = () => origins();
  return {
    account, discovery: () => discovery,
    execute: (fn: typeof execution) => { execution = fn; },
    index: (fn: typeof origins) => { origins = fn; },
    rows: () => deriveStellarActivity(account.snapshot.notes, account.snapshot.noteOrigins, context).rows,
  };
}

test('a confirmed own deposit shows 100 XLM pending without discovery or an existing index', async () => {
  const f = fixture();
  await f.account.deposit({ amount: 1_000_000_000n });
  expect(f.discovery()).toBe(0);
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ type: 'Deposit', tokenAmount: 100, txHash: 'abc', status: 'pending' });
  expect(f.account.snapshot.noteOrigins?.byCommitment['0x1']).toMatchObject({ ledger: 100, time: Date.parse(receipt.logs[0].ledgerClosedAt) / 1000 });
});

test('an unsuccessful receipt creates no activity', async () => {
  const f = fixture(); f.execute(async () => ({ ...receipt, status: false }));
  await expect(f.account.deposit({ amount: 1n })).rejects.toThrow('failed on-chain');
  expect(f.rows()).toHaveLength(0);
});

test('a deposit for another account never becomes the payer’s own pending deposit', async () => {
  const f = fixture(); await f.account.deposit({ amount: 1n, recipient: 'G-other' });
  expect(f.rows()).toHaveLength(0);
  expect(f.account.snapshot.noteOrigins).toBeNull();
});

test('switching wallets during signing cannot publish the old deposit in the new account', async () => {
  const f = fixture();
  f.execute(async () => { f.account.snapshot.address = 'G-other'; f.account.generation++; return receipt; });
  await f.account.deposit({ amount: 1n });
  expect(f.account.snapshot.notes).toEqual([]);
  expect(f.account.snapshot.noteOrigins).toBeNull();
});

test('a sync already reading an older index cannot erase the confirmed deposit', async () => {
  const f = fixture(); const pending = deferred<StellarNoteOrigins>(); const started = deferred<void>();
  f.index(() => { started.resolve(); return pending.promise; });
  const sync = f.account.sync(); await started.promise;
  await f.account.deposit({ amount: 1_000_000_000n });
  pending.resolve({ byCommitment: {}, complete: false }); await sync;
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0].tokenAmount).toBe(100);
});

test('the regular index replaces the local origin without duplicating the deposit', async () => {
  const f = fixture(); await f.account.deposit({ amount: 1n });
  const origin = f.account.snapshot.noteOrigins!.byCommitment['0x1'];
  f.index(async () => ({ byCommitment: { '0x1': { ...origin, time: origin.time + 1 } }, complete: true }));
  await f.account.sync();
  expect(f.rows()).toHaveLength(1);
  expect(f.account.snapshot.noteOrigins?.byCommitment['0x1'].time).toBe(origin.time + 1);
  expect(f.account.snapshot.noteOrigins?.complete).toBe(true);
});
