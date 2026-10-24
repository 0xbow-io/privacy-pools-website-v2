/**
 * Put SDK error messages into the units the user is looking at.
 *
 * Several SDK errors interpolate raw base units into their text:
 *
 *   "Deposit value 4765396938345822042 is below the Entrypoint minimum
 *    10000000000000000000"
 *
 * The arithmetic is right and the sentence is useless next to an amount field
 * that says 5 (QA, 2026-09-22). Since v2-monorepo#434 the SDK also attaches
 * the figures to the error itself, `err.amounts = { code, side, values }`, so
 * nothing has to be parsed back out of the prose. That is the primary path
 * here. The message-shape rules at the bottom are the fallback, for an error
 * whose fields were lost on the way (re-thrown as a plain Error across a
 * boundary, or reported as a string).
 *
 * THE UNITS ARE THE HARD PART, not the formatting. The SDK's `side` is
 * `spent | received`, and "spent" means three different assets depending on
 * the code: the note itself, the underlying LiFi's leg consumes once a share is
 * redeemed, and the underlying a vault router is funded with at the far end.
 * Those differ in symbol AND in scale (ppUSDC is 18 decimals, the USDC it
 * wraps is 6), and formatting a 6-decimal figure at 18 renders a confident
 * "0". So each code is mapped here to the side it is actually about, and the
 * SDK's side is only a fallback for a code this file does not know yet.
 *
 * A side the caller has no units for leaves the figure raw. Naming the wrong
 * asset is worse than printing base units.
 */
import { formatUnits } from 'viem';
import { FEE_COMMITMENT_EXPIRED_MESSAGE, isFeeCommitmentExpired } from '@/services/fee-commitment';
import { isNativeSwapDepositUnavailable, NATIVE_SWAP_DEPOSIT_UNAVAILABLE_TEXT } from '@/services/native-swap-executor';
import { isSwapValueOverRelayerCap, SWAP_VALUE_CAP_TEXT } from '@/services/swap-error-copy';

import { displayTokenSymbol } from '@/services/share-display';

export type ErrorAmountUnits = {
  /** Decimals of the asset the figures are denominated in. */
  decimals: number;
  /** Raw symbol; rendered through displayTokenSymbol, so a share names its underlying. */
  symbol: string;
};

/**
 * Every asset an SDK figure can be denominated in, because these messages are
 * not all about the same one.
 */
export type ErrorUnits = {
  /** The NOTE being spent. Relayer fees, amounts sent and note totals are in these. */
  input?: ErrorAmountUnits | null;
  /**
   * What the swap leg actually consumes. For a plain note this is the note. For
   * a SHARE the swap never sees the share: it is redeemed first, so LiFi's
   * figures are in the wrapper's underlying (`config/intent-swaps.swapInputUnits`).
   */
  swapInput?: ErrorAmountUnits | null;
  /** The asset the deposit lands in: the pool token, or the share for a vault. */
  output?: ErrorAmountUnits | null;
  /**
   * What a vault router is FUNDED with: the underlying behind `output` when it
   * is a share, otherwise the same as `output`. The router's quote and the
   * budget it is sized against are in these, not in the share. They print
   * identically only where the underlying happens to share the share's 18
   * decimals (USDT on BNB Chain), which is how this hid for a day.
   */
  funding?: ErrorAmountUnits | null;
};

type Side = keyof ErrorUnits;

/** The SDK's contract (v2-monorepo#434), mirrored so this module does not load the SDK bundle. */
type SdkErrorAmounts = {
  code: string;
  side: 'spent' | 'received';
  values: Record<string, bigint>;
};

/**
 * Exact, trailing zeros trimmed. For a figure that is SMALL BY NATURE, like a
 * shortfall of a few base units, where four decimals would print "less than
 * 0.0001" and hide the one number the user needs.
 */
function exact(wei: bigint, decimals: number): string {
  const text = formatUnits(wei, decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Four decimals, rounded UP. For a floor the user must reach: a minimum shown
 * truncated reads as lower than it is, so the user enters exactly that and is
 * refused again (a minimum of 10.00005 printed "10").
 */
function ceilShort(wei: bigint, decimals: number): string {
  if (decimals <= 4) return exact(wei, decimals);
  const unit = 10n ** BigInt(decimals - 4);
  const rounded = ((wei + unit - 1n) / unit) * unit;
  return short(rounded, decimals);
}

/** Trailing zeros are noise in an error. Four decimals is enough to act on. */
function short(wei: bigint, decimals: number): string {
  const exact = formatUnits(wei, decimals);
  const [whole, fraction = ''] = exact.split('.');
  const trimmed = fraction.slice(0, 4).replace(/0+$/, '');
  if (trimmed) return `${whole}.${trimmed}`;
  // A nonzero amount must never print as "0": that reads as "nothing", which is
  // the opposite of what a tiny fee or a tiny dust figure means.
  if (whole === '0' && wei !== 0n) return `less than 0.0001`;
  return whole;
}

function usable(units: ErrorAmountUnits | null | undefined): units is ErrorAmountUnits {
  return !!units && Number.isInteger(units.decimals) && units.decimals >= 0 && units.decimals <= 36;
}

/** `err.amounts`, or the first one found down the `cause` chain. */
function readErrorAmounts(err: unknown): SdkErrorAmounts | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const amounts = (current as { amounts?: unknown }).amounts as SdkErrorAmounts | undefined;
    if (
      amounts
      && typeof amounts.code === 'string'
      && (amounts.side === 'spent' || amounts.side === 'received')
      && amounts.values
      && typeof amounts.values === 'object'
      && Object.values(amounts.values).every((v) => typeof v === 'bigint')
    ) {
      return amounts;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

type Fmt = (key: string, round?: 'up') => string;
/** `a - b`, exact, in the same units. For a gap too small for `short` to show. */
type Diff = (a: string, b: string) => string;

/** A sentence needs a figure the SDK did not send. The raw message is better than a hole. */
class MissingFigure extends Error {}

/**
 * One entry per code: which asset its figures are in, and the sentence. Each
 * writes its own sentence rather than substituting in place, because readable
 * numbers change what reads naturally around them.
 */
const CODES: Record<string, { side: Side; text: (f: Fmt, has: (key: string) => boolean, diff: Diff) => string }> = {
  // A deposit minimum is the destination pool's, in the pool token or share.
  depositBelowMinimum: {
    side: 'output',
    // The minimum is a floor to reach, so it rounds up; see ceilShort.
    text: (f) => `This would deposit about ${f('value')}, below the pool's minimum of ${f('minimum', 'up')}. Try a larger amount.`,
  },
  // The router sizes shares from an underlying budget: both figures are the
  // FUNDING asset, never the share.
  invalidYieldAmount: {
    side: 'funding',
    // Quote and budget are usually a hair apart, so they print identical at
    // four decimals; the gap is what says anything (same call as the shortfall).
    text: (f, _has, diff) => `The vault quoted about ${f('quote')} against a budget of ${f('budget')}, over by ${diff('quote', 'budget')}. The rate moved while sizing. Try again.`,
  },
  yieldBudgetBelowFixedCosts: {
    side: 'funding',
    text: (f) => `About ${f('budget')} is too little to cover the vault's rate buffer. Try a larger amount.`,
  },
  // LiFi's leg: the redeemed underlying for a share, the note otherwise.
  lifiInputExceedsNet: {
    side: 'swapInput',
    // The two figures are usually a hair apart, so at four decimals they print
    // identical and "reduce the amount" reads as nonsense. The gap is the
    // actionable number, and it is stated exactly (services/swap-error-copy.ts
    // made the same call for the message-only path).
    text: (f, _has, diff) => `This route needs ${f('required')} but only ${f('available')} is left after the fee, a shortfall of ${diff('required', 'available')}. Reduce the amount slightly and try again.`,
  },
  swapInputDust: {
    side: 'swapInput',
    text: (f) => `The route would leave about ${f('dust')} unspent, more than it should. Try again for a fresh quote.`,
  },
  // Everything below is in the note being spent.
  insufficientTransactValue: {
    side: 'input',
    text: (f) => `The selected notes hold ${f('available')}, less than the ${f('requested')} requested.`,
  },
  insufficientChangeForFee: {
    side: 'input',
    text: (f) => `That would leave ${f('totalChange')}, not enough for the ${f('fee')} relayer fee. Reduce the amount.`,
  },
  relayFeeExceedsMax: {
    side: 'input',
    text: (f) => `The relayer asked for ${f('fee')}, above this pool's fee cap of ${f('maxRelayFee')}. Try again in a moment.`,
  },
  relayFeeConsumesWithdrawal: {
    side: 'input',
    text: (f) => `The relayer fee of ${f('fee')} would take all of the ${f('amount')}. Try a larger amount.`,
  },
  swapInputNonPositive: {
    side: 'input',
    text: (f) => `The relayer fee of ${f('fee')} leaves nothing to swap from ${f('amount')}. Try a larger amount.`,
  },
  infeasibleBatchFee: {
    side: 'input',
    text: (f) => `One withdrawal in this batch costs ${f('fee')} in fees against the ${f('amountOut')} it pays out. Withdraw it on its own or leave it out.`,
  },
  assetNotRelayable: {
    side: 'input',
    text: (f) => `Relaying this asset costs about ${f('relayCost')}, above its fee cap of ${f('maxRelayFee')}. It cannot be relayed right now.`,
  },
  yieldRedeemsToNothing: {
    side: 'input',
    text: (f) => `${f('shares')} redeems to nothing after fees. Try a larger amount.`,
  },
  yieldFeeExceedsAmountOut: {
    side: 'input',
    text: (f) => `The fee of ${f('fee')} is more than the ${f('amountOut')} being withdrawn. Try a larger amount.`,
  },
  commitmentFeeExceedsAmountOut: {
    side: 'input',
    text: (f) => `The relayer's fee of ${f('fee')} is more than the ${f('amountOut')} being withdrawn. Try again.`,
  },
  commitmentAmountSentMismatch: {
    side: 'input',
    // A relayer quote mismatch is jitter by nature, so the two figures print
    // identical at four decimals unless the difference is stated.
    text: (f, has, diff) => (has('expected')
      ? `The relayer's quote would send ${f('amountSent')} instead of the ${f('expected')} you reviewed, a difference of ${diff('amountSent', 'expected')}. Review again.`
      : `The relayer's quote would send ${f('amountSent')}, not what you reviewed. Review again.`),
  },
};

/** Every code this file writes a sentence for. The test compares it against the SDK's own union. */
export const KNOWN_AMOUNT_CODES: readonly string[] = Object.keys(CODES);

/**
 * The value keys a code's sentence reads: `required` on every path, `optional`
 * only where the sentence checks for the key first. For the test that compares
 * them with the keys the vendored SDK actually sends, so a renamed field fails a
 * test instead of silently falling back to the raw message.
 */
export function sentenceKeys(code: string): { required: string[]; optional: string[] } | null {
  const rule = CODES[code];
  if (!rule) return null;
  const read = (withOptional: boolean) => {
    const keys = new Set<string>();
    const f: Fmt = (key) => { keys.add(key); return ''; };
    const diff: Diff = (a, b) => { keys.add(a); keys.add(b); return ''; };
    rule.text(f, () => withOptional, diff);
    return keys;
  };
  const required = read(false);
  const all = read(true);
  return { required: [...required], optional: [...all].filter((k) => !required.has(k)) };
}

/** Where an unknown code's figures are, going by the SDK's own coarse side. */
const SDK_SIDE: Record<SdkErrorAmounts['side'], Side> = { spent: 'input', received: 'output' };

function fromStructured(amounts: SdkErrorAmounts, message: string, units: ErrorUnits): string | null {
  const rule = CODES[amounts.code];
  const side = units[rule?.side ?? SDK_SIDE[amounts.side]];
  if (!usable(side)) return null;
  const symbol = displayTokenSymbol(side.symbol);
  const fmt: Fmt = (key, round) => {
    const value = amounts.values[key];
    if (typeof value !== 'bigint') throw new MissingFigure(key);
    return `${round === 'up' ? ceilShort(value, side.decimals) : short(value, side.decimals)} ${symbol}`;
  };
  const diff: Diff = (a, b) => {
    const x = amounts.values[a];
    const y = amounts.values[b];
    if (typeof x !== 'bigint' || typeof y !== 'bigint') throw new MissingFigure(`${a}-${b}`);
    const gap = x > y ? x - y : y - x;
    return `${exact(gap, side.decimals)} ${symbol}`;
  };
  if (rule) {
    try {
      return rule.text(fmt, (key) => typeof amounts.values[key] === 'bigint', diff);
    } catch (e) {
      if (e instanceof MissingFigure) return null;
      throw e;
    }
  }
  // A code this file does not know yet: keep the SDK's wording and replace only
  // the figures it declared, so a new error still reads in human units.
  let out = message;
  for (const value of Object.values(amounts.values)) {
    const raw = value.toString();
    if (raw.length < 2) continue;
    // Not part of a longer number on either side. A trailing "." is allowed
    // unless a digit follows it, so a figure that ends the sentence is still
    // converted instead of being left raw beside converted ones.
    out = out.replace(new RegExp(`(?<![\\w.])${raw}(?!\\w|\\.\\d)`, 'g'), `${short(value, side.decimals)} ${symbol}`);
  }
  return out === message ? null : out;
}

/**
 * Message-shape fallback, for an error that reached us without its fields.
 * Anchored and exact so a commitment, a nullifier or a chain id is never
 * reformatted as if it were an amount.
 */
const RULES: readonly {
  readonly match: RegExp;
  readonly side: Side;
  readonly rewrite: (amounts: bigint[], units: ErrorAmountUnits) => string;
}[] = [
  {
    side: 'output',
    match: /^Deposit value (\d+) is below the Entrypoint minimum (\d+)$/,
    rewrite: ([value, minimum], u) => {
      const symbol = displayTokenSymbol(u.symbol);
      return `This would deposit about ${short(value, u.decimals)} ${symbol}, below the pool's minimum of ${ceilShort(minimum, u.decimals)} ${symbol}. Try a larger amount.`;
    },
  },
  {
    side: 'swapInput',
    match: /^Invalid transact params: LiFi needs (\d+) input but only (\d+) available after fee\. Reduce the amount or retry\.$/,
    rewrite: ([needed, available], u) => {
      const symbol = displayTokenSymbol(u.symbol);
      const gap = needed > available ? needed - available : available - needed;
      return `This route needs ${short(needed, u.decimals)} ${symbol} but only ${short(available, u.decimals)} ${symbol} is left after the fee, a shortfall of ${exact(gap, u.decimals)} ${symbol}. Reduce the amount slightly and try again.`;
    },
  },
  {
    side: 'funding',
    match: /^Invalid yield amount: router quote (\d+) exceeds the spendable budget (\d+): the rate or fee moved while sizing, size again$/,
    rewrite: ([quote, budget], u) => {
      const symbol = displayTokenSymbol(u.symbol);
      const over = quote > budget ? quote - budget : budget - quote;
      return `The vault quoted about ${short(quote, u.decimals)} ${symbol} against a budget of ${short(budget, u.decimals)} ${symbol}, over by ${exact(over, u.decimals)} ${symbol}. The rate moved while sizing. Try again.`;
    },
  },
  {
    side: 'input',
    match: /^Relay fee \((\d+)\) exceeds withdrawal amount \((\d+)\)\. Increase the withdrawal amount\.$/,
    rewrite: ([fee, amount], u) => {
      const symbol = displayTokenSymbol(u.symbol);
      return `The relayer fee of ${short(fee, u.decimals)} ${symbol} would take all of the ${short(amount, u.decimals)} ${symbol}. Try a larger amount.`;
    },
  },
];

/** The side a caller's units fill in when it does not name `funding` itself. */
function withDefaults(units: ErrorUnits): ErrorUnits {
  return { ...units, funding: units.funding ?? units.output ?? null };
}

/**
 * `message` with any recognised base-unit figures rendered in `units`, or
 * `message` unchanged. For callers that only have the text.
 */
export function humanizeSdkAmounts(message: string, units: ErrorUnits | null | undefined): string {
  if (!message || !units) return message;
  const all = withDefaults(units);
  const trimmed = message.trim();
  for (const rule of RULES) {
    const found = rule.match.exec(trimmed);
    if (!found) continue;
    const side = all[rule.side];
    if (!usable(side)) return message;
    try {
      return rule.rewrite(found.slice(1).map((n) => BigInt(n)), side);
    } catch {
      return message;
    }
  }
  return message;
}

/**
 * The user-facing text for any caught error. Prefer this over reading
 * `err.message` wherever the result is shown: it uses the SDK's structured
 * amounts when the error carries them, and the message rules when it does not.
 * Never throws; an error path is the worst place to add one.
 */
export function sdkErrorText(err: unknown, units: ErrorUnits | null | undefined, fallback = ''): string {
  // A rejection that is neither an Error nor a string: the caller's own
  // fallback when it gave one ("Failed to pay via private transfer." beats
  // "[object Object]"), otherwise String(err), which is what every call site
  // printed before this, so the reason is never left empty.
  const message = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : fallback || (err == null ? '' : String(err));
  try {
    if (isFeeCommitmentExpired(err)) return FEE_COMMITMENT_EXPIRED_MESSAGE;
    if (isNativeSwapDepositUnavailable(err)) return NATIVE_SWAP_DEPOSIT_UNAVAILABLE_TEXT;
    if (isSwapValueOverRelayerCap(err)) return SWAP_VALUE_CAP_TEXT;
    if (units) {
      const amounts = readErrorAmounts(err);
      if (amounts) {
        const text = fromStructured(amounts, message, withDefaults(units));
        if (text) return text;
      }
      const humanized = humanizeSdkAmounts(message, units);
      if (humanized !== message) return humanized;
    }
  } catch {
    // fall through to the raw message
  }
  return message || fallback;
}
