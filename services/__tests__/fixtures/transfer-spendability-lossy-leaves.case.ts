import { mock } from 'bun:test';

// QA 2026-10-15, BNB Chain: the portfolio showed 0.02893 BNB while the
// payment-request preflight treated only 0.0011 BNB as spendable. The index
// had served chain-proven timestamps for every note, and the preflight then
// re-checked them against a fresh getStateLeaves() fetch, which is eth_getLogs
// in 1000-block windows on BSC and silently loses ranges. A holed leaf set
// must never drop a note the index already proved.

const OWNER = '0x00000000000000000000000000000000000000aa';
const note = (commitment: string, value: string) => ({
  commitment, value, label: `0x${commitment.slice(-2)}`, tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  isOwned: true, ownerAddress: OWNER, noteSecret: '0x1234', status: 'ACTIVE', createdAtBlock: '0x10',
});
const notes = [note('0xc1', '28000000000000000'), note('0xc2', '1098148975083278')];
// Leaf hash = the joined inputs, so the test controls which leaves "exist".
const hash = (xs: string[]) => xs.join('|');
// Only c2's leaf survived the lossy fetch.
const fetchedLeaves = [hash(['0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9', '0xc2', '0x10'])];

mock.module('@/config/chains', () => ({ getChainConfig: () => ({ contracts: { poolAddress: '0xpool', fromBlock: 1n } }) }));
mock.module('@/config/env', () => ({ LEGACY_CONFIG: null }));
mock.module('@/services/sdk-types', () => ({ NoteStatus: { ACTIVE: 'ACTIVE' } }));
mock.module('@/services/sdk-runtime', () => ({
  createHashService: async () => ({ hash }),
  createMerkleService: () => ({}),
  createNoteComputationService: async () => ({ computeNullifier: (_k: string, c: string) => `n${c}` }),
  createASPClient: async () => ({ getAssociationSetLeaves: async () => notes.map((n) => hash([n.label])) }),
  createRPCInteractor: () => ({}),
  createPoolVaultInteractor: () => ({ getStateLeaves: async () => fetchedLeaves }),
  healNoteTimestamps: async () => ({ healed: 0, removed: 0 }),
}));
mock.module('@/services/onchain-note-index', () => ({
  createOnChainNoteIndex: () => ({
    refresh: async () => {},
    isNullifierSpent: () => false,
    nullifierSpentAt: () => null,
    commitmentTimestamp: () => '0x10',
    hasCommitment: () => true,
  }),
}));

const { verifyTransferSpendability } = await import('../../transfer-spendability');
const report = await verifyTransferSpendability({
  notes: notes as never,
  chainId: 56,
  noteManager: { exportState: () => ({ notes }), importState: () => {} } as never,
  keystoreManager: { getPrivateNullifyingKey: () => '0xk' } as never,
  ownerAddress: OWNER as never,
});
const total = report.spendableNotes.reduce((s, n) => s + BigInt(n.value), 0n);
console.log(JSON.stringify({
  rejectCodes: report.rejected.flatMap((r) => r.rejectReasons.map((x) => x.code)),
  total: total.toString(),
}));
