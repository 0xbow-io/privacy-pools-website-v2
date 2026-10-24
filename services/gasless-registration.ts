/**
 * In-app gasless keystore registration — deciding WHETHER it is allowed and
 * WHICH note pays for it.
 *
 * PURE module (no react-native / wagmi / SDK runtime imports) so bun tests and
 * node tooling can import it directly, same contract as
 * services/cold-start-claim.ts.
 *
 * WHY THIS EXISTS. The /import-note claim page already carries a wallet that
 * holds no gas: it signs an EIP-712 `SetAuthPolicy` off-chain and the relayer
 * posts `PrivacyPoolRelay.registerAndRelay`, which runs
 * `Keystore.setAuthPolicyWithSig` and a withdrawal in ONE transaction, taking
 * its fee out of the note. But that page is only reached by opening a transfer
 * link. A payee who created a V3 payment request never sees it: their payer
 * fulfils the request on-chain, the note is auto-discovered by the standard
 * `discoverNotes()` scan, and the payee lands in the app holding a shielded
 * balance they cannot spend — registering the keystore is a transaction, and
 * their wallet has no native currency to pay for it. The header's "Register
 * Keystore" item, and every flow that funnels into
 * components/keystore-registration-modal-provider.tsx, dies with "insufficient
 * funds for gas * price + value".
 *
 * WHY IT MUST STILL SPEND A NOTE. A standalone relayed registration has no fee
 * to pay for it, which is exactly why the relayer defers that endpoint
 * (INTL-05 — the SDK's `submitRelayedRegistration` throws; see
 * services/relayed-registration.ts). The only relayable registration is the
 * bundled `registerAndRelay`, so an in-app registration has to ride along with
 * a withdrawal. We make that withdrawal FEE-ONLY (services/cold-start-claim.ts
 * `planFeeOnlyClaim`): the gross leaving the pool is the relayer's own fee, the
 * payout to the wallet is zero, and the remainder of the note comes back as a
 * change note encrypted to the spender's own viewing key. The user pays the
 * relayer and keeps everything else shielded.
 *
 * THE ELIGIBILITY BAR IS DELIBERATELY HIGH. This path moves a cost the user
 * would normally pay in gas onto money they already hold, so it runs ONLY when
 * all of these hold at once:
 *   1. a wallet-owned session (an account key has no wallet to sign SetAuthPolicy);
 *   2. the keystore is genuinely unregistered on-chain;
 *   3. the wallet cannot pay its own registration gas
 *      (services/cold-start-claim.ts `readRegistrationPath`);
 *   4. the chain's bound relay is a verified `registerAndRelay` deployment
 *      (config/cold-start.ts `supportsColdStartClaim`);
 *   5. the wallet holds spendable notes that cover the relayer's quoted fee
 *      AND leave something behind — a balance the fee would consume whole is
 *      refused rather than silently zeroed.
 * Anything short of all five leaves the user on the existing self-funded path.
 *
 * CHECKED IN TWO STAGES, AND THE SPLIT IS A PRIVACY DECISION. Conditions 1–4
 * are answerable from local state and this app's own RPC. Condition 5 is not:
 * only the relayer can price its own work, and asking it means sending the
 * wallet address, the asset and an EXACT note-group total to a third party —
 * the precise fact a privacy pool exists to keep. So the offer (`selectFee…`
 * plus the local checks) discloses nothing, and the pricing happens only after
 * the user presses Register, which is also when every other surface in this app
 * first contacts the relayer. Condition 5 is therefore enforced BEFORE anything
 * is signed but AFTER the user has asked for it, and the quoted fee is shown to
 * them for confirmation rather than taken on trust.
 */

import { NoteStatus } from '@/services/sdk-types';
import type { Hex, Note } from '@/services/sdk-types';

/**
 * The transact circuit's input ceiling, mirrored from the SDK's `MAX_INPUTS`.
 * The registration rides on ONE transact — `setAuthPolicyWithSig` is one-shot,
 * so there is no second bite — which caps how many notes can fund the fee.
 */
export const GASLESS_REGISTRATION_MAX_INPUTS = 5;

/**
 * How many token groups the probe is willing to price before giving up.
 *
 * Each attempt is a relayer round trip that mints a fee commitment, and a
 * cold-start wallet almost always holds exactly one token. The cap bounds a
 * wallet holding dust in many assets without hiding the common case.
 */
export const GASLESS_REGISTRATION_MAX_CANDIDATES = 3;

/** A same-token set of notes that could fund the registration. */
export type FeeNoteCandidate = {
  /**
   * The asset all these notes are denominated in, VERBATIM.
   *
   * Not normalised, and grouped on the exact string: the SDK's
   * `getTransactOrchestrator.getNotesTokenId` compares input tokenIds with a
   * raw `!==` and throws `All input notes must have the same tokenId`, so a
   * checksummed note and a lowercase note of the same ERC-20 cannot be spent
   * together even though they are the same asset. Keeping them in separate
   * candidates costs nothing — each is tried in turn — and keeps every
   * candidate submittable by construction.
   */
  tokenId: string;
  /** Largest-value first, capped at {@link GASLESS_REGISTRATION_MAX_INPUTS}. */
  notes: Note[];
  /** Sum of `notes`. */
  totalWei: bigint;
};

/**
 * `register`: no auth policy yet; `registerAndRelay` sets it.
 * `top-up`: auth policy set, viewing key not; a fee-only relayed withdrawal
 * whose only purpose is the gas it forwards for `setViewingKey`.
 */
export type GaslessRegistrationMode = 'register' | 'top-up';

/**
 * A priced, confirmable registration: which notes are spent, what the relayer
 * quoted for it, and what stays shielded.
 *
 * Produced only AFTER the user presses Register (see the module docblock), and
 * shown to them before the signature. `quotedFeeWei` is then binding: the
 * submit refuses a final fee above it, so the number the user agreed to is a
 * CEILING, not an estimate they can be talked past.
 */
export type QuotedRegistrationPlan = {
  mode: GaslessRegistrationMode;
  /** Must match at submit: the SDK pins `nativeGas` presence to this flag. */
  extraGas: boolean;
  /** Decoded from the signed commitment; already included in `quotedFeeWei`. */
  gasTopUpWei: bigint | null;
  tokenId: string;
  /** Exactly the notes the transact will spend. */
  notes: Note[];
  /** Sum of `notes` — the value the fee is taken out of. */
  noteValueWei: bigint;
  /**
   * The relayer's fee, priced on the FULL selection — its worst case, since the
   * fee grows with the amount asked for. The submit converges downward from
   * here and may pay less; it may never pay more.
   */
  quotedFeeWei: bigint;
  /**
   * Public payout to the wallet that the fee-only quote carries: 0 without a
   * top-up, the relayer's payout floor plus headroom with one (DEV-482).
   */
  quotedPayoutWei: bigint;
  /** `noteValueWei - quotedFeeWei - quotedPayoutWei`: the floor of what stays shielded. */
  changeWei: bigint;
};

/** Why the gasless path is not on offer, in the caller's words. */
export type GaslessRegistrationBlocker =
  /** Keys are not derived yet, so nothing can be read or signed. */
  | 'session-locked'
  /** Account-key session, or no connected wallet: nobody can sign SetAuthPolicy. */
  | 'not-wallet-session'
  /** The keystore already has an auth policy; there is nothing to register. */
  | 'already-registered'
  /** The wallet can pay its own registration gas — it keeps doing so. */
  | 'wallet-funded'
  /** No verified `registerAndRelay` relay on this chain (config/cold-start.ts). */
  | 'chain-unsupported'
  /**
   * Registering on a chain other than the live session's. The relayer takes its
   * fee out of a note, and the only notes (and the only session to prove with)
   * belong to the chain the wallet is connected to, so a relayed registration
   * aimed elsewhere would spend and register on the wrong chain.
   */
  | 'other-chain'
  /** Nothing spendable to take the fee out of. */
  | 'no-notes'
  /** A read failed, so eligibility is UNKNOWN — fail closed to the funded path. */
  | 'probe-failed';
// Deliberately absent: "the fee exceeds your balance" and "the relayer is
// down". Neither is knowable without pricing, pricing means disclosing the
// balance, and this stage discloses nothing (see the module docblock). Both are
// press-time outcomes, raised as errors by the quoting stage.

export type GaslessRegistrationEligibility =
  /**
   * Everything checkable without contacting the relayer holds, and these are
   * the note groups worth pricing — best first. NOT a promise that the fee
   * fits: that question belongs to the quoting stage.
   */
  | { kind: 'eligible'; mode: GaslessRegistrationMode; candidates: FeeNoteCandidate[] }
  | {
    kind: 'ineligible';
    blocker: GaslessRegistrationBlocker;
    /** Diagnostic detail for the debug log — never user-facing copy. */
    detail?: string;
    /**
     * Whether the wallet can pay its own registration gas: `false` means the
     * user is genuinely stuck and the surface should say so, `true` means
     * today's flow works fine, `null` means we never got far enough to know.
     * Kept separate from `blocker` on purpose — "no notes" reads very
     * differently to a funded wallet than to an empty one.
     */
    walletCanPay: boolean | null;
  };

/** Parse a note's hex value; `null` for anything unparseable. */
function noteValueWei(note: Note): bigint | null {
  try {
    return BigInt(note.value as Hex);
  } catch {
    return null;
  }
}

/** Descending bigint comparator (no subtraction — bigints break `sort`'s number contract). */
function byValueDesc(a: bigint, b: bigint): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

/**
 * Groups spendable notes into candidates the registration fee could come out
 * of, best first.
 *
 * Grouped by exact `tokenId`: a transact proves one asset, and the SDK compares
 * input tokenIds with a raw `!==` (see {@link FeeNoteCandidate.tokenId}).
 *
 * Labels deliberately remain mixed. The circuit and registerAndRelay path
 * support them: the SDK emits one change note per distinct label, so outputs
 * are bounded by distinct labels <= selected inputs <= 5. All transact_NxM
 * artifacts through 5x5 ship with the app. Keeping the retired same-label
 * restriction stranded a wallet whose small lineages covered the fee only in
 * aggregate (for example 60 + 50 against a fee of 100).
 *
 * Within a group the largest notes come first: the relayer's fee is a flat
 * relay cost plus a bps term, so the fewest, biggest notes cover it with the
 * smallest proof and disturb the least of the balance.
 *
 * Groups are ordered by raw total, which is only a heuristic across assets of
 * different decimals (1 USDC is 1e6, 0.001 ETH is 1e15). That is fine: the
 * order decides which candidate gets PRICED first, and every candidate is tried
 * in turn until one fits.
 */
export function selectFeeNoteCandidates(
  notes: readonly Note[],
  options?: { maxInputs?: number; maxCandidates?: number },
): FeeNoteCandidate[] {
  const requestedMaxInputs = options?.maxInputs ?? GASLESS_REGISTRATION_MAX_INPUTS;
  const maxCandidates = options?.maxCandidates ?? GASLESS_REGISTRATION_MAX_CANDIDATES;
  if (requestedMaxInputs <= 0 || maxCandidates <= 0) return [];
  // This option is a test/tuning ceiling, never permission to exceed the
  // shipped transact artifacts. Clamp non-integers as well as values above 5.
  const maxInputs = Math.min(
    GASLESS_REGISTRATION_MAX_INPUTS,
    Math.max(1, Math.trunc(requestedMaxInputs)),
  );

  const groups = new Map<string, {
    tokenId: string;
    entries: { note: Note; valueWei: bigint }[];
  }>();
  for (const note of notes) {
    // ACTIVE only: pending notes are not on-chain yet and spent ones are gone.
    if (note.status !== NoteStatus.ACTIVE) continue;
    // `isOwned === false` marks a note we can see but cannot spend.
    if (note.isOwned === false) continue;
    const valueWei = noteValueWei(note);
    if (valueWei === null || valueWei <= 0n) continue;
    // Exact strings, no normalisation — see the docblock above.
    const key = note.tokenId;
    const group = groups.get(key) ?? { tokenId: note.tokenId, entries: [] };
    group.entries.push({ note, valueWei });
    groups.set(key, group);
  }

  const candidates: FeeNoteCandidate[] = [];
  for (const group of groups.values()) {
    group.entries.sort((a, b) => byValueDesc(a.valueWei, b.valueWei));
    const picked = group.entries.slice(0, maxInputs);
    candidates.push({
      tokenId: group.tokenId,
      notes: picked.map((entry) => entry.note),
      totalWei: picked.reduce((sum, entry) => sum + entry.valueWei, 0n),
    });
  }
  candidates.sort((a, b) => byValueDesc(a.totalWei, b.totalWei));
  return candidates.slice(0, maxCandidates);
}

/**
 * Keep only notes whose label hash belongs to a root-validated association set.
 * The caller supplies the SDK hash operation so this helper stays pure and
 * Bun-testable; malformed labels fail closed, never poisoning a mixed proof.
 */
export function filterFeeNotesByAssociationSet(
  notes: readonly Note[],
  associationSetLeaves: readonly unknown[],
  rejectedLabelHashes: readonly unknown[],
  hashLabel: (label: Note['label']) => unknown,
): Note[] {
  const approved = new Set(associationSetLeaves.map((leaf) => String(leaf).toLowerCase()));
  const rejected = new Set(rejectedLabelHashes.map((leaf) => String(leaf).toLowerCase()));
  return notes.filter((note) => {
    try {
      const labelHash = hashLabel(note.label);
      if (labelHash == null) return false;
      const normalized = String(labelHash).toLowerCase();
      // Rejected first: a revoked label can remain in the append-only leaf set.
      return !rejected.has(normalized) && approved.has(normalized);
    } catch {
      return false;
    }
  });
}

/**
 * Narrows a candidate to the FEWEST largest-first notes whose total strictly
 * exceeds `feeWei`, or `null` when the whole candidate cannot clear it.
 *
 * Sound because the relayer's fee is monotonic non-decreasing in the amount
 * asked for: `feeWei` was quoted against the candidate's full value, so any
 * subset priced at or below that value cannot cost more.
 *
 * STRICTLY greater is the product rule, not an off-by-one: a set that exactly
 * equals the fee would leave a zero change note — the payment consumed whole to
 * register — and that is precisely the case this feature must refuse.
 */
export function narrowFeeNotes(
  candidate: FeeNoteCandidate,
  feeWei: bigint,
): FeeNoteCandidate | null {
  if (feeWei <= 0n) return null;
  const picked: Note[] = [];
  let totalWei = 0n;
  for (const note of candidate.notes) {
    const valueWei = noteValueWei(note);
    if (valueWei === null || valueWei <= 0n) continue;
    picked.push(note);
    totalWei += valueWei;
    if (totalWei > feeWei) {
      return { tokenId: candidate.tokenId, notes: picked, totalWei };
    }
  }
  return null;
}

/**
 * User-facing sentence for a wallet that CANNOT pay its own registration gas
 * and cannot be carried either — the honest dead end, rather than a button that
 * fails inside the wallet.
 *
 * Returns `null` for every blocker that does not strand the user (a funded
 * wallet, a locked session, an account key): those keep the ordinary copy.
 */
export function describeGaslessRegistrationBlocker(
  eligibility: GaslessRegistrationEligibility,
  nativeSymbol: string,
): string | null {
  if (eligibility.kind === 'eligible') return null;
  if (eligibility.walletCanPay !== false) return null;
  switch (eligibility.blocker) {
    case 'no-notes':
      return `This wallet has no ${nativeSymbol} for gas and nothing in its shielded balance to pay a relayer with. Send a little ${nativeSymbol} here, then register.`;
    case 'chain-unsupported':
      return `This wallet has no ${nativeSymbol} for gas, and gasless registration is not available on this network yet. Send a little ${nativeSymbol} here to register.`;
    case 'other-chain':
      return `This wallet has no ${nativeSymbol} for gas on this chain. Registering without gas only works on the chain your wallet is connected to, so switch your wallet to this chain and try again, or send a little ${nativeSymbol} here.`;
    case 'probe-failed':
      return `This wallet has no ${nativeSymbol} for gas. We could not check whether a relayer can register it for you — retry in a moment, or send a little ${nativeSymbol} here.`;
    default:
      return null;
  }
}

/**
 * The warning a registration surface shows a wallet that cannot pay, WHATEVER
 * the caller allows.
 *
 * `describeGaslessRegistrationBlocker` answers only "the relayer cannot carry
 * this wallet either", so it says nothing about an `eligible` wallet — which is
 * right while the gasless button is on offer, and wrong for the callers that
 * turn it off (deposit, ragequit). Those flows need the wallet to pay for a
 * transaction of their own straight after the registration, so a relayer-paid
 * registration would spend part of the shielded balance and still leave the
 * real flow dead. For them an `eligible` wallet is stranded too, and must be
 * told before it is asked to sign.
 */
export function describeUnpayableWallet(
  eligibility: GaslessRegistrationEligibility | null,
  nativeSymbol: string,
  options: { gaslessAllowed: boolean },
): string | null {
  if (!eligibility) return null;
  if (eligibility.kind === 'eligible') {
    if (options.gaslessAllowed) return null;
    return `This wallet has no ${nativeSymbol} for gas, and this step needs the wallet to pay for itself. Send a little ${nativeSymbol} here, then try again.`;
  }
  return describeGaslessRegistrationBlocker(eligibility, nativeSymbol);
}

/**
 * The one line a wallet's "insufficient funds" rejection should turn into.
 *
 * Wallets phrase it differently ("insufficient funds for gas * price + value"
 * from viem, "You do not have enough BNB in your account to pay for network
 * fees" from the wallet UI), and the raw string names neither the chain the
 * user is on nor what to do about it. Returns `null` for anything that is not
 * this failure, so the caller falls through to the underlying message.
 */
export function describeInsufficientGas(
  message: string,
  nativeSymbol: string,
  chainName: string,
): string | null {
  if (!INSUFFICIENT_GAS.test(message)) return null;
  return `You need ${nativeSymbol} on ${chainName} to pay the network fee. Add some, then register again.`;
}

/** The line shown instead of a raw wallet / RPC error dump. */
export const WALLET_SEND_FAILED_MESSAGE = 'Your wallet could not send the transaction. Try again.';

/** Shown when a registration tx was sent but its receipt never came back here. */
export const REGISTRATION_TX_PENDING_MESSAGE = 'Your transaction was sent and may still be pending. Check your wallet before trying again.';

/**
 * True for an error a user should never read verbatim: viem's multi-line dumps
 * ("Request Arguments: ... Details: ... Version: viem@..."), JSON-RPC internal
 * errors, and anything long enough to be one. Our own one-line messages pass.
 */
export function isRawWalletError(message: string): boolean {
  return /Request Arguments:|Details:|Version: viem|internal error|Internal JSON-RPC|RPC error|execution reverted|\n/i.test(message)
    || message.length > 160;
}

/**
 * DEV-566: Keystore_AuthPolicyAlreadySet() (selector 0x70d48a55), by name or
 * by raw selector in a wallet's simulation dump. The auth policy is already on
 * chain, so the caller re-reads and sends only what is missing.
 */
export function isAuthPolicyAlreadySetError(message: string): boolean {
  return /AuthPolicyAlreadySet|0x70d48a55/i.test(message);
}

/**
 * Everything an error chain says, for matching (not for display): wallets put
 * the revert selector in `cause.data` / `data.data`, not always in `message`.
 */
export function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (typeof cur === 'string') { parts.push(cur); break; }
    const e = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; data?: unknown; cause?: unknown };
    for (const v of [e.message, e.shortMessage, e.details]) if (typeof v === 'string') parts.push(v);
    if (typeof e.data === 'string') parts.push(e.data);
    else if (e.data && typeof (e.data as { data?: unknown }).data === 'string') parts.push((e.data as { data: string }).data);
    cur = e.cause;
  }
  return parts.join('\n');
}

export type RegistrationErrorKind =
  | 'rejected'
  | 'pending'
  | 'chain-mismatch'
  | 'reverted'
  | 'insufficient-gas'
  | 'fee-refused'
  | 'network'
  | 'raw'
  | 'plain';

/** The node refused the fee the wallet signed with (DEV-589). */
const FEE_REFUSED = /underpriced|gas price (is )?(too low|below)|fee too low|max ?fee per gas less than block base fee|minimum gas price|intrinsic gas too low/i;
/** The wallet could not reach its node, or the node failed the request. */
const NETWORK_FAILURE = /HTTP request failed|Failed to fetch|fetch failed|network ?error|network request failed|could not connect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|request timed out|rate limit|too many requests|\b(429|502|503|504)\b/i;
const INSUFFICIENT_GAS = /insufficient funds|enough .{0,12} in your account|exceeds the balance|insufficient balance/i;

/**
 * Sorts a registration failure so only a genuine, unknown pre-send failure
 * gets the generic "try again" line. Order matters: a tx that was sent and is
 * unconfirmed is pending whatever the error says, so a retry never duplicates it.
 *
 * `detail` is the whole error chain (`collectErrorText`): wallets put the
 * reason in `cause`/`details`, not always in `message`. It is matched, never shown.
 */
export function classifyRegistrationError(message: string, sentUnconfirmed: boolean, detail = ''): RegistrationErrorKind {
  const text = detail ? `${message}\n${detail}` : message;
  if (/user rejected|user denied|user cancel|rejected by (the )?user|cancell?ed by (the )?user/i.test(text)) return 'rejected';
  if (sentUnconfirmed || /WaitForTransactionReceiptTimeout|Timed out while waiting for transaction/i.test(text)) return 'pending';
  if (/ChainMismatch|current chain of the wallet|does not match the target chain|chain mismatch/i.test(text)) return 'chain-mismatch';
  // Only a receipt-confirmed revert (our own message). A wallet preflight
  // "execution reverted" is a pre-send failure and gets the generic line.
  if (/reverted on-chain/i.test(message)) return 'reverted';
  if (INSUFFICIENT_GAS.test(text)) return 'insufficient-gas';
  if (FEE_REFUSED.test(text)) return 'fee-refused';
  if (NETWORK_FAILURE.test(text)) return 'network';
  return isRawWalletError(message) ? 'raw' : 'plain';
}

/** The one line shown for a registration failure. */
export function describeRegistrationError(
  message: string,
  sentUnconfirmed: boolean,
  chainName: string,
  options?: { detail?: string; nativeSymbol?: string },
): string {
  switch (classifyRegistrationError(message, sentUnconfirmed, options?.detail)) {
    case 'rejected': return 'Transaction cancelled in your wallet.';
    case 'pending': return REGISTRATION_TX_PENDING_MESSAGE;
    case 'chain-mismatch': return `Switch your wallet to ${chainName} and try again.`;
    // Neutral on purpose: one leg may already have landed. A retry re-reads
    // what is registered and sends only what is missing.
    case 'reverted': return 'The registration transaction failed onchain. Try again to finish.';
    case 'insufficient-gas': return `You need ${options?.nativeSymbol ?? 'gas'} on ${chainName} to pay the network fee. Add some, then register again.`;
    case 'fee-refused': return `${chainName} refused the network fee your wallet set. Try again.`;
    case 'network': return `Could not reach ${chainName}. Check your connection and try again.`;
    case 'raw': return WALLET_SEND_FAILED_MESSAGE;
    default: return message;
  }
}

/**
 * Copy for the registration surface once the gasless path is on offer.
 *
 * Self-contained, because it REPLACES the surface's ordinary body rather than
 * sitting beside it: every caller that opens the registration modal describes a
 * transaction the user pays for ("a one-time onchain transaction only costing
 * gas"), and leaving that next to a gasless offer would contradict it. The
 * caller's TITLE and primary label still stand — they carry the context
 * ("Register before you deposit") that this text does not.
 *
 * Deliberately names what it costs. The fee does not come out of "gas" the user
 * never had — it comes out of a payment they are already holding, and they
 * should read that before they sign.
 */
export const GASLESS_REGISTRATION_NOTICE_TITLE = 'No gas needed';

export const GASLESS_REGISTRATION_NOTICE =
  'Registering is a one-time on-chain record that lets you spend what you receive. '
  + 'This wallet holds no gas to pay for it, so a relayer can do it instead — you sign, '
  + 'the relayer pays. Its fee comes out of your shielded balance; the next step shows '
  + 'exactly how much before anything is signed.';

export const GASLESS_REGISTRATION_TOP_UP_NOTE =
  'The relayer also sends a little gas to your wallet, so it can publish your viewing key '
  + 'right after. That one wallet transaction lets people send to you privately.';

export const GASLESS_REGISTRATION_PRIMARY = 'Register without gas';

/** Heading for the priced confirmation shown before the signature. */
export const GASLESS_REGISTRATION_CONFIRM_TITLE = 'What this costs';

/**
 * The confirmation's body. Says the two things the user must be able to act on:
 * the quoted fee is a CEILING (the submit refuses anything higher), and no gas
 * is involved either way.
 */
export const GASLESS_REGISTRATION_CONFIRM_BODY =
  'The relayer registers your wallet on-chain and takes this fee out of your shielded '
  + 'balance. It is the most you can be charged — if the network is cheaper when it '
  + 'lands, you pay less. You still pay no gas, and the remainder stays shielded.';

export const GASLESS_REGISTRATION_CONFIRM_BODY_TOP_UP =
  'The relayer registers your wallet on-chain, sends it a little gas, and takes this fee out '
  + 'of your shielded balance. It is the most you can be charged. Next, your wallet publishes '
  + 'your viewing key with that gas, and the remainder stays shielded.';

export const GASLESS_REGISTRATION_CONFIRM_PRIMARY = 'Confirm and register';

/** DEV-482: warn before signing when the fee takes more than this share. */
export const HIGH_FEE_SHARE_BPS = 2_500n;

/** Row label for the top-up payout floor that leaves the pool to the wallet. */
export const PUBLIC_PAYOUT_LABEL = 'To your wallet, covers the gas top-up';

export const HIGH_FEE_WARNING = 'Fee plus gas money is over 25% of what you are claiming.';

/** True when `feeWei` is more than {@link HIGH_FEE_SHARE_BPS} of `totalWei`. */
export function isHighFeeShare(feeWei: bigint, totalWei: bigint): boolean {
  if (totalWei <= 0n) return feeWei > 0n;
  return feeWei * 10_000n > totalWei * HIGH_FEE_SHARE_BPS;
}

/**
 * Press-time failures. These are NOT probe blockers: answering them requires
 * pricing, and pricing requires disclosing the balance to the relayer, which
 * only happens once the user has asked for the registration.
 *
 * Kept apart on purpose — telling someone their balance is too small when the
 * relayer is merely unreachable sends them to fund a wallet that needed no
 * funding.
 */
export function describeQuoteFailure(
  reason: 'fee-exceeds-balance' | 'relayer-unavailable',
  nativeSymbol: string,
  options?: {
    /** Formatted lowest quoted fee (top-up included): the balance must exceed it. */
    minimum?: string | null;
    withTopUp?: boolean;
    /**
     * The wallet is already registered; this run only sends gas for
     * `setViewingKey` (mode: 'top-up'). Registration did not fail — say so.
     */
    topUpOnly?: boolean;
  },
): string {
  if (reason === 'relayer-unavailable') {
    return options?.topUpOnly
      ? `The relayer that would send this wallet gas can't be reached right now. Nothing was sent — retry in a moment, or send a little ${nativeSymbol} here and finish setup the usual way.`
      : `The relayer that would register this wallet can't be reached right now. Nothing was sent — retry in a moment, or send a little ${nativeSymbol} here and register the usual way.`;
  }
  if (options?.topUpOnly) {
    return options?.minimum
      ? `Needs at least ${options.minimum} shielded to cover the relay fee for the gas top-up. Nothing was sent. Retry when network fees are lower, or send a little ${nativeSymbol} here and finish setup the usual way.`
      : `The relayer's fee for sending gas is currently more than the shielded balance this wallet holds, so it can't finish setup for you. Nothing was sent. Retry when network fees are lower, or send a little ${nativeSymbol} here and finish setup the usual way.`;
  }
  if (options?.minimum) {
    const covers = options.withTopUp
      ? 'the relay fee and gas for the final step'
      : 'the relay fee';
    return `Needs at least ${options.minimum} shielded to cover ${covers}. Nothing was sent. Retry when network fees are lower, or send a little ${nativeSymbol} here and register the usual way.`;
  }
  return `The relayer's fee is currently more than the shielded balance this wallet holds, so it can't register it for you. Nothing was sent. Retry when network fees are lower, or send a little ${nativeSymbol} here and register the usual way.`;
}

export const GASLESS_TOP_UP_NOTICE_TITLE = 'No gas needed';

export const GASLESS_TOP_UP_NOTICE =
  'Publishing your viewing key is one wallet transaction, and this wallet holds no gas to pay for it. '
  + 'A relayer can send a little gas here first. Its fee comes out of your shielded balance; the next '
  + 'step shows exactly how much before anything is sent.';

export const GASLESS_TOP_UP_PRIMARY = 'Get gas and finish';

export const GASLESS_TOP_UP_CONFIRM_PRIMARY = 'Confirm and send gas';

export const GASLESS_TOP_UP_CONFIRM_BODY =
  'The relayer sends a little gas to your wallet and takes this fee out of your shielded balance. '
  + 'It is the most you can be charged. Next, your wallet publishes your viewing key with that gas.';
