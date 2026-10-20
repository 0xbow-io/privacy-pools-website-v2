// The Swap tab's recipient row (DEV-510). grep [swap-deposit-recipient].
//
// A private swap can pay someone else: reshield-and-transfer (v2-monorepo #439,
// same chain) and its cross-chain twin deliver the swapped output as a SHIELDED
// note owned by the recipient. Same machinery as the Send tab's private
// swap-send (transfer-modal-provider.tsx privateSwapSend). The output is always
// a note; there is no "to my wallet" here, that is Withdraw.
//
// Pure, so the route decision is tested against the real config lists.
import { isConfiguredShareTarget, conversionDepositTarget } from '@/config/intent-targets';
import { crossChainReshieldSupported, getSwapOutputTokens } from '@/config/intent-swaps';

export type SwapTabRecipientRoute =
  /** No recipient, or your own account: the plain reshield. */
  | { kind: 'self' }
  /** Something typed that is not an address. Holds Review. */
  | { kind: 'invalid' }
  /** A third party the private route can serve, with the output it delivers. */
  | { kind: 'reshield-transfer'; recipient: string; outputTokenAddress: string }
  /** A third party this output cannot reach privately. */
  | { kind: 'refused'; reason: string };

export const SWAP_TAB_RECIPIENT_REFUSED = 'This asset can’t be sent privately to someone else. Pick a pool share, or use Withdraw.';

const ADDRESS_RE =/^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x0000000000000000000000000000000000000000';

export function swapTabRecipientRoute(input: {
  poolChainId: number;
  destinationChainId: number;
  /** The output as picked (a plain coin is mapped to its pool share below). */
  outputTokenAddress: string | null | undefined;
  outputIsNative?: boolean;
  recipient: string | null | undefined;
  /** The connected wallet and session address: paying these is the plain reshield. */
  ownAddresses: (string | null | undefined)[];
}): SwapTabRecipientRoute {
  const typed = (input.recipient ?? '').trim();
  if (!typed) return { kind: 'self' };
  if (!ADDRESS_RE.test(typed) || typed.toLowerCase() === ZERO) return { kind: 'invalid' };
  const own = input.ownAddresses.filter((a): a is string => !!a).map((a) => a.toLowerCase());
  if (own.includes(typed.toLowerCase())) return { kind: 'self' };
  if (!input.outputTokenAddress) return { kind: 'refused', reason: SWAP_TAB_RECIPIENT_REFUSED };
  const crossChain = input.destinationChainId !== input.poolChainId;
  // Map a plain pick to the share the destination wraps it in BEFORE checking:
  // comparing the plain address refused every such pick (Mike, #219 QA).
  const target = conversionDepositTarget(input.outputTokenAddress, input.destinationChainId, !!input.outputIsNative).toLowerCase();
  if (crossChain && !(crossChainReshieldSupported(input.poolChainId, input.destinationChainId)
    && isConfiguredShareTarget(target, input.destinationChainId))) {
    return { kind: 'refused', reason: SWAP_TAB_RECIPIENT_REFUSED };
  }
  const listed = getSwapOutputTokens(input.destinationChainId, input.poolChainId)
    .find((t) => t.address.toLowerCase() === target);
  if (!listed) return { kind: 'refused', reason: SWAP_TAB_RECIPIENT_REFUSED };
  return { kind: 'reshield-transfer', recipient: typed, outputTokenAddress: listed.address };
}
