import { getTransferProcessorAddress, getWithdrawalProcessorAddress } from '@/config/relayer';
import { getPinnedYieldRouters } from '@/config/yield';
import { isSwapRouteCaller } from '@/config/intent-swaps';

/**
 * Was a Transacted log with this caller submitted on a WITHDRAWAL route: the
 * chain's relay contract, a yield router, or a swap route? Each of those pays
 * the withdrawn value out to a recipient, so the log is a withdrawal whatever
 * its output count (a mixed-label withdrawal leaves one change note per label,
 * which the feed's arity heuristic reads as a transfer).
 *
 * The relay contract counts only while the chain's transfer processor is a
 * different address: when they are the same, the relayer sends transfers
 * through it too, and that caller cannot tell the routes apart.
 */
export function isWithdrawalRouteCaller(caller: unknown, chainId: number | undefined): boolean {
  // Snapshot data is not validated per field, and this runs during render.
  if (typeof caller !== 'string' || chainId === undefined) return false;
  const relay = getWithdrawalProcessorAddress(chainId).toLowerCase();
  const c = caller.toLowerCase();
  if (c === relay) return getTransferProcessorAddress(chainId).toLowerCase() !== relay;
  if (getPinnedYieldRouters(chainId).includes(c)) return true;
  return isSwapRouteCaller(c, chainId);
}
