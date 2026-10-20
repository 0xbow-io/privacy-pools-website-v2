import { describe, expect, mock, test } from 'bun:test';

// The row builder reads token and chain metadata (config/tokens pulls
// react-native at load); stub the one RN symbol and pin the env.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const { reconstructUserSpends } = await import('@/services/outgoing-transfers');
const { buildUserSpendRow } = await import('@/services/activity-rows');
const { rowTypeLabel } = await import('@/services/row-type-label');
const { consolidationHeadline } = await import('@/services/self-transfer-row');

type Hex = import('@/services/sdk-types').Hex;
type Secret = import('@/services/sdk-types').Secret;
type SnapshotTransact = import('@/services/api-types').SnapshotTransact;

const BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SIGNER = '0x9e2f1B234953F46c6091636290E9035618EA3C07';
const KEY = '0x0abc' as Secret;
const isTransferRouteCaller = (caller: string | null | undefined, chainId: number | undefined) =>
  chainId === 56 && caller?.toLowerCase() === SIGNER.toLowerCase();

// Transacted logs decoded from BNB Chain. The commitments a log spent are not
// on chain (only their nullifiers are), so each input note gets a stand-in
// commitment and the hash service maps it to the log's real nullifier.
type DecodedLog = { txHash: string; nullifierHashes: string[]; outputCommitments: string[]; withdrawnValue: string };

const SELF_TRANSFER_0XB792: DecodedLog = {
  txHash: '0xb792a51d8fab75efe06240e6629c2152c6da9804fb9467ff08f5edd43665e8fb',
  nullifierHashes: ['0x064c9ee2780f687b25626a175e1fdb440eb5ba028a4075386d5964547f8f911f'],
  outputCommitments: [
    '0x153eb3bcf0fcc98e8140ff0f68d655c258d078ef140406c7af037c8cd27ed89e',
    '0x10c8105f4eaa84b152c2d8aacaedb6e518d9b28ddca5c41bdea46321a336b5fe',
  ],
  withdrawnValue: '42500000021000',
};

const CONSOLIDATION_0X20A8: DecodedLog = {
  txHash: '0x20a869c4746dc95b174bff4c6c8f21a325c5725755c0c90a4e999a97c7019a7c',
  nullifierHashes: [
    '0x2da9449a741adabff3a3d910df805b25ddad0ffb46351c5d16dbf55538b7e0cb',
    '0x0edeca7c3c36a2ef0af6e027fa13ae4179a15aa51e5b74d6144dbcade0f191d2',
    '0x23aec0a11c547ae5578580fec360895b8a2de74ed4ef58ec3e049a2446f05288',
  ],
  outputCommitments: ['0x0ab3da1dbbb06c1aa1059b2df5a5a67fd7e372e745df0e3fff8a3399fe9a117f'],
  withdrawnValue: '42500000021000',
};

const CONSOLIDATION_0XC0D6: DecodedLog = {
  txHash: '0xc0d61d660f1615d03b4d8f046e3c0a80c4f87d7c3d86e440531ecc6630123ceb',
  nullifierHashes: [
    '0x079fe890d7df2bd2e4bce4ca8289f774d4b2ca6c0c856395d01e0a574b0e034b',
    '0x18ee3143dafcf6bc2d34dc7da196f64c22a7585b4fbbf6ee51f204d61611ba4a',
    '0x089aa28fbb7166e42ff89cfdee815d76f78283a3fc6936db44b0a23ee6abf4bb',
    '0x0f2f10c000e03484531ce0cf8efc851c8f73aa1b84f10fc96d8567e2ca6e0589',
    '0x273ff2fe201afa28f2dfe487fef7f06802419e6aa7b06474a1bb371348fc714e',
  ],
  outputCommitments: [
    '0x304e696ea970b6e9ec1b8f2695af3be62e46b01fa1f3706de7b9a1c996da7178',
    '0x02edd8a610bdadcb9f85f411d31a34911a0b40f46b0bb7238a3bcabc6c183d54',
  ],
  withdrawnValue: '42500000021000',
};

/** The row the activity feed shows for `log`, spending `inputs` and creating `outputs` (in log order). */
function rowFor(log: DecodedLog, inputs: { value: bigint; label: string }[], outputs: { value: bigint; label: string }[]) {
  const standIn = (i: number) => `0x${(0xa000 + i).toString(16).padStart(64, '0')}`;
  const nullifierByCommitment = new Map(log.nullifierHashes.map((nf, i) => [standIn(i), nf]));
  const hashService = { hash: ([, commitment]: Hex[]) => (nullifierByCommitment.get(commitment) ?? '0x0') as Hex };
  const notes = [
    ...inputs.map((n, i) => ({ commitment: standIn(i) as Hex, value: `0x${n.value.toString(16)}` as Hex, tokenId: BNB as Hex, label: n.label as Hex })),
    ...outputs.map((n, i) => ({ commitment: log.outputCommitments[i] as Hex, value: `0x${n.value.toString(16)}` as Hex, tokenId: BNB as Hex, label: n.label as Hex, txHash: log.txHash as Hex })),
  ];
  const transact: SnapshotTransact & { chainId: number } = {
    ...log,
    logIndex: 0,
    caller: SIGNER,
    encryptedPayload: null,
    blockNumber: '1',
    blockTimestamp: '1791300000',
    asset: BNB,
    chainId: 56,
  };
  const [spend] = reconstructUserSpends(notes, [transact], KEY, hashService, { isTransferRouteCaller });
  expect(spend.kind).toBe('fee');
  return buildUserSpendRow(spend, 56, {});
}

describe('a self-transfer row is a consolidation only in the Consolidate action\'s shape', () => {
  test('a one-note self-transfer reads Self-transfer with no note counts', () => {
    // 0xb792a5…65e8fb: one note in, two owned outputs (the self-recipient note
    // and the SDK's zero-value change), the relayer's fee as withdrawnValue.
    // It used to show "Notes: 1 note → 2 notes".
    const fee = BigInt(SELF_TRANSFER_0XB792.withdrawnValue);
    const net = 1719990000000000n;
    const row = rowFor(SELF_TRANSFER_0XB792, [{ value: net + fee, label: '0xaa' }], [{ value: 0n, label: '0xaa' }, { value: net, label: '0xaa' }]);
    expect(rowTypeLabel(row)).toBe('Self-transfer');
    expect(row.noteCounts).toBeUndefined();
    expect(consolidationHeadline(row)).toBeNull();
    expect(row.movedAmountRaw).toBe(net.toString());
  });

  test('a send to my own address that sweeps three notes of one deposit is a self-transfer, not a consolidation', () => {
    // No such tx on chain; shaped like 0xb792a5 (same route and fee) with three
    // notes of one deposit in: the recipient note plus the deposit's change
    // note out. Fewer notes out than in, which used to read
    // "Consolidation · 3 notes → 2 notes".
    const fee = BigInt(SELF_TRANSFER_0XB792.withdrawnValue);
    const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    const log: DecodedLog = { txHash: h(0x5e1f), nullifierHashes: [h(1), h(2), h(3)], outputCommitments: [h(4), h(5)], withdrawnValue: `${fee}` };
    const row = rowFor(
      log,
      [1n, 2n, 3n].map((v) => ({ value: v * 10n ** 15n, label: '0xaa' })),
      [{ value: 10n ** 15n, label: '0xaa' }, { value: 5n * 10n ** 15n - fee, label: '0xaa' }],
    );
    expect(rowTypeLabel(row)).toBe('Self-transfer');
    expect(consolidationHeadline(row)).toBeNull();
  });

  test('a consolidation of one deposit reads 3 notes → 1 note', () => {
    const fee = BigInt(CONSOLIDATION_0X20A8.withdrawnValue);
    const row = rowFor(
      CONSOLIDATION_0X20A8,
      [1n, 2n, 3n].map((v) => ({ value: v * 10n ** 15n, label: '0xaa' })),
      [{ value: 6n * 10n ** 15n - fee, label: '0xaa' }],
    );
    expect(rowTypeLabel(row)).toBe('Consolidation');
    expect(consolidationHeadline(row)).toBe('3 notes → 1 note');
  });

  test('a consolidation of two deposits keeps one note each and reads 5 notes → 2 notes', () => {
    const fee = BigInt(CONSOLIDATION_0XC0D6.withdrawnValue);
    const row = rowFor(
      CONSOLIDATION_0XC0D6,
      ['0xaa', '0xaa', '0xaa', '0xbb', '0xbb'].map((label) => ({ value: 10n ** 15n, label })),
      [{ value: 3n * 10n ** 15n - fee, label: '0xaa' }, { value: 2n * 10n ** 15n, label: '0xbb' }],
    );
    expect(rowTypeLabel(row)).toBe('Consolidation');
    expect(consolidationHeadline(row)).toBe('5 notes → 2 notes');
  });
});
