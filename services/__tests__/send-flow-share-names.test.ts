/**
 * Send flow (QA 2026-10-24, prod): a share's own name flashed during a private
 * Send ("Processing Transfer", amount "0.101 ETH"). Shares read as their coin
 * everywhere the Send flow, its receipts, the activity row that follows, the
 * payment-request pay flow and the claim link render, with or without a live
 * rate. While the rate loads a share count reads "0.1 ETH shares".
 *
 * The share list comes from CONFIG (every environment's token registry), and
 * every builder below is RUN for each share, with and without a rate. The
 * companion guards: share-symbol-render-guard.test.ts (a raw `.symbol` in a
 * render) and, once DEV-591 lands, share-name-render-guard.test.ts (literal
 * share names in UI source, the Swap tab).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits } from 'viem';

import { ENVIRONMENTS } from '@/config/environments';
import { buildTransitionEvent, type TransitionTx } from '@/services/notification-transitions';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { shareBalanceDisplay, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import {
  displayTokenSymbol, isShareSymbol, shareCountLabel, shareFreeText, shareUnitLabel, tokenAmountLabel, underlyingOnlyView,
} from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { translateSdkTransactError } from '@/services/transfer-outcome';

// Bun.Transpiler is not in the app's type declarations, so the typecheck gate would reject a direct use.
type BunGlobal = { Bun: { Transpiler: new (options: { loader: 'ts' }) => { transformSync(source: string): string } } };

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

type Share = { symbol: string; decimals: number };

/** Every share any environment ships, read from the token registries. */
const CONFIG_SHARES: Share[] = (() => {
  const seen = new Map<string, Share>();
  for (const env of Object.values(ENVIRONMENTS)) {
    for (const tokens of Object.values(env.tokensByChain)) {
      for (const meta of Object.values(tokens)) {
        if (meta.yieldShare) seen.set(meta.symbol, { symbol: meta.symbol, decimals: meta.decimals });
      }
    }
  }
  return [...seen.values()];
})();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHARE_NAME = new RegExp(`\\b(?:${CONFIG_SHARES.map((s) => escape(s.symbol)).join('|')})\\b`, 'i');

function rateFor(share: Share): ShareRate {
  const coin = displayTokenSymbol(share.symbol);
  const underlyingDecimals = coin === 'ETH' ? 18 : 6;
  return {
    chainId: 1,
    share: '0x0000000000000000000000000000000000000001',
    underlying: '0x0000000000000000000000000000000000000002',
    shareSymbol: share.symbol,
    shareDecimals: share.decimals,
    // 1 share = 1.0007 underlying.
    assetsPerShare: 10_007n * 10n ** BigInt(underlyingDecimals) / 10_000n,
    underlyingSymbol: coin === 'ETH' ? 'WETH' : coin,
    underlyingDecimals,
  };
}

/** Load a hook file with its imports replaced by `deps`, and return its exports by name. */
function loadHooks(file: string, deps: Record<string, unknown>, names: string[]): Record<string, (...args: never[]) => unknown> {
  const source = read(file).replace(/^import [\s\S]*?;$/gm, '').replace(/export function/g, 'function');
  const body = new (globalThis as unknown as BunGlobal).Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  return new Function(...Object.keys(deps), `${body}; return { ${names.join(', ')} };`)(...Object.values(deps));
}

/** The REAL useShareFreeBalanceDisplay (hooks/use-balance-display.ts), fed a rate or none. */
function shareFreeDisplay(rate: ShareRate | undefined) {
  const hooks = loadHooks('hooks/use-balance-display.ts', {
    useCallback: (fn: unknown) => fn,
    useShareRates: () => ({ rateFor: () => rate }),
    useAllChainsPriceMap: () => ({}),
    getTokenMetadataBySymbol: () => ({ address: rate?.share ?? '0x01' }),
    isShareSymbol, underlyingOnlyView, shareBalanceDisplay,
  }, ['useBalanceDisplay', 'useShareFreeBalanceDisplay']);
  return (hooks.useShareFreeBalanceDisplay as (chainId?: number) => (exact: string | number, symbol: string, chainId: number | undefined, address?: string) => ReturnType<typeof shareBalanceDisplay>)(1);
}

/** The REAL useShareAmountField (the Send amount field), rendered once with a rate or none. */
function amountFieldSymbol(share: Share, rate: ShareRate | undefined): string {
  const hooks = loadHooks('hooks/use-share-amount-field.ts', {
    useState: (initial: unknown) => [initial, () => {}],
    useEffect: () => {},
    useShareRates: () => ({ rateFor: () => rate }),
    useAllChainsPriceMap: () => ({}),
    useBalanceDisplay: () => (exact: string) => shareBalanceDisplay({ sharesExact: exact, shareSymbol: share.symbol, rate, priceMap: {}, fallbackPrice: 0 }),
    getTokenMetadataBySymbol: () => ({ address: '0x01' }),
    formatUnits, shareAmountFromUnderlying, shareRateSnapshotKey, shareUsdDisplayExact,
    parseTokenAmount, sanitizeAmountInput, displayTokenSymbol, isShareSymbol, shareUnitLabel,
  }, ['useShareAmountField']);
  const field = (hooks.useShareAmountField as (args: object) => { symbol: string })({
    amount: '0.1', symbol: share.symbol, chainId: 1, maxSharesExact: '1', capKnown: true, onAmountResolved: () => {},
  });
  return field.symbol;
}

describe('the share list comes from config', () => {
  test('config ships shares, and every one is known to the display rules', () => {
    expect(CONFIG_SHARES.length).toBeGreaterThan(0);
    for (const { symbol } of CONFIG_SHARES) {
      expect(isShareSymbol(symbol)).toBe(true);
      expect(displayTokenSymbol(symbol)).not.toMatch(SHARE_NAME);
      // shareFreeText's pattern is built from the same table: it must see this share.
      expect(shareFreeText(`1 ${symbol}`)).not.toMatch(SHARE_NAME);
    }
  });
});

describe('what the Send flow renders never names a share', () => {
  for (const share of CONFIG_SHARES) {
    const coin = displayTokenSymbol(share.symbol);
    for (const rate of [undefined, rateFor(share)]) {
      const label = `${share.symbol}, ${rate ? 'rate known' : 'rate loading'}`;
      const display = shareFreeDisplay(rate);
      const text = (exact: string) => display(exact, share.symbol, 1).text;

      test(`${label}: the Processing / success amount and the receipts`, () => {
        for (const exact of ['0', '0.000001', '0.1', '0.10098', '12.5']) {
          const view = display(exact, share.symbol, 1);
          // transferAmountFormatted ("~" in send-exact mode), settled amount,
          // the claim link amount, the activity row and the notification row.
          for (const shown of [view.text, `~${view.text}`, view.hint ?? '', view.symbol]) expect(shown).not.toMatch(SHARE_NAME);
          if (!rate && exact !== '0') expect(view.text.endsWith(`${coin} shares`)).toBe(true);
          if (rate) expect(view.converted).toBe(true);
        }
        // Numbers (activity rows pass tokenAmount as a number).
        expect(display(0.10098, share.symbol, 1).text).not.toMatch(SHARE_NAME);
      });

      test(`${label}: amount errors, the way the validation memo builds them`, () => {
        // The memo stays in shares (tokenAmountLabel / the share's own name);
        // displayAmountError and reportTransferError rewrite at the boundary.
        const built = [
          `Maximum sendable in one transfer is ${tokenAmountLabel('0.5', share.symbol)}`,
          `Exceeds your shielded balance of ${tokenAmountLabel('0.5', share.symbol)}`,
          `Insufficient selected balance (${tokenAmountLabel('0.25', share.symbol)} selected)`,
          `Amount plus the relayer fee (~0.0001 ${share.symbol}) exceeds what one transfer can send. Send at most ${tokenAmountLabel('0.4999', share.symbol)}, or uncheck "Recipient receives the exact amount".`,
          `Send at least a little more than the relayer fee (~0.0001 ${share.symbol}), or the recipient gets nothing`,
          // SDK / relayer errors carry their own units.
          `Insufficient ${share.symbol} balance: need 1,000.5 ${share.symbol}, have ≈ 2 ${share.symbol.toUpperCase()}`,
        ];
        for (const message of built) {
          expect(message).toMatch(SHARE_NAME);
          const shown = shareFreeText(message, text);
          expect(shown).not.toMatch(SHARE_NAME);
          expect(shown).toContain(coin);
          if (!rate) expect(shown).toContain(`${coin} shares`);
        }
      });

      test(`${label}: the amount field unit`, () => {
        const unit = amountFieldSymbol(share, rate);
        expect(unit).not.toMatch(SHARE_NAME);
        expect(unit).toBe(rate ? coin : `${coin} shares`);
      });

      test(`${label}: the notification and toast for a transfer`, () => {
        const tx: TransitionTx = { id: 't', type: 'Transfer', status: 'completed', tokenAmount: 0.10098, asset: share.symbol, timestamp: 1 };
        for (const event of [buildTransitionEvent(tx), buildTransitionEvent(tx, (t) => display(t.tokenAmount, t.asset, 1).text)]) {
          expect(event.title).not.toMatch(SHARE_NAME);
          expect(event.description).not.toMatch(SHARE_NAME);
        }
      });
    }

    test(`${share.symbol}: a payment shortfall from the SDK`, () => {
      const unit = 10n ** BigInt(share.decimals);
      const msg = translateSdkTransactError(
        `Insufficient value for transact: available=0x${(unit / 2n).toString(16)}, requested=0x${unit.toString(16)}`,
        share,
      );
      expect(msg).not.toBeNull();
      expect(msg!).not.toMatch(SHARE_NAME);
      expect(msg!).toContain(`${coin} shares`);
    });

    test(`${share.symbol}: request labels and counts`, () => {
      expect(shareUnitLabel(share.symbol)).toBe(`${coin} shares`);
      expect(shareCountLabel('0.01', share.symbol)).toBe(`0.01 ${coin} shares`);
      expect(shareFreeText(`Received payment imported as 0.5 ${share.symbol}.`)).toBe(`Received payment imported as 0.5 ${coin} shares.`);
    });
  }

  test('plain tokens pass through untouched', () => {
    expect(shareFreeText('Send at most 1.5 USDC')).toBe('Send at most 1.5 USDC');
    expect(shareUnitLabel('USDC')).toBe('USDC');
    expect(shareCountLabel('1.5', 'USDC')).toBe('1.5 USDC');
    expect(shareFreeDisplay(undefined)('1.5', 'USDC', 1).text).toBe('1.50 USDC');
  });
});

/** Files that render the Send flow and what follows it. */
const SEND_SURFACES = [
  'components/transfer-modal-provider.tsx',
  'components/consolidation-panel.tsx',
  'components/payment-request-modal-provider.tsx',
  'components/payment-requests-card.tsx',
  'components/home/latest-activity.tsx',
  'components/ui/notification-center.tsx',
  'components/pools/transactions.tsx',
  'app/receive/[encoded].tsx',
];
/** These keep the share's own symbol when no rate is known, by design. */
const SHARE_FALLBACK_HELPERS = /\b(?:approxUnderlyingText|shareAmountText|shareReviewHeadline|useBalanceDisplay)\(/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

describe('Send surfaces only use the share-free display rules', () => {
  test('balances go through useShareFreeBalanceDisplay, never a share-name fallback', () => {
    const offenders: string[] = [];
    for (const file of SEND_SURFACES) {
      const src = stripComments(read(file));
      expect(src).toContain('useShareFreeBalanceDisplay(');
      src.split('\n').forEach((line, i) => {
        if (SHARE_FALLBACK_HELPERS.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('transfer errors and toasts are rewritten before anyone reads them', () => {
    const src = stripComments(read('components/transfer-modal-provider.tsx'));
    expect(src).toContain('const shown = msg == null ? msg : shareFreeText(msg,');
    expect(src).toContain('setTransferError(shown);');
    expect(src).toContain("errorToast({ title: shown, variant: 'destructive' })");
    expect(src).toContain('shareFreeText(amountError,');
    // The raw memo is never a JSX child; displayAmountError is.
    expect(src).not.toMatch(/>\s*\{amountError\}/);
  });

  test('status lines: the progress message and the payment-request rail', () => {
    expect(stripComments(read('components/ui/flow-progress.tsx'))).toContain('{shareFreeText(message)}');
    const pr = stripComments(read('components/payment-request-modal-provider.tsx'));
    for (const name of ['statusMessage', 'warningMessage', 'errorMessage']) expect(pr).toContain(`{shareFreeText(${name})}`);
    expect(pr).toContain('Amount ({shareUnitLabel(requestTokenSymbol)})');
  });

  test('the deposit toast uses the share-free view', () => {
    expect(read('components/status-notifier.tsx')).toContain('underlyingOnlyView(balanceDisplay(tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress), tx.asset)');
  });
});
