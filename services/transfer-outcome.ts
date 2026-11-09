import { approxUnderlyingText } from '@/services/share-display';
import { formatShortfallAmount } from '@/services/relayed-payment-shortfall';
// How a failed transfer attempt is classified, and why it matters.
//
// A transfer that fails has three possible standings, and only one of them is
// "we do not know". Getting this wrong is a money bug in both directions: call
// an unknown outcome a failure and the recipient's only recovery material is
// thrown away; call a known failure "unknown" and the sender is handed a
// one-time receipt, framed as unrecoverable, for a transfer that never
// happened — its link cannot claim anything, and further sends stay latched
// behind a receipt that protects nothing.
//
// This has now been got wrong twice, in both directions, which is why the
// predicates live here with tests rather than inline in the modal:
//   - 2026-08-17 (QA): a pre-broadcast SDK validation throw showed a success
//     screen with a dead base receipt.
//   - 2026-08-20 (Artem, OP mainnet): the relayer answered 400 with its own
//     eth_call revert (PoolVault_ProofContextMismatch) and the run was treated
//     as unknown, offering a receipt whose link was useless.

/** The sender provably never handed the transfer over, or withdrew it. */
export function isKnownRejection(message: string): boolean {
  return /Superseded|User rejected|User denied|User cancelled|Insufficient value for transact|exceeds your available balance|balance isn't high enough|picked for this payment can't cover it|FeeCommitmentExpired|Fee commitment expired|relayer quote ran out before|does not match transfer tokenId|prepared transfer does not match what was reviewed|refused the proof and a fresh quote failed/i
    .test(message);
}

/** A transaction DID land and then reverted. Our own wording for that case. */
export function isConfirmedRevert(message: string): boolean {
  return message.includes('reverted on-chain');
}

/**
 * The relayer refused to submit: it simulates first and answers 400 with the
 * revert it hit, e.g.
 *   PoolVault transact failed: The contract function "transact" reverted.
 *   (PoolVault_ProofContextMismatch).
 *
 * Nothing was broadcast and no note was spent. `broadcastAttempted` cannot tell
 * this apart, because it is set immediately before the relay call, so a refusal
 * at the far end still looks like a handover — the message is the only signal.
 */
export function isRelayerRefusal(message: string): boolean {
  if (isConfirmedRevert(message)) return false;
  return /PoolVault transact failed|The contract function .?transact.? reverted|PoolVault_[A-Za-z]+/i
    .test(message);
}

/**
 * The relayer could not be REACHED to price the transfer — a quote failure, not
 * a refusal. The SDK reports it as e.g.
 *   All configured relayers failed to quote: 0xbow Relayer: Failed to fetch
 *
 * Distinct from isRelayerRefusal, where the relayer answered and declined. This
 * one means an outage in an optional dependency, and reporting it as "Transfer
 * failed" tells the user their transfer broke when in fact nothing was
 * attempted (DEV-370). (The "Hide my wallet" escape hatch that let a send skip
 * the relayer was removed 2026-08-29; every send is relayed.)
 */
/**
 * Names the relayer in a TRANSPORT failure raised while fetching a relayer
 * quote, so `isRelayerUnreachable` (and the named outage copy behind it)
 * engages. The browser's own fetch errors ("Failed to fetch", Safari's "Load
 * failed", React Native's "Network request failed") never mention the relayer,
 * and Withdraw showed them raw as "Failed to get fee quote: Failed to fetch"
 * (Pack L-a, 2026-08-27). Only for use where the failing call IS the relayer
 * quote: an RPC "network error" elsewhere must not be blamed on the relayer,
 * which is why the classifier itself stays narrow.
 */
export function nameRelayerTransportFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isRelayerUnreachable(message) || isRelayerRefusal(message) || isConfirmedRevert(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  if (/failed to fetch|load failed|network ?error|network request failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|timed? ?out/i.test(message)) {
    return new Error(`Relayer quote failed to fetch: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * The relayer ANSWERED and declined because its own signer cannot pay for the
 * relay: the node rejected the send for want of native balance. HTTP 400 with
 * "Relay failed: The total cost (gas * gas fee + value) of executing this
 * transaction exceeds the balance of the account" (BNB mainnet, QA I-d,
 * DEV-400). Nothing left the pool and no proof was consumed: the relayer
 * never broadcast. It is an outage in the relayer, not a failure of the
 * user's withdrawal, and must be named as one rather than shown as a raw
 * JSON blob with a status code.
 */
export function isRelayerOutOfGas(message: string): boolean {
  if (isConfirmedRevert(message)) return false;
  // The relayer's own 503 since DEV-400, any flow: "Relayer temporarily
  // unavailable on chain 1: the relayer's wallet cannot cover gas for RelaySwaps."
  if (/relayer's wallet cannot cover gas/i.test(message)) return true;
  // Only the relayer's OWN wrapped node error. A bare "insufficient funds for
  // gas" is the user's wallet refusing to pay for its own transaction, and a
  // simulated revert that happens to mention a balance is a refusal
  // (isRelayerRefusal), not gas exhaustion. Both must keep their own wording.
  if (!/Relay failed:/i.test(message)) return false;
  return /exceeds the balance of the account|insufficient funds for gas \* price \+ value/i.test(message);
}

/** The user-facing sentence for isRelayerOutOfGas, with the flow named. */
export function relayerOutOfGasMessage(flow: 'withdrawal' | 'transfer' | 'swap'): string {
  return `The relayer cannot pay for gas on this network right now, so this ${flow} was not sent and your balance is unchanged. This is on the relayer's side; try again later.`;
}

/**
 * The relayer answered HTTP 429: it is throttling this client. The SDK
 * flattens it into text ("All configured relayers failed to quote: Fast
 * Relay: HTTP 429: {...ThrottlerException: Too Many Requests}"), which
 * isRelayerUnreachable also matches, so check this first or a busy relayer
 * reads as a down one (Mike, 2026-10-01).
 */
export function isRelayerRateLimited(message: string): boolean {
  return /\bHTTP 429\b/.test(message);
}

/** The user-facing sentence for isRelayerRateLimited, with the flow named. */
export function relayerRateLimitedMessage(flow: 'withdrawal' | 'transfer' | 'swap'): string {
  return `The relayer is rate limiting requests right now, so this ${flow} was not sent and your balance is unchanged. Wait a minute and try again.`;
}

export function isRelayerUnreachable(message: string): boolean {
  if (isConfirmedRevert(message)) return false;
  return /failed to quote|relayers failed|relayer.{0,40}failed to fetch/i.test(message);
}

/**
 * True when the outcome is genuinely unknown, i.e. the one case where a
 * one-time receipt must be preserved and shown.
 */
export function isIndeterminateOutcome(
  message: string,
  broadcastAttempted: boolean,
): boolean {
  if (!broadcastAttempted) return false;
  return !isKnownRejection(message) && !isConfirmedRevert(message) && !isRelayerRefusal(message);
}

/**
 * Raw SDK throws must never reach a user. InsufficientTransactValue is the
 * worst offender: the SDK formats its operands with bigintToHex (32-byte
 * left-padded), so the message reads
 *   Insufficient value for transact: available=0x4c4b40, requested=0x00...004ca226
 * and the payment-request toast printed it verbatim (QA 2026-08-27). Both
 * operands are token base units, so with the token's decimals they render, and
 * the DIFFERENCE is the only number the user can act on.
 *
 * This is the LAST line of defence, not the first: the guards in the pay flow
 * should make it unreachable. It exists because "never" is only true if
 * something enforces it when a fee drifts up between the guard and the
 * relayer's re-prove.
 *
 * Returns null when the message is not one it maps, so callers keep their own
 * copy for everything else.
 */
export function translateSdkTransactError(
  message: string,
  token: { symbol: string; decimals: number },
): string | null {
  const insufficient =
    /Insufficient value for transact:\s*available=(0x[0-9a-fA-F]+),\s*requested=(0x[0-9a-fA-F]+)/.exec(message);
  if (insufficient) {
    let available: bigint;
    let requested: bigint;
    try {
      available = BigInt(insufficient[1]);
      requested = BigInt(insufficient[2]);
    } catch {
      return null;
    }
    const short = requested > available ? requested - available : 0n;
    // A share figure reads as its coin, approximately (services/share-display.ts).
    // Costs round up, what the notes hold rounds down (Mike, #282).
    const f = (v: bigint, up: boolean) =>
      approxUnderlyingText(`${formatShortfallAmount(v, token.decimals, up, token.symbol)} ${token.symbol}`, token.symbol);
    return `Your balance isn't high enough. This payment needs ${f(requested, true)}. The notes selected for it hold ${f(available, false)}. You are ${f(short, true)} short. Nothing was sent and no notes were spent.`;
  }
  if (/Too few noteAddressHashes/i.test(message)) {
    return 'This payment would have to draw on more than one of your deposits, and this request can only be paid from one. Pay it from a single deposit large enough to cover the amount plus the relayer fee, or ask the sender for a new request.';
  }
  return null;
}

/**
 * viem's WaitForTransactionReceiptTimeoutError after a relay: the relayer DID
 * broadcast (the hash is in the message), the client merely stopped waiting.
 * Returns that hash so the caller confirms from bulk chain data instead of
 * calling the withdrawal failed (Matthew, QA 2026-08-31: a mainnet USDC
 * withdrawal completed and still read "Withdrawal Failed").
 */
export function timedOutRelayTxHash(message: string | null | undefined): `0x${string}` | null {
  if (!message) return null;
  const m = /Timed out while waiting for transaction with hash\s*"?(0x[0-9a-fA-F]{64})"?/i.exec(message);
  return m ? (m[1] as `0x${string}`) : null;
}

/**
 * The receipt wait ran out on a transaction the relayer DID broadcast. Not a
 * failure: a relay with a low tip can sit in the mempool for minutes and then
 * land (DEV-458). The flow keeps it as pending until the notes are seen spent.
 */
export function isRelayWaitTimeout(message: string | null | undefined): boolean {
  if (!message) return false;
  return /Relayed transaction was not observed in any block within the wait budget|Timed out while waiting for transaction/i.test(message);
}

/**
 * The relayer refused because a transaction spending one of these notes is
 * still pending on its side ("Nullifier 0x… is already in-flight"). A known
 * non-send for THIS attempt; the earlier one may still land.
 *
 * Requires the message to actually name a nullifier: matching "already
 * in-flight" alone also caught unrelated relay/quote errors that happened to
 * share that phrase, and replaced their real text with this one.
 */
export function isRelayerNullifierInFlight(message: string): boolean {
  return /nullifier.{0,80}already in-flight/i.test(message);
}

/** The user-facing sentence for a relay refused because the same funds are already in flight. */
export function relayInFlightMessage(flow: 'withdrawal' | 'transfer' | 'swap'): string {
  return `An earlier transaction using these funds is still pending, so this ${flow} was not sent and nothing was spent. It can still land: wait for your balance to update before trying again.`;
}
