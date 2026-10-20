import { describe, expect, test } from 'bun:test';
import { projectOwnOutputs } from '../swap-rows';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewInputAmount, previewIsIdentity } from '../swap-preview-input';
import { swapOutputReviewStatus } from '../funds-state';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('swap preview input', () => {
  test('a plain token passes through unchanged', () => {
    expect(previewInputAmount(5_000_000n, false, undefined)).toBe(5_000_000n);
  });

  test('a share is quoted as the underlying it redeems to', () => {
    // 10 ppUSDC (18 decimals) at 1.0017 USDC (6 decimals) per share.
    const rate = { assetsPerShare: 1_001_700n, shareDecimals: 18 };
    expect(previewInputAmount(10n * 10n ** 18n, true, rate)).toBe(10_017_000n);
  });

  test('a share with no rate yet yields no preview rather than a wrong figure', () => {
    expect(previewInputAmount(10n ** 18n, true, undefined)).toBeNull();
    expect(previewInputAmount(10n ** 18n, true, { assetsPerShare: 0n, shareDecimals: 18 })).toBeNull();
  });

  test('the same funding token on the same chain needs no quote', () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(previewIsIdentity(usdc, usdc.toLowerCase(), 1, 1)).toBe(true);
    expect(previewIsIdentity(usdc, usdc, 1, 8453)).toBe(false);
    expect(previewIsIdentity(usdc, '0xdAC17F958D2ee523a2206206994597C13D831ec7', 1, 1)).toBe(false);
  });

  test('the Swap tab prices its preview on the funding tokens, never the share addresses', () => {
    const src = readFileSync(join(ROOT, 'components/home/action-hub.tsx'), 'utf8');
    const start = src.indexOf('const swapPreview = useSwapPreview(');
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).toContain('fromToken: swapFromFunding');
    expect(block).toContain('toToken: swapToFunding');
    expect(block).toContain('fromAmountWei: swapPreviewInWei');
  });
});

describe('swap output review status', () => {
  test('a spent output was approved, whatever the feed says', () => {
    expect(swapOutputReviewStatus('SPENT', false)).toBe('approved');
  });
  test('a confirmed association-set leaf is approved', () => {
    expect(swapOutputReviewStatus('ACTIVE', true)).toBe('approved');
  });
  test('an ACTIVE note alone is not proof: own deposits turn ACTIVE before review', () => {
    expect(swapOutputReviewStatus('ACTIVE', false)).toBe('pending');
    expect(swapOutputReviewStatus('PENDING', false)).toBe('pending');
    expect(swapOutputReviewStatus(undefined, false)).toBe('pending');
  });
  test('an own output with no ASP row reads approved only when every output carries its own evidence', () => {
    const ctx = { leafReady: true, registration: 'registered' as const };
    expect(projectOwnOutputs([{ noteStatus: 'SPENT', leafConfirmed: false }], ctx)?.reviewStatus).toBe('approved');
    expect(projectOwnOutputs([{ noteStatus: 'ACTIVE', leafConfirmed: true }], ctx)?.reviewStatus).toBe('approved');
    expect(projectOwnOutputs([{ noteStatus: 'ACTIVE', leafConfirmed: true }, { noteStatus: 'ACTIVE', leafConfirmed: false }], ctx)?.reviewStatus).toBe('pending');
    expect(projectOwnOutputs([{ noteStatus: 'ACTIVE', leafConfirmed: false }], ctx)?.status).toBe('pending');
    expect(projectOwnOutputs([], ctx)).toBeNull();
    // A rejected second output keeps the row at risk.
    expect(projectOwnOutputs([{ noteStatus: 'ACTIVE', leafConfirmed: true }, { noteStatus: 'REJECTED', leafConfirmed: false }], ctx)?.funds?.state).toBe('at_risk');
  });
});
