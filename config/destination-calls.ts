// Can a bridge run a contract call on this chain when it lands there? The
// relayer publishes it per chain as `destinationCallsSupported` on
// `GET /v1/details/evm/{id}` (v2-monorepo#486): true where the LI.FI receiver
// contracts exist. A cross-chain swap that ENDS in a deposit (reshield,
// reshield-and-send, swap-and-deposit from another chain) needs that call, and
// the SDK refuses such a destination with DestinationCallsUnsupported before
// any quote. Paying out to a plain wallet needs no call and is unaffected.
//
// Two sources, the relayer's explicit answer first:
//  1. what services/relayer-details.ts last read for the chain (recorded here
//     by that fetch, never requested from here, so nothing in the UI causes a
//     request);
//  2. a static fallback for the chains known to lack the receivers, so the UI
//     is right before the relayer or the SDK ships the field.
// Anything else is allowed, like the SDK (absent = allowed).
//
// The relayer's answer is only known for a chain once something already read
// that chain's details (a swap's processor check). There is deliberately no
// sweep of every chain: until a chain was read, THIS TABLE is the source, so a
// chain the relayer turns off must be added here too. The SDK still refuses it
// with DestinationCallsUnsupported before any quote, so a miss here is a
// refused flow, never a stuck bridge.
//
// No imports on purpose: config/intent-swaps reads this, and its import graph
// is load-order sensitive.

/** Chains known to have no LI.FI receiver contracts yet (Citrea, Robinhood). */
export const DESTINATION_CALLS_FALLBACK: Readonly<Record<number, boolean>> = {
  4114: false,
  4663: false,
};

const relayerAnswers = new Map<number, boolean>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

/** useSyncExternalStore subscribe: fires whenever a recorded answer changes. */
export function subscribeDestinationCalls(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** useSyncExternalStore snapshot: changes whenever a recorded answer does. */
export function destinationCallsVersion(): number {
  return version;
}

/** Record the relayer's answer for a chain; undefined forgets it (field absent). */
export function recordRelayerDestinationCalls(chainId: number, value: boolean | undefined): void {
  const before = relayerAnswers.get(chainId);
  if (typeof value === 'boolean') relayerAnswers.set(chainId, value);
  else relayerAnswers.delete(chainId);
  if (relayerAnswers.get(chainId) !== before) bump();
}

/** Pure given the recorded answers: false only on an explicit no. */
export function destinationCallsSupported(chainId: number): boolean {
  const relayer = relayerAnswers.get(chainId);
  if (relayer !== undefined) return relayer;
  return DESTINATION_CALLS_FALLBACK[chainId] ?? true;
}

/**
 * Pure: a reshield's selected destination stays only while the gate still
 * approves it. When the relayer's answer withdraws it, the selection goes back
 * to the source chain (where every reshield can land) rather than quietly
 * running a same-chain estimate under a cross-chain label.
 */
export function reshieldDestinationStillValid(isReshield: boolean, source: number, selected: number, gateApproves: boolean): boolean {
  return !isReshield || selected === source || gateApproves;
}

/** Tests only. */
export function resetRelayerDestinationCallsForTests(): void {
  relayerAnswers.clear();
  bump();
}
