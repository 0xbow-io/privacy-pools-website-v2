import { describe, expect, test } from 'bun:test';
import { estimateReshieldFee, estimateSwapNote } from '../swap-note-preview';
import { readSwapPreviewConfigs } from '../swap-preview-config';

const config = { enabled: true, vettingFeeBps: 0n, maxRelayFee: 0n, relayerFlatFee: 21_000n };

describe('local shielded note preview', () => {
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

  test('yield note matches captured SDK sizing to display precision using cached share rate', () => {
    // Read-only mainnet SDK estimate captured 2026-11-18; note valued at
    // 981.776827 USDC. Public rate inversion differs by <0.001 USDC.
    const rate = { assetsPerShare: 1_006_912n, shareDecimals: 18 };
    const note = estimateSwapNote({ minimumOutput: 991_695_584n, crossChain: false, destinationChainId: 1, config, share: rate })!;
    const underlying = note * rate.assetsPerShare / 10n ** 18n;
    expect(underlying / 10_000n).toBe(98_177n);
    expect(underlying - 981_776_827n).toBeLessThan(1000n);
    expect(underlying).toBeLessThan(991_695_584n);
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
