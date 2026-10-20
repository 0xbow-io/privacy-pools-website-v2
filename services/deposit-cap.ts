/**
 * The per-deposit USD cap for the prod launch ($100, Ameen 2026-09-03: "UI &
 * ASP enforced"). The ASP refuses larger deposits on its side; this is the UI
 * half, so a user hears about the limit before paying gas for a deposit that
 * would be rejected.
 *
 * Every path that creates a pool deposit consults it (codex review of d60b2c4
 * found two that did not): the deposit modal's typed amount, a wallet-funded
 * payment request (the link carries its own amount), and a swap reshield,
 * which redeposits the swap output as a fresh note.
 *
 * PURE module: the price is injected, so the rule is unit-testable.
 */
import { isStablecoin } from '@/services/token-format';

/**
 * Parse an `EXPO_PUBLIC_MAX_DEPOSIT_USD` style override. Unset or garbage keeps
 * the environment's default; `off`, `none` or any decimal spelling of zero
 * disables the cap outright.
 */
export function parseDepositCapUsd(raw: string | undefined | null, fallback: number | undefined): number | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (trimmed === 'off' || trimmed === 'none') return undefined;
  // Strict decimal only: "0x64", "1e2" and friends are not an operator's
  // intent for a dollar figure, so they fall back rather than surprise.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (n === 0) return undefined;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type DepositCapVerdict =
  | { ok: true }
  | { ok: false; reason: 'over' | 'no-price' | 'pending' | 'invalid'; message: string };

/**
 * Largest token amount that stays at or under the cap, FLOORED at the display
 * precision so the figure we recommend is never itself over the cap
 * (rounding to nearest recommended 0.0351 ETH at $2,850, which is $100.04).
 */
export function formatCapMaxTokens(capUsd: number, price: number): string {
  const max = capUsd / price;
  if (!Number.isFinite(max) || max <= 0) return '0';
  if (max >= 1) return (Math.floor(max * 100) / 100).toFixed(2);
  const exponent = Math.floor(Math.log10(max));
  const fractionDigits = Math.max(0, 2 - exponent); // three significant digits
  const factor = 10 ** fractionDigits;
  return (Math.floor(max * factor) / factor).toFixed(fractionDigits);
}

/**
 * Check one deposit against the cap. Stablecoins are taken at $1 when no price
 * is known; any other asset with no price FAILS CLOSED, because "cap enforced"
 * cannot mean "unless the price feed blinked", and the ASP would refuse the
 * deposit anyway. `pricePending` distinguishes a fetch still in flight (a
 * quiet "checking" state) from a feed that has answered with nothing.
 */
export function checkDepositCap(input: {
  amount: number;
  symbol: string;
  priceUsd: number | null | undefined;
  capUsd: number | undefined;
  pricePending?: boolean;
}): DepositCapVerdict {
  const { amount, symbol, capUsd } = input;
  if (capUsd === undefined) return { ok: true };
  if (!Number.isFinite(amount)) return { ok: false, reason: 'invalid', message: 'Enter a valid amount.' };
  if (amount <= 0) return { ok: true };
  const price = input.priceUsd && Number.isFinite(input.priceUsd) && input.priceUsd > 0
    ? input.priceUsd
    : isStablecoin(symbol) ? 1 : null;
  if (price === null) {
    if (input.pricePending) {
      return { ok: false, reason: 'pending', message: `Checking the $${capUsd} launch limit…` };
    }
    return {
      ok: false,
      reason: 'no-price',
      message: `Can't check the $${capUsd} launch limit right now (no ${symbol} price). Try again shortly.`,
    };
  }
  if (amount * price <= capUsd) return { ok: true };
  return {
    ok: false,
    reason: 'over',
    message: `Launch limit is $${capUsd} per deposit (about ${formatCapMaxTokens(capUsd, price)} ${symbol}).`,
  };
}

export class DepositCapError extends Error {
  readonly reason: Exclude<DepositCapVerdict, { ok: true }>['reason'];
  constructor(verdict: Exclude<DepositCapVerdict, { ok: true }>) {
    super(verdict.message);
    this.name = 'DepositCapError';
    this.reason = verdict.reason;
  }
}

/**
 * Async form for flows that hold a base-unit amount and no price yet (payment
 * requests, swap reshields). Fetches the price only when a cap is configured,
 * so uncapped environments make no network call. Throws DepositCapError.
 */
export async function assertDepositCap(input: {
  amountWei: bigint;
  decimals: number;
  symbol: string;
  capUsd: number | undefined;
  fetchPrice: (symbol: string) => Promise<number>;
}): Promise<void> {
  if (input.capUsd === undefined) return;
  const amount = Number(input.amountWei) / 10 ** input.decimals;
  let priceUsd: number | null = null;
  if (!isStablecoin(input.symbol)) {
    try {
      priceUsd = await input.fetchPrice(input.symbol);
    } catch {
      priceUsd = null; // fails closed below
    }
  }
  const verdict = checkDepositCap({ amount, symbol: input.symbol, priceUsd, capUsd: input.capUsd });
  if (!verdict.ok) throw new DepositCapError(verdict);
}

/** Floor to two significant digits, so a preset never lands over the cap. */
function floorTwoSignificant(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '0';
  const exponent = Math.floor(Math.log10(x));
  const fractionDigits = Math.max(0, 1 - exponent);
  const factor = 10 ** fractionDigits;
  return (Math.floor(x * factor) / factor).toFixed(fractionDigits);
}

/**
 * Quick-amount presets that respect the cap: 10%, 25%, 50% and 100% of the
 * largest depositable amount at today's price (10 · 25 · 50 · 100 for a
 * stablecoin under a $100 cap). Without a cap, or while the price is unknown
 * for a non-stablecoin, the caller's defaults stand; the cap check itself
 * still refuses anything over.
 */
export function cappedQuickAmounts(input: {
  capUsd: number | undefined;
  priceUsd: number | null | undefined;
  symbol: string;
  fallback: string[];
}): string[] {
  const { capUsd, symbol, fallback } = input;
  if (capUsd === undefined) return fallback;
  const price = input.priceUsd && Number.isFinite(input.priceUsd) && input.priceUsd > 0
    ? input.priceUsd
    : isStablecoin(symbol) ? 1 : null;
  if (price === null) return fallback;
  const max = capUsd / price;
  const out: string[] = [];
  for (const fraction of [0.1, 0.25, 0.5, 1]) {
    const v = floorTwoSignificant(max * fraction);
    if (Number(v) > 0 && !out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : fallback;
}
