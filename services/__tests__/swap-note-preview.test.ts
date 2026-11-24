import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXECUTOR_STABLE_SYMBOLS, estimateReshieldFee, estimateSwapNote } from '../swap-note-preview';
import { readSwapPreviewConfigs } from '../swap-preview-config';

const config = { enabled: true, vettingFeeBps: 0n, maxRelayFee: 0n, relayerFlatFee: 21_000n };

describe('local shielded note preview', () => {
  test('executor stable symbols match the installed SDK', () => {
    const sdk = readFileSync(require.resolve('@privacy-pools-v2/sdk'), 'utf8');
    const table = /STABLE_TOKEN_SYMBOLS = .*?new Set\(\[([^\]]+)\]\)/.exec(sdk);
    expect(table).toBeTruthy();
    const symbols = [...table![1].matchAll(/"([^"]+)"/g)].map(match => JSON.parse(match[0]));
    expect([...EXECUTOR_STABLE_SYMBOLS].sort()).toEqual(symbols.sort());
  });

  test('fee uses public gas and asset prices, then the published fee terms', () => {
    const input = { gross: 1000_000_000n, gasPrice: 1_000_000_000n, nativeUsd: 2000, tokenUsd: 1, decimals: 6, shareInput: false, crossChain: false, config };
    expect(estimateReshieldFee(input)).toBe(4_061_000n);
    expect(estimateReshieldFee({ ...input, config: { ...config, relayerFeeBps: 10n } })).toBe(5_040_000n);
    expect(estimateReshieldFee({ ...input, config: { ...config, maxRelayFee: 3_000_000n } })).toBeNull();
    expect(estimateReshieldFee({ ...input, gross: 4_061_000n })).toBeNull();
    expect(estimateReshieldFee({ ...input, gasPrice: null })).toBeNull();
    expect(estimateReshieldFee({ ...input, config: { ...config, relayerFlatFee: undefined } })).toBeNull();
  });

  test('plain note applies sizing and vetting, not just the route output', () => {
    expect(estimateSwapNote({ minimumOutput: 1000_000_000n, crossChain: false, destinationChainId: 10, config: { ...config, vettingFeeBps: 100n } })).toBe(980_198_019n);
  });

  test('yield preview converts the executor deposit budget at the cached share rate', () => {
    const input = { minimumOutput: 991_695_584n, executorPair: 'stable' as const, crossChain: false, destinationChainId: 1, config };
    const rate = { assetsPerShare: 1_006_912n, shareDecimals: 18 };
    const budget = estimateSwapNote(input)!;
    const shares = estimateSwapNote({ ...input, share: rate })!;
    const underlying = shares * rate.assetsPerShare / 10n ** 18n;
    const headroom = (budget + 999_999n) / 1_000_000n;
    expect(underlying).toBe(budget - headroom - 3n); // Two zap-buffer units and one from rate inversion.
  });

  test('cross-chain accounts for destination reserve and yield rate headroom', () => {
    const input = { minimumOutput: 1000_000_000n, crossChain: true, destinationChainId: 1, config };
    expect(estimateSwapNote(input)).toBe(950_600_000n);
    const shares = estimateSwapNote({ ...input, share: { assetsPerShare: 1_000_000n, shareDecimals: 18 } })!;
    expect(shares / 10n ** 12n).toBe(950_124_698n);
    expect(estimateSwapNote({ ...input, config: undefined })).toBeNull();
    expect(estimateSwapNote({ ...input, config: { ...config, enabled: false } })).toBeNull();
  });

  test('failed or stale public inputs do not masquerade as zero fees', () => {
    expect(readSwapPreviewConfigs({ status: 'ready', data: {}, at: 0 }, 600_000)).toBeNull();
    expect(readSwapPreviewConfigs({ status: 'ready', data: {}, at: 0 }, 599_999)).toEqual({});
  });
});
