/**
 * Whether an account can receive privately on a chain. Registration is two
 * transactions: `setAuthPolicy` (spend) and `setViewingKey` (receive). The
 * relayed registration only sends the first, and `setViewingKey` is
 * `msg.sender`-only, so an account can sit in between (`partial`).
 *
 * Only an onchain answer moves a chain to `complete`; a local hint can mark it
 * `partial` but never clear it. Neither key can be unset, so once `complete`
 * a read saying otherwise comes from an RPC that hasn't caught up yet.
 */
import {
  WALLET_FEE_HEADROOM_BPS,
  WALLET_GAS_HEADROOM_BPS,
  planWalletTx,
  walletGasLimit,
  walletMaxFeePerGas,
  type WalletTxFees,
} from '@/services/wallet-tx-fees';

/** `partial`: auth policy set, no viewing key. `incompatible`: registered under a different unlock. */
export type ReceiveSetupState = 'unknown' | 'unregistered' | 'partial' | 'complete' | 'incompatible';

export function receiveSetupFromIdentity(
  status: 'unknown' | 'unregistered' | 'compatible' | 'partial' | 'incompatible',
): ReceiveSetupState {
  switch (status) {
    case 'compatible': return 'complete';
    case 'partial': return 'partial';
    case 'unregistered': return 'unregistered';
    case 'incompatible': return 'incompatible';
    default: return 'unknown';
  }
}

/** Onchain answers win (except a failed or lagging read); a local hint may only set `partial`, never over `complete`. */
export function acceptReceiveSetup(
  previous: ReceiveSetupState | undefined,
  next: ReceiveSetupState,
  source: 'onchain' | 'local',
): boolean {
  if (source === 'onchain') {
    if (previous === 'complete') return next === 'complete' || next === 'incompatible';
    return next !== 'unknown' || previous === undefined;
  }
  return next === 'partial' && previous !== 'complete';
}

// A store rather than a context: the claim hook is mounted above the
// registration modal provider.
type Listener = () => void;

const states = new Map<string, ReceiveSetupState>();
const listeners = new Set<Listener>();
let version = 0;

function storeKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`;
}

export function getReceiveSetup(address: string | null | undefined, chainId: number): ReceiveSetupState {
  if (!address) return 'unknown';
  return states.get(storeKey(address, chainId)) ?? 'unknown';
}

/** `source: 'onchain'` for a keystore read or a confirmed `setViewingKey` receipt. */
export function setReceiveSetup(
  address: string | null | undefined,
  chainId: number,
  next: ReceiveSetupState,
  source: 'onchain' | 'local',
): boolean {
  if (!address) return false;
  const key = storeKey(address, chainId);
  const previous = states.get(key);
  if (!acceptReceiveSetup(previous, next, source)) return false;
  if (previous === next) return true;
  states.set(key, next);
  version += 1;
  listeners.forEach((listener) => listener());
  return true;
}

/**
 * Same address, different keystore identity: a wallet that unlocks with a
 * signature and one that unlocks with a passkey derive different keys, so a
 * cached `complete`/`partial` from one unlock source must not answer for the
 * other. Called whenever the active unlock source changes for `address`.
 */
export function clearReceiveSetupForAddress(address: string | null | undefined): void {
  if (!address) return;
  const prefix = `${address.toLowerCase()}:`;
  let changed = false;
  for (const key of states.keys()) {
    if (key.startsWith(prefix)) {
      states.delete(key);
      changed = true;
    }
  }
  if (changed) {
    version += 1;
    listeners.forEach((listener) => listener());
  }
}

export function partialReceiveChains(address: string | null | undefined): number[] {
  if (!address) return [];
  const prefix = `${address.toLowerCase()}:`;
  const out: number[] = [];
  for (const [key, state] of states) {
    if (state === 'partial' && key.startsWith(prefix)) out.push(Number(key.slice(prefix.length)));
  }
  return out.sort((a, b) => a - b);
}

export function subscribeReceiveSetup(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function receiveSetupVersion(): number {
  return version;
}

/** Test-only reset. */
export function resetReceiveSetupStore(): void {
  states.clear();
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Fallback gas for `setViewingKey` when it cannot be estimated (~51k measured). */
export const VIEWING_KEY_GAS_LIMIT = 80_000n;

export const VIEWING_KEY_GAS_HEADROOM_BPS = WALLET_GAS_HEADROOM_BPS;

/**
 * Kept for callers; the fee policy itself lives in services/wallet-tx-fees.ts.
 */
export const VIEWING_KEY_FEE_HEADROOM_BPS = WALLET_FEE_HEADROOM_BPS;

/** Gas limit `setViewingKey` is sent with: estimate (or budget) + 20%. */
export function viewingKeyGasLimit(gasEstimate?: bigint | null): bigint {
  return walletGasLimit(gasEstimate && gasEstimate > 0n ? gasEstimate : VIEWING_KEY_GAS_LIMIT);
}

/** Max fee per gas `setViewingKey` is sent with. */
export function viewingKeyMaxFeePerGas(gasPriceWei: bigint, chainId?: number | null): bigint {
  return walletMaxFeePerGas(gasPriceWei, chainId);
}

/**
 * What the wallet reserves for `setViewingKey`: the gas limit x the max fee it
 * is SENT with, not a figure the wallet may exceed. Every probe, top-up and
 * pre-check uses this one number.
 */
export function viewingKeyCostWei(input: { gasPriceWei: bigint; gasEstimate?: bigint | null; chainId?: number | null }): bigint {
  // The tip floor is per chain (Ethereum only), same as the send.
  return viewingKeyGasLimit(input.gasEstimate) * viewingKeyMaxFeePerGas(input.gasPriceWei, input.chainId);
}

export type ViewingKeyTxFees = WalletTxFees;

/**
 * The exact gas limit and fee caps `setViewingKey` is SENT with (DEV-554).
 *
 * A wallet refuses a tx unless the balance covers gas limit x max fee, and
 * left to itself (Brave Wallet on iOS) it picks a high fee tier and its own
 * gas limit: "Insufficient balance" for a tx whose real cost is cents, still
 * refused after the user funded the amount the app named. So the app sets the
 * numbers itself, the wallet reserves exactly `costWei`, and the pre-check and
 * the copy use that same figure.
 *
 * Gas: the node's estimate + 20% (fallback budget when it cannot estimate).
 * EIP-1559 chains: tip = max(node suggestion, chain floor), max fee = 2 x
 * base fee + tip (DEV-542: 1.5 x gasPrice was flagged by MetaMask). Legacy chains: the node's gas price as is, so the
 * wallet reserves at most `costWei`.
 */
export function viewingKeyTxPlan(input: {
  gasEstimate?: bigint | null;
  /**
   * `true` when the latest block carries a base fee, `false` when it has none,
   * `null` when the block could not be read: then no fee fields are set and
   * the wallet prices the tx, never a legacy tx guessed onto an EIP-1559 chain.
   */
  eip1559: boolean | null;
  priorityFeeWei?: bigint | null;
  baseFeeWei?: bigint | null;
  minPriorityFeeWei?: bigint | null;
  gasPriceWei: bigint;
}): { gas: bigint; fees: ViewingKeyTxFees | null; costWei: bigint } {
  // The shared wallet fee policy (services/wallet-tx-fees.ts, DEV-542), with
  // this tx's static budget as the fallback so gas and costWei are always set.
  const plan = planWalletTx({ ...input, fallbackGas: VIEWING_KEY_GAS_LIMIT });
  return { gas: plan.gas as bigint, fees: plan.fees, costWei: plan.costWei as bigint };
}

/** Shared by the top-up offer and the publish step so they never disagree. */
export function canAffordViewingKey(input: {
  balanceWei: bigint;
  gasPriceWei: bigint;
  gasEstimate?: bigint | null;
  chainId?: number | null;
}): boolean {
  return input.balanceWei >= viewingKeyCostWei(input);
}

/** Same shape as `decideRegistrationPath`: `relayed-claim` offers the top-up. */
export function decideViewingKeyPath(input: {
  balanceWei: bigint;
  gasPriceWei?: bigint;
  gasEstimate?: bigint | null;
  chainId?: number | null;
}): {
  path: 'self-register' | 'relayed-claim';
  reason: 'zero-balance' | 'insufficient-balance' | 'funded' | 'unknown-gas-price';
  estimatedGasCostWei: bigint;
} {
  if (input.balanceWei <= 0n) return { path: 'relayed-claim', reason: 'zero-balance', estimatedGasCostWei: 0n };
  const gasPriceWei = input.gasPriceWei ?? 0n;
  if (gasPriceWei <= 0n) return { path: 'self-register', reason: 'unknown-gas-price', estimatedGasCostWei: 0n };
  const estimatedGasCostWei = viewingKeyCostWei({ gasPriceWei, gasEstimate: input.gasEstimate, chainId: input.chainId });
  return canAffordViewingKey({ balanceWei: input.balanceWei, gasPriceWei, gasEstimate: input.gasEstimate, chainId: input.chainId })
    ? { path: 'self-register', reason: 'funded', estimatedGasCostWei }
    : { path: 'relayed-claim', reason: 'insufficient-balance', estimatedGasCostWei };
}

// sessionStorage on purpose: "Remind me later" lasts until the next session.
export const FINISH_SETUP_AUTO_OPENED_KEY = 'pp:finish-setup:auto-opened';
export const FINISH_SETUP_FROM_CLAIM_KEY = 'pp:finish-setup:from-claim';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): SessionStorageLike | null {
  try {
    const store = (globalThis as { sessionStorage?: SessionStorageLike }).sessionStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/** Consumes the flag. Unavailable storage errs toward opening. */
export function takeFinishSetupAutoOpen(store: SessionStorageLike | null = sessionStore()): boolean {
  if (!store) return true;
  try {
    const fromClaim = store.getItem(FINISH_SETUP_FROM_CLAIM_KEY) === '1';
    if (fromClaim) store.removeItem(FINISH_SETUP_FROM_CLAIM_KEY);
    const seen = store.getItem(FINISH_SETUP_AUTO_OPENED_KEY) === '1';
    if (!fromClaim && seen) return false;
    store.setItem(FINISH_SETUP_AUTO_OPENED_KEY, '1');
    return true;
  } catch {
    return true;
  }
}

export function markFinishSetupFromClaim(store: SessionStorageLike | null = sessionStore()): void {
  try {
    store?.setItem(FINISH_SETUP_FROM_CLAIM_KEY, '1');
  } catch {
    // Only the immediate open is lost; the once-per-session open still applies.
  }
}

export const PARTIAL_STATE_LABEL = "Can spend, can't receive privately yet";

export const FINISH_SETUP_PRIMARY = 'Finish setup';

export const FINISH_SETUP_BANNER =
  'Finish setting up to receive privately. Payments sent to you right now arrive as one-time links you could lose.';

export const FINISH_SETUP_TITLE = 'Finish setup';

export const FINISH_SETUP_BODY =
  'You can spend on this chain, but senders can’t find you yet, so payments to you arrive as one-time links. '
  + 'One wallet transaction publishes your viewing key and fixes that.';

export const PUBLISH_VIEWING_KEY_TITLE = 'Last step: publish your viewing key';

export const PUBLISH_VIEWING_KEY_PRIMARY = 'Publish viewing key';

export function describePublishViewingKey(input: {
  received: string | null;
  estimate: string | null;
}): string {
  const base = 'Publish your viewing key so people can send to you privately.';
  if (input.received && input.estimate) {
    return `${base} Uses about ${input.estimate} of the ${input.received} you just received.`;
  }
  if (input.received) return `${base} It's paid from the ${input.received} you just received.`;
  if (input.estimate) return `${base} It costs about ${input.estimate} in gas.`;
  return `${base} It's one wallet transaction.`;
}

/** Finish setup, before the wallet prompt: the most this wallet will be charged. */
export function describeFinishSetupGas(input: { estimate: string; chainName: string }): string {
  return `This wallet needs about ${input.estimate} on ${input.chainName} to pay the gas.`;
}

export const CLAIM_ONE_STEP_LEFT = 'Payment claimed · 1 step left';

export const CLAIM_FINISH_SETUP_BODY =
  'You can spend this payment. To receive future payments privately, finish setup. '
  + 'It takes one wallet confirmation, and the gas is already in your wallet.';

export const CLAIM_FINISH_SETUP_BODY_NO_GAS =
  'You can spend this payment. To receive future payments privately, finish setup. '
  + 'It takes one wallet confirmation.';

export const RECEIVE_WARNING =
  "You can't receive privately yet. Payments to this address arrive as one-time links until you finish setup.";

export function joinChainNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * How much gas money the wallet still needs to pay `setViewingKey` itself:
 * the estimated cost at the current gas price, less what it already holds.
 * A relayer gas top-up below this would leave the user paying a fee and still
 * unable to finish setup (review of #130).
 */
export function viewingKeyShortfallWei(input: { gasPriceWei: bigint; balanceWei: bigint; gasEstimate?: bigint | null; chainId?: number | null }): bigint {
  const need = viewingKeyCostWei({ gasPriceWei: input.gasPriceWei, gasEstimate: input.gasEstimate, chainId: input.chainId });
  return need > input.balanceWei ? need - input.balanceWei : 0n;
}

/** A requested top-up is usable only when the relayer quoted one that covers the shortfall. */
export function topUpCovers(gasTopUpWei: bigint | null, shortfallWei: bigint): boolean {
  return gasTopUpWei !== null && gasTopUpWei > 0n && gasTopUpWei >= shortfallWei;
}
