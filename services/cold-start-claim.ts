/**
 * Cold-start claim routing — "can this wallet pay for its own keystore
 * registration, or must the relayer do it?"
 *
 * PURE module (no react-native / wagmi imports) so it is bun-testable.
 *
 * Registering a keystore is normally a transaction the user signs and pays for.
 * A wallet that just received its first private payment may hold no native
 * currency at all, which makes that transaction impossible — the exact
 * cold-start case. When the chain supports it (config/cold-start.ts) we can
 * instead have the relayer register the wallet and withdraw in one transaction,
 * taking its fee out of the note.
 *
 * Policy (chosen deliberately): the relayed claim is offered ONLY when the
 * wallet cannot cover registration gas. A funded wallet keeps the existing
 * self-registration flow, so the gasless path never silently changes where a
 * user's fee comes from (wallet gas → withdrawn note) when they had the gas
 * anyway.
 */

import type { Hex } from '@/services/sdk-types';

/**
 * Gas budget for a keystore registration (`Keystore.setAuthPolicy`), used to
 * decide affordability BEFORE any transaction exists to estimate against.
 *
 * `eth_estimateGas` is not an option here: the account we are judging may hold
 * zero balance, and clients reject estimation for an account that cannot pay
 * the estimated cost — the very condition we are testing for. So this is a
 * deliberately generous static budget: registration inserts one leaf into a
 * depth-18 incremental Merkle tree plus a couple of SSTOREs, which measures
 * well under this, and over-estimating only means we offer the gasless claim to
 * a wallet that holds a marginal amount of gas.
 */
export const REGISTRATION_GAS_LIMIT = 500_000n;

/**
 * Safety margin on top of `gasLimit × gasPrice`, in basis points. Gas price
 * moves between this check and the wallet actually submitting, and a wallet
 * that is a few percent short would hit an opaque wallet-side failure instead
 * of being offered the gasless path.
 */
export const REGISTRATION_GAS_HEADROOM_BPS = 2_000n;

/** How long a `SetAuthPolicy` signature stays valid, in seconds. */
export const REGISTRATION_DEADLINE_TTL_SECONDS = 900;

export type RegistrationPath =
  /** Today's flow: the user sends (and pays for) the registration transaction. */
  | 'self-register'
  /** Gasless: sign `SetAuthPolicy`, relayer registers + withdraws atomically. */
  | 'relayed-claim';

export type RegistrationPathReason =
  /** The chain has no verified `registerAndRelay` relay — gasless is impossible. */
  | 'unsupported'
  /** The wallet holds nothing; it cannot possibly pay registration gas. */
  | 'zero-balance'
  /** Balance is below the estimated registration cost + headroom. */
  | 'insufficient-balance'
  /**
   * The balance read itself failed, so affordability is UNKNOWN. Distinct from
   * `zero-balance` on purpose: a failed read used to be indistinguishable from
   * a genuinely empty wallet, and defaulting the balance to 0 handed a FUNDED
   * wallet to the relayer — moving a cost the user could have paid themselves
   * onto the note they were claiming.
   */
  | 'balance-unreadable'
  /** Balance covers the estimate — no reason to move the fee onto the note. */
  | 'funded'
  /** Gas price unavailable, balance non-zero: not enough information to switch. */
  | 'unknown-gas-price';

export type RegistrationPathDecision = {
  path: RegistrationPath;
  reason: RegistrationPathReason;
  /** `gasLimit × gasPrice` plus headroom; 0n when the gas price is unknown. */
  estimatedGasCostWei: bigint;
};

/**
 * Decides which registration path an unregistered wallet should take.
 *
 * Callers pass the wallet's native balance and the chain's current gas price;
 * both come from the same public client the withdrawal already uses.
 */
export function decideRegistrationPath(input: {
  /** From `supportsColdStartClaim(chainId, relayAddress)`. */
  supported: boolean;
  balanceWei: bigint;
  /** `undefined`/`0n` when the RPC gas-price read failed. */
  gasPriceWei?: bigint;
  gasLimit?: bigint;
  headroomBps?: bigint;
}): RegistrationPathDecision {
  const { supported, balanceWei } = input;
  if (!supported) {
    return { path: 'self-register', reason: 'unsupported', estimatedGasCostWei: 0n };
  }
  // A wallet holding nothing cannot pay any gas price, so this needs no
  // estimate — and it is the headline cold-start case.
  if (balanceWei <= 0n) {
    return { path: 'relayed-claim', reason: 'zero-balance', estimatedGasCostWei: 0n };
  }
  const gasPriceWei = input.gasPriceWei ?? 0n;
  if (gasPriceWei <= 0n) {
    // Balance is non-zero but we cannot price the transaction. Staying on the
    // existing path is the conservative choice: the user keeps a flow that has
    // always worked, and the wallet itself will report a shortfall.
    return { path: 'self-register', reason: 'unknown-gas-price', estimatedGasCostWei: 0n };
  }
  const gasLimit = input.gasLimit ?? REGISTRATION_GAS_LIMIT;
  const headroomBps = input.headroomBps ?? REGISTRATION_GAS_HEADROOM_BPS;
  const estimatedGasCostWei = (gasLimit * gasPriceWei * (10_000n + headroomBps)) / 10_000n;
  return balanceWei < estimatedGasCostWei
    ? { path: 'relayed-claim', reason: 'insufficient-balance', estimatedGasCostWei }
    : { path: 'self-register', reason: 'funded', estimatedGasCostWei };
}

/**
 * Builds the `deadline` bound into the `SetAuthPolicy` signature: unix
 * SECONDS, 0x-prefixed hex, which is what
 * `IPoolSessionKeystore.buildSetAuthPolicyTypedData` and the relayer's
 * `registration.deadline` both expect.
 *
 * On-chain the keystore rejects a past deadline (`Keystore_SignatureExpired`),
 * and the SDK rejects one up front (`RegistrationDeadlineInPast`). The TTL has
 * to outlive the whole tail of the flow — proof generation (~15s), the relayer
 * round trip, and inclusion — while staying short enough to bound how long the
 * authorization is replayable.
 */
export function buildRegistrationDeadline(
  nowMs: number,
  ttlSeconds: number = REGISTRATION_DEADLINE_TTL_SECONDS,
): Hex {
  const deadlineSeconds = BigInt(Math.floor(nowMs / 1000) + Math.floor(ttlSeconds));
  return `0x${deadlineSeconds.toString(16)}` as Hex;
}

/**
 * Copy for the review screen: what the user gives up / gains by claiming
 * through the relayer instead of registering themselves.
 */
export function describeRelayedClaim(feeLabel: string): string {
  return `No gas needed: the relayer registers this wallet on-chain and pays for the transaction, taking its ${feeLabel} fee out of the amount you withdraw.`;
}

/**
 * How many relayer quotes we are willing to spend finding a FEE-ONLY
 * withdrawal (see {@link planFeeOnlyClaim}), counting the caller's first one.
 *
 * The withdrawal quote (`/v1/quote/.../receive`) prices `amount` as what the
 * RECIPIENT gets: `amountSent = amount + feeAmount`. So a fee-only quote is
 * simply a quote for `amount = 0`. With `extraGas` the relayer refuses a payout
 * below the native gas it forwards ("Native gas cost (N token units) exceeds
 * amount received"), so the search re-asks at that floor plus headroom.
 */
export const FEE_ONLY_CLAIM_QUOTE_ATTEMPTS = 4;

/**
 * Headroom on the relayer's named payout floor, in basis points. The floor is
 * the top-up priced at the gas price of the moment, which moved 13% between
 * two quotes a minute apart on Ethereum (2026-10-14).
 */
export const FEE_ONLY_PAYOUT_FLOOR_HEADROOM_BPS = 2_500n;

/** The two fields of a relayer withdrawal quote this convergence reads. */
export type FeeOnlyQuoteLike = { amountSent: string; feeAmount: string };

/**
 * Reads the minimum payout out of the relayer's extraGas refusal
 * ("Native gas cost (N token units) exceeds amount received (M)"), or null.
 */
export function parsePayoutFloorWei(error: unknown): bigint | null {
  const detail = error instanceof Error ? error.message : String(error);
  const match = /native gas cost \((\d+) token units\) exceeds amount received/i.exec(detail);
  return match ? BigInt(match[1]) : null;
}

/**
 * Finds the FEE-ONLY quote: the smallest payout the relayer accepts, so the fee
 * (plus, with a gas top-up, the relayer's payout floor) is all that leaves the
 * pool and the rest stays shielded.
 *
 * DEV-482: this used to re-quote at `amount = fee`, assuming `amount` was the
 * gross. The relayer reads it as the payout, so every cold-start claim withdrew
 * twice the fee and paid the second half out to the claimer's public wallet.
 *
 * Shared by every cold-start surface (the /import-note claim and the in-app
 * gasless registration). The CALLER owns the first quote and every message.
 *
 * Never sacrifices the quote in hand: a replacement must be accepted, cover its
 * own fee, and send strictly less than the current quote. `tightened: false`
 * with a gross above the fee means no smaller quote was found, which callers
 * treat as a failure (the first quote withdraws the whole note).
 */
export async function convergeFeeOnlyQuote<Q extends FeeOnlyQuoteLike>(input: {
  initialQuote: Q;
  quoteFor: (amountWei: bigint) => Promise<Q>;
  attempts?: number;
  /** Called with a refused re-quote so the caller can log it in its own channel. */
  onRefused?: (error: unknown) => void;
}): Promise<{ quote: Q; tightened: boolean }> {
  const quote = input.initialQuote;
  if (BigInt(quote.amountSent) === BigInt(quote.feeAmount)) return { quote, tightened: false };
  const attempts = input.attempts ?? FEE_ONLY_CLAIM_QUOTE_ATTEMPTS;
  let askWei = 0n;
  for (let attempt = 1; attempt < attempts; attempt++) {
    let next: Q;
    try {
      next = await input.quoteFor(askWei);
    } catch (requoteErr) {
      input.onRefused?.(requoteErr);
      const floorWei = parsePayoutFloorWei(requoteErr);
      if (floorWei === null || floorWei < askWei) break;
      askWei = floorWei + (floorWei * FEE_ONLY_PAYOUT_FLOOR_HEADROOM_BPS) / 10_000n;
      continue;
    }
    const nextGrossWei = BigInt(next.amountSent);
    if (nextGrossWei < BigInt(next.feeAmount) || nextGrossWei >= BigInt(quote.amountSent)) break;
    return { quote: next, tightened: true };
  }
  return { quote, tightened: false };
}

/**
 * Whether a converged fee-only quote can actually be claimed from a note of
 * `noteValueWei`: it must have tightened (or already sit at the fixed point)
 * and its gross, fee plus any top-up payout floor, must leave change behind.
 *
 * DEV-482 review: with `extraGas` the full-value quote can pass while the
 * converged one (fee + 1.25 x floor) exceeds the note. Callers decide the
 * top-up from THIS before any value moves: the registration modal before its
 * cost screen, the claim page after its free off-chain SetAuthPolicy signature
 * but before proving. Either way they fall back to no
 * top-up when it fails.
 */
export function feeOnlyQuoteFits(
  converged: { quote: FeeOnlyQuoteLike; tightened: boolean },
  noteValueWei: bigint,
): boolean {
  const grossWei = BigInt(converged.quote.amountSent);
  const feeWei = BigInt(converged.quote.feeAmount);
  if (!converged.tightened && grossWei !== feeWei) return false;
  return feeWei > 0n && grossWei >= feeWei && grossWei < noteValueWei;
}

/**
 * Whether a relayer quote rejection is an answer about the AMOUNT (the fee
 * outweighs what was asked for) rather than an outage.
 *
 * The distinction decides what the user is told: "the fee is bigger than your
 * balance, add funds" is a lie when the relayer is simply down.
 */
export function isAmountRejection(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /exceeds withdrawal amount|not relayable|below the relay cost/i.test(detail);
}

/**
 * How a fee-only claim splits the note being claimed.
 *
 * `grossWei` is the transact's `amountOut` — the only value that leaves the pool.
 * `payoutWei` is what the payout routing sends to the claimer's own address;
 * `changeWei` is what stays inside as a change note. Because
 * `TransactOrchestrator.buildNotesData` always encrypts a change note to the
 * spender's OWN viewing key (and `NoteDiscoveryService` finds notes by trial
 * decryption with that locally derived key), the change note is recoverable from
 * any device holding the same wallet signature — with no on-chain
 * `setViewingKey`, which has no relayable variant.
 */
export type FeeOnlyClaimPlan = {
  /** `amountSent` — leaves the pool; must be > 0 or the relayer rejects it. */
  grossWei: bigint;
  /** `amountReceived` — paid out to the claimer; 0 at the fixed point. */
  payoutWei: bigint;
  /** Stays shielded as a change note encrypted to the claimer's viewing key. */
  changeWei: bigint;
  /** True when the quote converged and the fee is the ONLY pool outflow. */
  feeOnly: boolean;
};

/**
 * Splits the claimed note against a relayer withdrawal quote so that the fee is
 * (as near as the quote allows) the only value leaving the pool.
 *
 * The client deliberately does NO gas arithmetic: `feeAmountWei` is whatever the
 * relayer quoted, and the plan is derived from it. That is the whole contract of
 * the cold-start route — the relayer prices its own work and takes its cut out
 * of the note, and the user just authorizes it.
 *
 * @throws When the quote cannot fund a claim: a zero fee (the relayer rejects
 *   `amountOut == 0`), a gross below the fee (`PrivacyPoolRelay_FeeExceedsWithdrawal`),
 *   a gross the note cannot cover, or a fee that would consume the whole note.
 */
export function planFeeOnlyClaim(input: {
  noteValueWei: bigint;
  /** The quote's `amountSent`. */
  amountSentWei: bigint;
  /** The quote's `feeAmount`. */
  feeAmountWei: bigint;
}): FeeOnlyClaimPlan {
  const { noteValueWei, amountSentWei, feeAmountWei } = input;
  if (feeAmountWei <= 0n) {
    throw new Error('The relayer quoted no fee, so it cannot be paid out of this payment. Try again in a moment.');
  }
  if (amountSentWei < feeAmountWei) {
    throw new Error('The relayer quote is inconsistent (it sends less than its own fee). Try again in a moment.');
  }
  if (amountSentWei > noteValueWei) {
    throw new Error('The network fee currently exceeds this payment, so it cannot be claimed right now. It stays saved on this device — retry later.');
  }
  const changeWei = noteValueWei - amountSentWei;
  if (changeWei <= 0n) {
    throw new Error('The network fee currently takes all of this payment, so there would be nothing left to claim. It stays saved on this device — retry later.');
  }
  const payoutWei = amountSentWei - feeAmountWei;
  return { grossWei: amountSentWei, payoutWei, changeWei, feeOnly: payoutWei === 0n };
}

/**
 * Reads the wallet's affordability and decides the registration path, with the
 * read failures handled the way {@link decideRegistrationPath} cannot see.
 *
 * Both cold-start surfaces (the claim page's `useNoteImport` and the withdraw
 * modal) need exactly this, and both used to inline it with `balanceWei = 0n` as
 * the initial value — so a transient `eth_getBalance` failure read as "empty
 * wallet" and routed a funded user through the relayer. Here a failed BALANCE
 * read is fail-closed to the self-funded path; a failed GAS-PRICE read is not,
 * because a balance that genuinely read as zero is decisive on its own.
 *
 * Readers are injected so this stays a pure, bun-testable module — no viem, no
 * wagmi. Callers still own the questions this cannot answer: whether the chain's
 * relay implements `registerAndRelay` ({@link supportsColdStartClaim}) and
 * whether the account is already registered.
 */
export async function readRegistrationPath(
  readers: {
    getBalanceWei: () => Promise<bigint>;
    getGasPriceWei: () => Promise<bigint>;
  },
  options?: {
    supported?: boolean;
    gasLimit?: bigint;
    headroomBps?: bigint;
    /** Called with any read failure so the caller can log it in its own channel. */
    onReadError?: (scope: 'balance' | 'gas-price', error: unknown) => void;
  },
): Promise<RegistrationPathDecision & { balanceWei: bigint; gasPriceWei?: bigint }> {
  // Issued together: they are independent reads on the same client, and this
  // runs on a screen the user is waiting on.
  const [balance, gasPrice] = await Promise.allSettled([
    readers.getBalanceWei(),
    readers.getGasPriceWei(),
  ]);
  if (balance.status === 'rejected') {
    options?.onReadError?.('balance', balance.reason);
    return {
      path: 'self-register',
      reason: 'balance-unreadable',
      estimatedGasCostWei: 0n,
      balanceWei: 0n,
      gasPriceWei: undefined,
    };
  }
  const balanceWei = balance.value;
  let gasPriceWei: bigint | undefined;
  if (gasPrice.status === 'rejected') {
    // Not fatal: decideRegistrationPath treats a missing gas price as "not
    // enough information to switch" unless the balance is zero.
    options?.onReadError?.('gas-price', gasPrice.reason);
  } else {
    gasPriceWei = gasPrice.value;
  }
  const decision = decideRegistrationPath({
    supported: options?.supported ?? true,
    balanceWei,
    gasPriceWei,
    gasLimit: options?.gasLimit,
    headroomBps: options?.headroomBps,
  });
  return { ...decision, balanceWei, gasPriceWei };
}
