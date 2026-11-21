/**
 * A relayed spend proved against an association-set root the pool no longer
 * accepts (PoolVault_InvalidASPRoot, selector 0xbc158616).
 *
 * The pool requires the proof's associationSetRoot to EQUAL the registry's
 * latestASPRoot, which keeps no history. When the ASP publishes a new root
 * between the proof and inclusion, the relayed transaction reverts. Nothing is
 * spent (a reverted transact consumes no nullifier), and a proof against the
 * new root goes through.
 *
 * It shows up two ways:
 *  - the relayer's simulation refuses it before broadcasting: a RelayerRejected
 *    whose message names the error or carries its selector;
 *  - it is broadcast and mines reverted: the relayed receipt wait
 *    (services/relayed-receipt.ts) reports status false from bulk data. It
 *    cannot carry a revert reason: reading one would mean asking the RPC about
 *    the relayed hash, which the privacy rules forbid. The cause is inferred
 *    instead: the proof's own associationSetRoot against the root the feed
 *    grid holds. If the grid has moved past the proof's root, the revert is the
 *    stale root. That compares data the client already holds or that the grid
 *    fetches on its own clock, so the check sends nothing.
 *
 * PURE module: no SDK runtime, no react-native, so bun tests pin it directly.
 */

/** 4-byte selector of `error PoolVault_InvalidASPRoot()`. */
export const POOL_VAULT_INVALID_ASP_ROOT_SELECTOR = '0xbc158616';

const INVALID_ASP_ROOT = /InvalidASPRoot|0xbc158616/i;

/** The text names the pool's stale-root error, by name or by selector. */
export function mentionsInvalidAspRoot(text: string): boolean {
  return INVALID_ASP_ROOT.test(text);
}

/** Shown when a fresh proof still met a moved root. One sentence, no jargon. */
export const STALE_ASP_ROOT_MESSAGE = 'The approved set just updated. Nothing was spent, please try again.';

/** Shown for a relayed withdrawal that reverted for any other reason. */
export const RELAYED_REVERT_MESSAGE = 'The withdrawal did not go through. Nothing was spent, please try again.';

/** Status line while the withdrawal is proven again against the new set. */
export const STALE_ASP_ROOT_RETRY_STATUS = 'The approved set just updated. Proving again...';

/** Status line while the client waits to learn why a relayed withdrawal reverted. */
export const RELAYED_REVERT_CHECK_STATUS = 'Nothing was spent. Checking for an update...';

/**
 * The relayed transaction mined and reverted. Its notes were not spent.
 * `proofRoot` is the associationSetRoot the proof was built against, when the
 * relay request was heard (see proofAssociationSetRoot).
 */
export class RelayedRevertError extends Error {
  constructor(readonly proofRoot: bigint | null, readonly txHash: string | null = null) {
    super(RELAYED_REVERT_MESSAGE);
    this.name = 'RelayedRevertError';
  }
}

/** A fresh proof met a moved root again. Nothing was spent. */
export class StaleAspRootError extends Error {
  constructor(cause?: unknown) {
    super(STALE_ASP_ROOT_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = 'StaleAspRootError';
  }
}

/** One of the two outcomes above: its message is the user-facing copy as is. */
export function isPlainRelayRevert(error: unknown): boolean {
  return error instanceof Error && (error.name === 'RelayedRevertError' || error.name === 'StaleAspRootError');
}

function toBig(value: unknown): bigint | null {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'string' && value.trim() !== '') return BigInt(value.trim());
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  } catch { /* not a field element */ }
  return null;
}

/**
 * The associationSetRoot a relay request's proof was built against, or null
 * when the request does not have the transact shape.
 *
 * The transact circuit's public signals are laid out as [nullifiers (n),
 * output commitments (m), stateRoot, keystoreRoot, associationSetRoot,
 * amountOut, tokenIdOut, context] (the SDK's restructureTransactPubSignals),
 * and the relay request carries n and m as inputNullifierNumber and
 * outputCommitmentNumber next to the proof.
 */
export function proofAssociationSetRoot(params: unknown): bigint | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as { proof?: { publicSignals?: unknown }; inputNullifierNumber?: unknown; outputCommitmentNumber?: unknown };
  const signals = p.proof?.publicSignals;
  const n = Number(p.inputNullifierNumber);
  const m = Number(p.outputCommitmentNumber);
  if (!Array.isArray(signals) || !Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 0) return null;
  const index = n + m + 2;
  if (signals.length < n + m + 6) return null;
  return toBig(signals[index]);
}

export type RootWatch = {
  /** The root the grid holds now, or null. Never a request. */
  held: () => string | null;
  /** The root after the grid's next refresh, or null at the deadline. Never a request. */
  next: (timeoutMs?: number) => Promise<string | null>;
};

/**
 * Whether the association set has moved past `proofRoot`: the held root
 * already differs, or (with `wait`) the grid's next refresh brings a different
 * one. Unknown (no proof root, nothing held, the wait ran out) is false: only a
 * root seen to move is a stale-root revert.
 */
export async function associationSetMovedPast(
  proofRoot: bigint | null,
  watch: RootWatch,
  opts: { wait: boolean; timeoutMs?: number },
): Promise<boolean> {
  if (proofRoot === null) return false;
  const differs = (root: string | null) => {
    const value = toBig(root);
    return value !== null && value !== proofRoot;
  };
  if (differs(watch.held())) return true;
  if (!opts.wait) return false;
  return differs(await watch.next(opts.timeoutMs));
}
