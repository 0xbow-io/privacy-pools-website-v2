/**
 * Which token a flow means when it hands one to the Swap form.
 *
 * Two ways the old symbol-only match got this wrong, both reachable the moment
 * share pools became swap sources (#94, 2026-09-22):
 *
 *  1. CASE. The caller's symbol was uppercased and then compared with `===`
 *     against the token's own symbol. Every share symbol is mixed case, so
 *     'ppUSDC' became 'PPUSDC' and matched nothing:
 *
 *       requestedSymbol = 'ppUSDC'.toUpperCase()          -> 'PPUSDC'
 *       inputs.some((t) => t.symbol === 'PPUSDC')         -> false
 *
 *     The form then reported "Swapping USDC is not available on this network",
 *     which reads as a missing capability rather than a failed lookup. It hit
 *     all three shares and nothing else, on open AND on re-pick, so re-selecting
 *     the token could not clear it.
 *
 *  2. AMBIGUITY. A symbol is no longer a unique key. `displayTokenSymbol`
 *     renders ppETH as "ETH", which is also the legacy plain ETH pool's symbol,
 *     so resolving "ETH" by name can land on the pool the user does NOT hold.
 *
 * So the address decides, and the symbol is only a fallback for callers that
 * have no address to give. Case is ignored on both.
 *
 * PURE, and exported so its test drives the shipped rule rather than a copy of
 * it. services/__tests__/shield-pay-routing.test.ts records that mistake twice.
 */

export interface HandoffToken {
  symbol: string;
  address: string;
}

export interface HandoffRequest {
  tokenAddress?: string | null;
  tokenSymbol?: string | null;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameSymbol = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The token the request names, or undefined when the list does not hold it.
 *
 * Undefined is the ONLY signal for "this asset has no route here". A request
 * naming nothing at all is not a failed lookup, so it resolves to undefined
 * without the caller treating it as a refusal (see `handoffRefused`).
 */
export function resolveHandoffToken<T extends HandoffToken>(
  request: HandoffRequest,
  inputs: readonly T[],
): T | undefined {
  const address = request.tokenAddress?.trim();
  if (address) {
    // An address that names nothing is a DEFINITIVE miss. Falling back to the
    // symbol here would quietly turn "the share at this address" into the
    // legacy pool of the same display name, which is the ambiguity the address
    // exists to resolve. The symbol is a fallback for callers that gave no
    // address, never a second chance for one that did not match.
    return inputs.find((token) => sameAddress(token.address, address));
  }
  const symbol = request.tokenSymbol?.trim();
  if (!symbol) return undefined;
  return inputs.find((token) => sameSymbol(token.symbol, symbol));
}

/**
 * Did the caller ask for something this chain cannot swap?
 *
 * Distinct from "resolved to nothing": a request that names no token is the
 * ordinary open-with-defaults case and must not print a refusal.
 */
export function handoffRefused(request: HandoffRequest, inputs: readonly HandoffToken[]): boolean {
  const named = !!request.tokenAddress?.trim() || !!request.tokenSymbol?.trim();
  return named && resolveHandoffToken(request, inputs) === undefined;
}
