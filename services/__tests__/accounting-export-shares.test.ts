import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
process.env.EXPO_PUBLIC_PAY_URL_BASE = 'https://pay.example.test';
process.env.EXPO_PUBLIC_TEST_MODE = 'true';

const PPUSDT = '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const { buildKoinlyCsv } = await import('@/services/accounting-export');
const { shareConversionAt } = await import('@/services/share-rate-history');
const { shareRateKey } = await import('@/services/share-rates');
const { getTokenMetadata } = await import('@/config/tokens');
type AcctItem = import('@/services/accounting-export').AcctItem;
type ShareRateSeries = import('@/services/share-rate-history').ShareRateSeries;

const E18 = 10n ** 18n;
const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400;

const series: ShareRateSeries = {
  ref: {
    chainId: 56, share: PPUSDT.toLowerCase(), underlying: '0x55d398326f99059ff775485246999027b3197955',
    shareSymbol: 'ppUSDT', shareDecimals: 18, underlyingSymbol: 'USDT', underlyingDecimals: 18,
  },
  history: [
    { block: 100n, timestampSec: T0 / 1000, assetsPerShare: E18 },
    { block: 200n, timestampSec: T0 / 1000 + 10 * DAY, assetsPerShare: E18 + 2n * 10n ** 15n },
  ],
  current: { block: 300n, timestampSec: T0 / 1000 + 20 * DAY, assetsPerShare: E18 + 4n * 10n ** 15n },
};

const item = (over: Partial<AcctItem>): AcctItem => ({
  txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  type: 'deposit', bundles: null, value: (10n * E18).toString(), tokenId: PPUSDT, chainId: 56,
  timestamp: T0 + 10 * DAY * 1000, counterparty: null, label: null, ...over,
});

const baseDeps = {
  notes: [],
  findFee: (txHash: string) => (txHash.startsWith('0x2222') ? { feeAmount: (E18 / 10n).toString() } : null),
  buildOriginProof: (async () => null) as never,
};
// Production keys the book by share address only, so a non-share item gets null.
const withRates = (s: ShareRateSeries) => {
  const book = new Map([[shareRateKey(s.ref.chainId, s.ref.share), s]]);
  return {
    ...baseDeps,
    shareConversion: (it: AcctItem) => {
      const found = book.get(shareRateKey(it.chainId, it.tokenId));
      return found ? shareConversionAt(found, { timestampSec: it.timestamp / 1000 }) : null;
    },
  };
};

const cols = (csv: string, row = 1) => csv.split('\n')[row].split(',').slice(1, 7);

describe('Koinly rows for share assets', () => {
  test('a deposit is written in the underlying at the time of the transaction', async () => {
    const csv = await buildKoinlyCsv([item({})], withRates(series));
    expect(cols(csv)).toEqual(['', '', '10.02', 'USDT', '', '']);
  });

  test('a withdrawal splits gross and fee in the underlying', async () => {
    const csv = await buildKoinlyCsv([item({ type: 'withdraw', txHash: `0x${'2'.repeat(64)}` })], withRates(series));
    expect(cols(csv)).toEqual(['9.9198', 'USDT', '', '', '0.1002', 'USDT']);
  });

  test('a standalone fee uses the underlying in the Fee columns', async () => {
    const csv = await buildKoinlyCsv([item({ type: 'fee', value: (E18 / 2n).toString() })], withRates(series));
    expect(cols(csv)).toEqual(['', '', '', '', '0.501', 'USDT']);
  });

  test('keeps share amounts and symbols when only a current rate is readable', async () => {
    const csv = await buildKoinlyCsv([item({ type: 'transfer-out' })], withRates({ ...series, history: [] }));
    expect(cols(csv)).toEqual(['10', getTokenMetadata(PPUSDT, 56).symbol, '', '', '', '']);
  });

  const shareSymbol = getTokenMetadata(PPUSDT, 56).symbol;
  const currentOnlyRows: { type: AcctItem['type']; expected: string[] }[] = [
    { type: 'deposit', expected: ['', '', '10', shareSymbol, '', ''] },
    { type: 'transfer-in', expected: ['', '', '10', shareSymbol, '', ''] },
    { type: 'transfer-out', expected: ['10', shareSymbol, '', '', '0.1', shareSymbol] },
    { type: 'withdraw', expected: ['9.9', shareSymbol, '', '', '0.1', shareSymbol] },
    { type: 'fee', expected: ['', '', '', '', '10', shareSymbol] },
    { type: 'exit', expected: ['10', shareSymbol, '', '', '', ''] },
  ];
  for (const { type, expected } of currentOnlyRows) {
    test(`a current-only ${type} retains share units and symbols in every amount column`, async () => {
      const it = item({ type, txHash: `0x${'2'.repeat(64)}` });
      const deps = withRates({ ...series, history: [] });
      expect(deps.shareConversion(it)?.atTx).toBe(false);
      const csv = await buildKoinlyCsv([it], deps);
      expect(cols(csv)).toEqual(expected);
    });
  }

  for (const { side, timestamp } of [
    { side: 'before', timestamp: (series.history[0].timestampSec - 1) * 1000 },
    { side: 'after', timestamp: (series.current!.timestampSec + 1) * 1000 },
  ]) {
    test(`a deposit ${side} historical coverage retains its share amount and symbol`, async () => {
      const it = item({ timestamp });
      const deps = withRates(series);
      expect(deps.shareConversion(it)?.atTx).toBe(false);
      expect(cols(await buildKoinlyCsv([it], deps))).toEqual(['', '', '10', shareSymbol, '', '']);
    });

    test(`a withdrawal ${side} historical coverage retains share units for net and fee`, async () => {
      const it = item({ type: 'withdraw', timestamp, txHash: `0x${'2'.repeat(64)}` });
      const deps = withRates(series);
      expect(deps.shareConversion(it)?.atTx).toBe(false);
      expect(cols(await buildKoinlyCsv([it], deps))).toEqual(['9.9', shareSymbol, '', '', '0.1', shareSymbol]);
    });
  }

  test('with no rate at all the share count keeps its own symbol', async () => {
    const csv = await buildKoinlyCsv([item({})], { ...baseDeps, shareConversion: () => null });
    expect(cols(csv)).toEqual(['', '', '10', getTokenMetadata(PPUSDT, 56).symbol, '', '']);
  });

  test('a non-share row is unchanged by the conversion dependency', async () => {
    const eth = item({ tokenId: ETH, chainId: 11155111, type: 'withdraw', txHash: `0x${'2'.repeat(64)}` });
    const plain = await buildKoinlyCsv([eth], baseDeps);
    const converted = await buildKoinlyCsv([eth], withRates(series));
    expect(converted).toBe(plain);
    expect(cols(plain)).toEqual(['9.9', 'ETH', '', '', '0.1', 'ETH']);
  });
});
