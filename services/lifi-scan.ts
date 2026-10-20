/**
 * LI.FI Scan link for a cross-chain leg, so a user waiting out a bridge can see
 * it moving instead of wondering where the funds went.
 *
 * Built from the SOURCE transaction hash, the same id the app already polls
 * LI.FI's status with, so it exists from the first second of the wait (LI.FI's
 * own `bridgeExplorerLink` only arrives once it has indexed the transfer, and it
 * points at the bridge's explorer, not LI.FI's). Opening it is the user's click,
 * like the chain explorer link beside it.
 *
 * PURE: bun tests import it.
 */
export const LIFI_SCAN_TX_BASE = 'https://scan.li.fi/tx/';

export function lifiScanUrl(sourceTxHash: string | null | undefined): string | null {
  const hash = sourceTxHash?.trim() ?? '';
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${LIFI_SCAN_TX_BASE}${hash}` : null;
}
